// The method page: what the method is, and the console that calls it.
import { SCHEME_LABEL, isPlaintext, toAuth } from "../lib/environments";
import { type HistoryEntry, entry, keptBody, list, record } from "../lib/history";
import { MAX_FRAMES, type Outcome, outcomeLabel, send } from "../lib/send";
import type { Frame, MethodDoc, RequestSpec, RpcError, ServiceDoc, Transport } from "../lib/types";
import type { Context } from "./context";
import { badge, bytes, clip, h, pretty, prose, replace } from "./dom";
import { fieldsTable, link, methodBadges, short } from "./pages";

export interface Page {
  elements: HTMLElement[];
  /** Stop what the page started: a call in flight, a subscription. */
  dispose(): void;
}

interface Choice {
  label: string;
  transport: Transport;
  binding: number;
}

function choices(method: MethodDoc): Choice[] {
  const out: Choice[] = [];
  for (const transport of method.transports) {
    if (transport === "connect-json") out.push({ label: "Connect · JSON over POST", transport, binding: 0 });
    if (transport === "connect-proto") out.push({ label: "Connect · binary over POST", transport, binding: 0 });
    if (transport === "connect-get") out.push({ label: "Connect · GET", transport, binding: 0 });
    if (transport === "rest") {
      method.http.forEach((binding, i) =>
        out.push({ label: `REST · ${binding.verb} ${binding.path}`, transport, binding: i }),
      );
    }
  }
  return out;
}

function errorBox(error: RpcError): HTMLElement {
  return h(
    "div",
    { class: "error" },
    h("p", null, h("strong", null, error.code), error.message !== "" && `: ${error.message}`),
    error.details.map((detail) =>
      h(
        "details",
        { open: true },
        h("summary", null, "Detail: ", h("code", null, detail.type === "" ? "unknown type" : detail.type)),
        h(
          "pre",
          { tabindex: "0" },
          h("code", null, detail.value === null ? "This schema cannot decode it." : pretty(detail.value)),
        ),
      ),
    ),
  );
}

function frameItem(frame: Frame): HTMLElement {
  if (frame.kind === "message")
    return h("li", null, h("pre", { tabindex: "0" }, h("code", null, clip(pretty(frame.message)))));
  if (frame.kind === "invalid") return h("li", { class: "error" }, `A frame could not be read: ${frame.reason}`);
  const metadata = Object.keys(frame.metadata).length > 0;
  return h(
    "li",
    { class: "end" },
    frame.error ? errorBox(frame.error) : h("p", null, "End of the stream."),
    metadata && h("pre", { tabindex: "0", "aria-label": "Trailing metadata" }, h("code", null, pretty(frame.metadata))),
  );
}

function time(ms: number): string {
  return new Date(ms).toLocaleString();
}

