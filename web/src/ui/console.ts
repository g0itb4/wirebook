// The method page: what the method is, and beside it the console that calls
// it.
import { SCHEME_LABEL, isPlaintext, toAuth } from "../lib/environments";
import { parseBody, stringify } from "../lib/form";
import { type HistoryEntry, entry, keptBody, list, record } from "../lib/history";
import { MAX_FRAMES, type Outcome, outcomeLabel, send } from "../lib/send";
import type { Frame, Language, MethodDoc, RequestSpec, RpcError, ServiceDoc, Transport } from "../lib/types";
import type { Context } from "./context";
import { badge, bytes, clip, h, pretty, prose, replace } from "./dom";
import { form as formView } from "./form";
import { type Panes, fieldsTable, link, methodBadges, short } from "./pages";

export interface Page {
  panes: Panes;
  /** Stop what the page started: a call in flight, a subscription. */
  dispose(): void;
}

interface Choice {
  label: string;
  transport: Transport;
  binding: number;
}

const LANGUAGES: { id: Language; label: string }[] = [
  { id: "curl", label: "curl" },
  { id: "fetch", label: "fetch" },
  { id: "python", label: "Python" },
  { id: "go", label: "Go" },
];

/** The language of the code, kept while the page is open. */
let language: Language = "curl";

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

  const reference: (HTMLElement | false)[] = [
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
    h("h2", null, "Request · ", short(method.input)),
    input !== undefined && input.rules.length > 0 && h("p", { class: "rules" }, input.rules.join(" · ")),
    input !== undefined && fieldsTable(input, `Fields of the request, ${short(method.input)}`),
    h("h2", null, "Response · ", short(method.output)),
    output !== undefined && fieldsTable(output, `Fields of the response, ${short(method.output)}`),
  ];

  if (options.length === 0 || input === undefined) {
    return {
      panes: {
        reference,
        side: [
          h("h2", null, "Console"),
          h(
            "p",
            { class: "notice" },
            "This method takes a stream of requests. A browser cannot send one, so it cannot be called from this page. Use a Connect or gRPC client.",
          ),
        ],
      },
      dispose() {},
    };
  }

  // ── the request ────────────────────────────────────────────────────────
  const example = (): string => core.template(method.input, context.environment.variables);
  const transport = h(
    "select",
    { id: "transport" },
    options.map((option, i) => h("option", { value: i }, option.label)),
  );
  const body = h("textarea", {
    id: "body",
    rows: Math.min(22, Math.max(6, example().split("\n").length + 1)),
    spellcheck: "false",
    autocomplete: "off",
    autocapitalize: "off",
    "aria-label": "Request body, as JSON",
    "aria-describedby": "verdict",
  });
  body.value = context.drafts.get(method.path) ?? example();
  const verdict = h("p", { id: "verdict", class: "verdict", role: "status" });
  const warnings = h("ul", { class: "warnings", "aria-label": "Rules of the schema this body does not meet" });
  const timeout = h("input", {
    id: "timeout",
    type: "text",
    inputmode: "numeric",
    autocomplete: "off",
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
    { type: "submit", class: `primary ${method.idempotency === "no_side_effects" ? "" : "write"}`.trim() },
    method.serverStreaming ? "Send and listen" : "Send",
  );
  const cancelButton = h("button", { type: "button", hidden: true }, "Cancel");
  // Why the request cannot be sent, where the person looks: by the button.
  const blocked = h("p", { class: "bad", role: "status" });
  const preview = h("div", { class: "preview" });
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
      variables: environment.variables,
      auth: toAuth(environment.auth, context.secrets.get(environment)),
      timeoutMs: chosen.transport !== "rest" && timeoutMs > 0 ? Math.round(timeoutMs) : null,
      ...overrides,
    };
  };

  // ── the body, as a form and as JSON ────────────────────────────────────
  const fields = formView(context, {
    message: input,
    value: () => parseBody(body.value),
    commit: (next, redraw) => {
      body.value = stringify(next);
      context.drafts.set(method.path, body.value);
      if (redraw) fields.draw();
      refresh();
    },
  });
  const notForm = h(
    "p",
    { class: "notice" },
    "The body is not a JSON object, so it has no form. Edit it as JSON, or reset it to the example.",
  );
  const asForm = h("button", { type: "button", "aria-pressed": "false" }, "Form");
  const asJson = h("button", { type: "button", "aria-pressed": "false" }, "JSON");
  const formatButton = h("button", { type: "button" }, "Format");
  const isObject = (): boolean => {
    const value = parseBody(body.value);
    return typeof value === "object" && value !== null && !Array.isArray(value);
  };
  const showView = (): void => {
    const form = context.view === "form";
    asForm.setAttribute("aria-pressed", String(form));
    asJson.setAttribute("aria-pressed", String(!form));
    const drawn = form && isObject();
    fields.element.hidden = !drawn;
    notForm.hidden = !form || drawn;
    body.hidden = form;
    formatButton.hidden = form;
    if (drawn) fields.draw();
  };
  const setView = (view: "form" | "json") => (): void => {
    void context.setView(view);
    showView();
    refresh();
  };
  asForm.addEventListener("click", setView("form"));
  asJson.addEventListener("click", setView("json"));

  /** A new body from outside the form: a reset, an earlier call. */
  const setBody = (text: string, draft: boolean): void => {
    body.value = text;
    if (draft) context.drafts.set(method.path, text);
    else context.drafts.delete(method.path);
    showView();
    refresh();
  };

  // ── the request as code ────────────────────────────────────────────────
  const withSecret = h("input", { type: "checkbox", id: "with-secret" });
  const copied = h("span", { class: "muted", role: "status" });
  const code = h("pre", { tabindex: "0", "aria-label": "The request as code" });
  const shellHint = h(
    "p",
    { class: "hint" },
    "The command is quoted for sh, bash and zsh. In another shell, check it before you run it.",
  );
  const languageButtons = LANGUAGES.map(({ id, label }) =>
    h(
      "button",
      {
        type: "button",
        "aria-pressed": "false",
        "data-language": id,
        onclick: () => {
          language = id;
          copied.textContent = "";
          showCode();
        },
      },
      label,
    ),
  );
  const snippet = (): string => {
    const environment = context.environment;
    // Code runs outside the browser: it goes to the API itself, not to the
    // proxy, and needs a whole URL.
    let baseUrl = environment.directUrl ?? environment.baseUrl;
    if (baseUrl.startsWith("/")) baseUrl = location.origin + baseUrl;
    return core.snippet(spec({ baseUrl }), language, !withSecret.checked);
  };
  const showCode = (): void => {
    for (const button of languageButtons) {
      button.setAttribute("aria-pressed", String(button.getAttribute("data-language") === language));
    }
    shellHint.hidden = language !== "curl";
    try {
      replace(code, h("code", null, snippet()));
    } catch {
      replace(code, h("code", { class: "muted" }, "Nothing, until the request can be built."));
    }
  };
  withSecret.addEventListener("change", showCode);
  const copyCode = async (): Promise<void> => {
    try {
      const text = snippet();
      try {
        await navigator.clipboard.writeText(text);
        copied.textContent = withSecret.checked ? "Copied, with the credential in it." : "Copied.";
      } catch {
        copied.textContent = "Select the code below to copy it.";
      }
    } catch (error) {
      copied.textContent = `No code: ${error instanceof Error ? error.message : String(error)}.`;
    }
  };

  const refresh = (): void => {
    const environment = context.environment;
    const scheme = environment.auth.scheme;
    const needsSecret = scheme !== "none" && context.secrets.get(environment) === "";
    replace(
      target,
      "To ",
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

    const validation = core.validate(method.input, body.value, environment.variables);
    body.setAttribute("aria-invalid", String(!validation.ok));
    // The rules of the schema are warnings: the server is the one that decides.
    const violations = validation.ok ? core.check(method.input, body.value, environment.variables) : [];
    const listed = fields.element.hidden ? violations : fields.warn(violations);
    replace(
      warnings,
      listed.map((violation) => h("li", null, h("code", null, violation.path), ` ${violation.message}`)),
    );
    warnings.hidden = listed.length === 0;
    verdict.className = !validation.ok ? "verdict bad" : violations.length > 0 ? "verdict warn" : "verdict ok";
    verdict.textContent = !validation.ok
      ? `Line ${validation.line}, column ${validation.column}: ${validation.message.replace(/ at line \d+ column \d+$/, "")}`
      : violations.length === 0
        ? `Valid ${short(method.input)}.`
        : `Valid ${short(method.input)}. ${violations.length} ${violations.length === 1 ? "rule" : "rules"} of the schema not met: the server may refuse it.`;

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
    showCode();
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
      const at = options.findIndex((o) => o.transport === past.transport && o.binding === past.binding);
      if (at >= 0) transport.value = String(at);
      setBody(past.body, true);
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
              badge(past.outcome, past.outcome === "ok" ? "good" : "error"),
              ` ${time(past.time)} · ${past.environment} · ${past.transport} · ${past.durationMs} ms `,
            ),
            h("button", { type: "button", onclick: use(past) }, "Use this body"),
          ),
        ),
      ),
    );
  };

  /** One line, as a terminal would say it: HTTP 200 OK · ok · 12 ms · 143 B. */
  const statusLine = (outcome: Outcome): HTMLElement => {
    const label = outcomeLabel(outcome);
    const good = label === "ok";
    return h(
      "p",
      // The one effect of the page: an error arrives with a jolt.
      { class: good ? "status" : "status glitch" },
      badge(
        outcome.status === 0
          ? "no response"
          : `HTTP ${outcome.status}${outcome.statusText ? ` ${outcome.statusText}` : ""}`,
        good ? "good" : "error",
      ),
      badge(label, good ? "good" : "error"),
      h("span", null, `${Math.round(outcome.durationMs)} ms · ${bytes(outcome.size)}`),
    );
  };

  const showOutcome = (outcome: Outcome): void => {
    const error = outcome.parsed?.error;
    replace(
      response,
      h("h2", null, "Response"),
      statusLine(outcome),
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

  const idle = (): void => {
    replace(response, h("h2", null, "Response"), h("p", { class: "muted" }, "Nothing sent yet."));
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
      h("h2", null, "Response"),
      h("p", { class: "status" }, badge(method.serverStreaming ? "listening" : "sending", "stream")),
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
          // An id that went by can be picked later, without a call.
          if (frame.kind === "message") context.lookups.notice(method.output, frame.message, environment);
        },
      });
      if (outcome.parsed?.ok === true && outcome.parsed.message !== null) {
        context.lookups.notice(method.output, outcome.parsed.message, environment);
      }
      showOutcome(outcome);
      await record(
        context.store,
        entry(
          // As typed, with its placeholders. Without the fields the schema
          // marks as sensitive; or without the body at all, when the person
          // turned that off.
          { ...sent, body: keptBody(core, method.input, sent.body, context.keepBodies, environment.variables) },
          environment,
          { status: outcome.status, outcome: outcomeLabel(outcome), durationMs: outcome.durationMs },
          Date.now(),
        ),
      );
      await showHistory();
    } catch (error) {
      replace(
        response,
        h("h2", null, "Response"),
        h("p", { class: "error glitch", role: "alert" }, error instanceof Error ? error.message : String(error)),
      );
    } finally {
      controller = undefined;
      cancelButton.hidden = true;
      refresh();
    }
  };

  body.addEventListener("input", () => {
    context.drafts.set(method.path, body.value);
    refresh();
  });
  transport.addEventListener("change", refresh);
  timeout.addEventListener("input", refresh);
  cancelButton.addEventListener("click", () => controller?.abort());
  formatButton.addEventListener("click", () => {
    // When it is not JSON, the verdict already says what is wrong.
    const value = parseBody(body.value);
    if (value !== undefined) setBody(stringify(value), true);
  });

  const form = h(
    "form",
    { class: "console", onsubmit: (event: Event) => void submit(event), novalidate: true },
    target,
    // The button is at the top, where it stays in view however long the body is.
    h(
      "div",
      { class: "field" },
      h("label", { for: "transport" }, "Send as"),
      h("div", { class: "send" }, transport, sendButton, cancelButton),
    ),
    blocked,
    h(
      "div",
      { class: "field" },
      h(
        "div",
        { class: "bar" },
        h("span", { class: "label" }, "Body"),
        h("div", { class: "tabs", role: "group", "aria-label": "Edit the body as" }, asForm, asJson),
      ),
      fields.element,
      notForm,
      body,
      verdict,
      warnings,
      h(
        "div",
        { class: "row" },
        h("button", { type: "button", onclick: () => setBody(example(), false) }, "Reset to the example"),
        formatButton,
      ),
    ),
    timeoutField,
    h("p", { class: "hint" }, "Ctrl+Enter or ⌘+Enter sends."),
  );
  form.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      form.requestSubmit();
    }
  });

  const unsubscribe = context.onChange(refresh);
  showView();
  refresh();
  idle();
  void showHistory();

  return {
    panes: {
      reference,
      side: [
        h("h2", null, "Console"),
        form,
        response,
        h(
          "details",
          { class: "code", open: true },
          h("summary", null, "The request as code"),
          h("div", { class: "tabs", role: "group", "aria-label": "Language" }, languageButtons),
          code,
          h(
            "div",
            { class: "row" },
            h("button", { type: "button", onclick: () => void copyCode() }, "Copy"),
            h("label", { class: "check" }, withSecret, " include the credential"),
            copied,
          ),
          shellHint,
        ),
        h("details", null, h("summary", null, "What will be sent"), preview),
        h("details", { class: "past" }, h("summary", null, "Earlier calls of this method"), history),
      ],
    },
    dispose() {
      controller?.abort();
      unsubscribe();
    },
  };
}