export function methodPage(context: Context, service: ServiceDoc, method: MethodDoc): Page {
  const { core } = context;
  const input = core.index.messages.find((message) => message.name === method.input);
  const output = core.index.messages.find((message) => message.name === method.output);
  const options = choices(method);
  let controller: AbortController | undefined;

  const header: HTMLElement[] = [
    h("p", { class: "kind" }, "Method of ", link(service.name)),
    h("h1", null, method.name, " ", methodBadges(method)),
    h(
      "p",
      { class: "signature" },
      h("code", null, `${service.name}/${method.name}`),
      h("br"),
      method.clientStreaming && "stream ",
      link(method.input, short(method.input)),
      " → ",
      method.serverStreaming && "stream ",
      link(method.output, short(method.output)),
    ),
    ...method.http.map((binding) =>
      h(
        "p",
        { class: "rest" },
        h("code", null, `${binding.verb} ${binding.path}`),
        binding.body !== "" && ` (body: ${binding.body})`,
      ),
    ),
    prose(method.doc, "No description."),
  ];
  const reference: HTMLElement[] = [
    h("h2", null, "Request and response"),
    h(
      "details",
      null,
      h("summary", null, "Fields of the request, ", h("code", null, short(method.input))),
      input ? fieldsTable(input, `Fields of ${short(method.input)}`) : null,
    ),
    h(
      "details",
      null,
      h("summary", null, "Fields of the response, ", h("code", null, short(method.output))),
      output ? fieldsTable(output, `Fields of ${short(method.output)}`) : null,
    ),
  ];

  if (options.length === 0) {
    return {
      elements: [
        ...header,
        h("h2", null, "Try it"),
        h(
          "p",
          { class: "notice" },
          "This method takes a stream of requests. A browser cannot send one, so it cannot be called from this page. Use a Connect or gRPC client.",
        ),
        ...reference,
      ],
      dispose() {},
    };
  }

  // ── the form ───────────────────────────────────────────────────────────
  const example = core.template(method.input);
  const transport = h(
    "select",
    { id: "transport" },
    options.map((option, i) => h("option", { value: i }, option.label)),
  );
  const body = h("textarea", {
    id: "body",
    rows: Math.min(24, Math.max(6, example.split("\n").length + 1)),
    spellcheck: "false",
    autocomplete: "off",
    autocapitalize: "off",
    "aria-describedby": "verdict",
  });
  body.value = context.drafts.get(method.path) ?? example;
  const verdict = h("p", { id: "verdict", class: "verdict", role: "status" });
  const timeout = h("input", {
    id: "timeout",
    type: "number",
    min: "1",
    step: "1",
    inputmode: "numeric",
    placeholder: "none",
  });
  const timeoutField = h(
    "div",
    { class: "field" },
    h("label", { for: "timeout" }, "Timeout in milliseconds"),
    timeout,
    h("p", { class: "hint" }, "Sent as the Connect-Timeout-Ms header."),
  );
  const target = h("p", { class: "target" });
  const sendButton = h(
    "button",
    { type: "submit", class: "primary" },
    method.serverStreaming ? "Send and listen" : "Send",
  );
  const cancelButton = h("button", { type: "button", hidden: true }, "Cancel");
  const withSecret = h("input", { type: "checkbox", id: "with-secret" });
  const copied = h("span", { class: "muted", role: "status" });
  const curlOutput = h("pre", { tabindex: "0", "aria-label": "curl command", hidden: true });
  const preview = h("div", { class: "preview" });
  // Why the request cannot be sent, where the person looks: by the button.
  const blocked = h("p", { class: "bad", role: "status" });
  const response = h("section", { class: "response", "aria-live": "polite", "aria-label": "Response" });
  const history = h("div", null);

  const choice = (): Choice => options[Number(transport.value)] ?? options[0]!;

  const spec = (overrides: Partial<RequestSpec> = {}): RequestSpec => {
    const environment = context.environment;
    const chosen = choice();
    const timeoutMs = Number(timeout.value);
    return {
      method: method.path,
      body: body.value,
      transport: chosen.transport,
      binding: chosen.binding,
      baseUrl: environment.baseUrl,
      headers: environment.headers,
      auth: toAuth(environment.auth, context.secrets.get(environment)),
      timeoutMs: chosen.transport !== "rest" && timeoutMs > 0 ? Math.round(timeoutMs) : null,
      ...overrides,
    };
  };

  const refresh = (): void => {
    const environment = context.environment;
    const scheme = environment.auth.scheme;
    const needsSecret = scheme !== "none" && context.secrets.get(environment) === "";
    replace(
      target,
      "Sending to ",
      h("strong", null, environment.name),
      " (",
      h("code", null, environment.baseUrl),
      scheme === "none" ? "), without authentication. " : `), with ${SCHEME_LABEL[scheme]}. `,
      needsSecret && h("span", { class: "warn-text" }, "No credential is set yet. "),
      scheme !== "none" &&
        isPlaintext(environment.baseUrl, location.href) &&
        h("span", { class: "warn-text" }, "This address is not https: the credential travels unencrypted. "),
      h(
        "button",
        {
          type: "button",
          class: "linklike",
          onclick: () => document.dispatchEvent(new CustomEvent("wirebook:environments")),
        },
        "Change",
      ),
    );
    timeoutField.hidden = choice().transport === "rest";

    const validation = core.validate(method.input, body.value);
    body.setAttribute("aria-invalid", String(!validation.ok));
    verdict.className = validation.ok ? "verdict ok" : "verdict bad";
    verdict.textContent = validation.ok
      ? `Valid ${short(method.input)}.`
      : `Line ${validation.line}, column ${validation.column}: ${validation.message.replace(/ at line \d+ column \d+$/, "")}`;

    // What will be sent, with the credential hidden.
    try {
      const { request } = core.request(spec());
      replace(
        preview,
        h(
          "pre",
          { tabindex: "0", "aria-label": "Request" },
          h("code", null, [
            `${request.verb} ${request.redactedUrl}\n`,
            ...request.headers.map((header) => `${header.name}: ${header.redacted ?? header.value}\n`),
            request.bodyText !== null
              ? `\n${request.bodyText}`
              : request.verb === "GET" || request.verb === "HEAD" || request.verb === "DELETE"
                ? ""
                : "\n(binary body)",
          ]),
        ),
      );
      blocked.textContent = "";
      sendButton.disabled = controller !== undefined;
    } catch (error) {
      replace(preview, h("p", { class: "muted" }, "Nothing, until the request can be built."));
      blocked.textContent = `This request cannot be sent: ${error instanceof Error ? error.message : String(error)}.`;
      sendButton.disabled = true;
    }
  };

  const showHistory = async (): Promise<void> => {
    const entries = (await list(context.store)).filter((e) => e.method === method.path).slice(0, 20);
    if (entries.length === 0) {
      replace(
        history,
        h(
          "p",
          { class: "muted" },
          "No call of this method yet. Calls are kept in this browser only: the body, without credentials and without the fields the schema marks as sensitive.",
        ),
      );
      return;
    }
    const use = (past: HistoryEntry) => (): void => {
      body.value = past.body;
      const at = options.findIndex((o) => o.transport === past.transport && o.binding === past.binding);
      if (at >= 0) transport.value = String(at);
      context.drafts.set(method.path, body.value);
      refresh();
      body.focus();
    };
    replace(
      history,
      h(
        "ul",
        { class: "history" },
        entries.map((past) =>
          h(
            "li",
            null,
            h(
              "span",
              null,
              badge(past.outcome, past.outcome === "ok" ? "good" : "warn"),
              ` ${time(past.time)} · ${past.environment} · ${past.transport} · ${past.durationMs} ms `,
            ),
            h("button", { type: "button", onclick: use(past) }, "Use this body"),
          ),
        ),
      ),
    );
  };

  const showOutcome = (outcome: Outcome): void => {
    const label = outcomeLabel(outcome);
    const good = label === "ok";
    const error = outcome.parsed?.error;
    replace(
      response,
      h("h3", null, "Response"),
      h(
        "p",
        { class: "status" },
        badge(
          outcome.status === 0
            ? "no response"
            : `HTTP ${outcome.status}${outcome.statusText ? ` ${outcome.statusText}` : ""}`,
          good ? "good" : "warn",
        ),
        " ",
        badge(label, good ? "good" : "warn"),
        ` ${Math.round(outcome.durationMs)} ms · ${bytes(outcome.size)}`,
      ),
      outcome.failure && h("p", { class: "error", role: "alert" }, outcome.failure.message),
      error && errorBox(error),
      outcome.framesDropped > 0 &&
        h(
          "p",
          { class: "hint" },
          `${outcome.framesDropped} earlier messages are not shown: the last ${MAX_FRAMES} are kept.`,
        ),
      outcome.request.expect.framing === "stream" &&
        outcome.frames.length > 0 &&
        h("ol", { class: "frames" }, outcome.frames.map(frameItem)),
      outcome.parsed?.ok === true &&
        outcome.parsed.message !== null &&
        h(
          "pre",
          { tabindex: "0", "aria-label": "Response body" },
          h("code", null, clip(pretty(outcome.parsed.message))),
        ),
      outcome.status !== 0 &&
        h(
          "details",
          null,
          h("summary", null, `Response headers (${outcome.headers.length})`),
          h(
            "pre",
            { tabindex: "0" },
            h("code", null, outcome.headers.map(([name, value]) => `${name}: ${value}`).join("\n")),
          ),
          h(
            "p",
            { class: "hint" },
            "From another origin, a browser shows only the headers the API exposes with Access-Control-Expose-Headers.",
          ),
        ),
      error &&
        outcome.raw !== null &&
        outcome.raw !== "" &&
        h(
          "details",
          null,
          h("summary", null, "Body as received"),
          h("pre", { tabindex: "0" }, h("code", null, clip(outcome.raw))),
        ),
    );
  };

  const submit = async (event: Event): Promise<void> => {
    event.preventDefault();
    if (sendButton.disabled || controller) return;
    controller = new AbortController();
    sendButton.disabled = true;
    cancelButton.hidden = false;
    const frames = h("ol", { class: "frames" });
    replace(
      response,
      h("h3", null, "Response"),
      h("p", { class: "status" }, method.serverStreaming ? "Listening…" : "Sending…"),
      frames,
    );
    const sent = spec();
    const environment = context.environment;
    try {
      const outcome = await send(core, sent, {
        fetch: globalThis.fetch.bind(globalThis),
        now: () => performance.now(),
        pageUrl: location.href,
        signal: controller.signal,
        onFrame: (frame) => {
          frames.appendChild(frameItem(frame));
          // A stream that never ends must not fill the page.
          if (frames.childElementCount > MAX_FRAMES) frames.firstElementChild?.remove();
        },
      });
      showOutcome(outcome);
      await record(
        context.store,
        entry(
          // Without the fields the schema marks as sensitive; or without
          // the body at all, when the person turned that off.
          { ...sent, body: keptBody(core, method.input, sent.body, context.keepBodies) },
          environment,
          { status: outcome.status, outcome: outcomeLabel(outcome), durationMs: outcome.durationMs },
          Date.now(),
        ),
      );
      await showHistory();
    } catch (error) {
      replace(
        response,
        h("h3", null, "Response"),
        h("p", { class: "error", role: "alert" }, error instanceof Error ? error.message : String(error)),
      );
    } finally {
      controller = undefined;
      cancelButton.hidden = true;
      refresh();
    }
  };

  const copyCurl = async (): Promise<void> => {
    const environment = context.environment;
    // curl runs outside the browser: it goes to the API itself, not to the
    // proxy, and needs a whole URL.
    let baseUrl = environment.directUrl ?? environment.baseUrl;
    if (baseUrl.startsWith("/")) baseUrl = location.origin + baseUrl;
    try {
      const command = core.curl(spec({ baseUrl }), !withSecret.checked);
      curlOutput.textContent = command;
      curlOutput.hidden = false;
      try {
        await navigator.clipboard.writeText(command);
        copied.textContent = withSecret.checked ? "Copied, with the credential in it." : "Copied.";
      } catch {
        copied.textContent = "Select the command below to copy it.";
      }
    } catch (error) {
      copied.textContent = `No command: ${error instanceof Error ? error.message : String(error)}.`;
    }
  };

  body.addEventListener("input", () => {
    context.drafts.set(method.path, body.value);
    refresh();
  });
  body.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) form.requestSubmit();
  });
  transport.addEventListener("change", refresh);
  timeout.addEventListener("input", refresh);
  cancelButton.addEventListener("click", () => controller?.abort());

  const form = h(
    "form",
    { class: "console", onsubmit: (event: Event) => void submit(event), novalidate: true },
    h("div", { class: "field" }, h("label", { for: "transport" }, "Send as"), transport),
    h(
      "div",
      { class: "field" },
      h("label", { for: "body" }, "Request body, as JSON"),
      body,
      verdict,
      h(
        "div",
        { class: "row" },
        h(
          "button",
          {
            type: "button",
            onclick: () => {
              body.value = example;
              context.drafts.delete(method.path);
              refresh();
            },
          },
          "Reset to the example",
        ),
        h(
          "button",
          {
            type: "button",
            onclick: () => {
              try {
                body.value = pretty(JSON.parse(body.value));
                context.drafts.set(method.path, body.value);
                refresh();
              } catch {
                /* The verdict already says what is wrong. */
              }
            },
          },
          "Format",
        ),
      ),
    ),
    timeoutField,
    target,
    h(
      "div",
      { class: "row" },
      sendButton,
      cancelButton,
      h("span", { class: "hint" }, "Ctrl+Enter or ⌘+Enter in the body sends."),
    ),
    blocked,
    h("details", null, h("summary", null, "What will be sent"), preview),
    h(
      "div",
      { class: "row" },
      h("button", { type: "button", onclick: () => void copyCurl() }, "Copy as curl"),
      h("label", { class: "check" }, withSecret, " include the credential"),
      copied,
    ),
    h(
      "p",
      { class: "hint" },
      "The command is quoted for sh, bash and zsh. In another shell, check it before you run it.",
    ),
    curlOutput,
  );

  const unsubscribe = context.onChange(refresh);
  refresh();
  void showHistory();

  return {
    elements: [
      ...header,
      h("h2", null, "Try it"),
      form,
      response,
      h("details", { class: "past" }, h("summary", null, "Earlier calls of this method"), history),
      ...reference,
    ],
    dispose() {
      controller?.abort();
      unsubscribe();
    },
  };
}
