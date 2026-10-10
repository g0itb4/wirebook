// The reference pages: home, service, message, enum. The method page, with
// its console, is in console.ts.
import { toAuth } from "../lib/environments";
import { href, packages, shortName } from "../lib/route";
import type { Auth, EnumDoc, FieldDoc, Index, MessageDoc, MethodDoc, ServiceDoc } from "../lib/types";
import type { Context } from "./context";
import { block } from "./copy";
import { badge, code, h, prose } from "./dom";

/** Where wirebook lives. Every site says so, in its header and footer. */
export const REPO = "https://github.com/g0itb4/wirebook";

/** A page: what is read, and what stands beside it. */
export interface Panes {
  reference: (HTMLElement | false)[];
  side?: (HTMLElement | false)[];
}

let names: (fullName: string) => string = (fullName) => shortName(fullName);

/** Set once, when the page starts: how a full name is shortened. */
export function useNames(shorten: (fullName: string) => string): void {
  names = shorten;
}

/** `Widget.Part` for `fixture.v1.Widget.Part`. */
export function short(fullName: string): string {
  return names(fullName);
}

export function link(name: string, label?: string): HTMLElement {
  return h("a", { href: href(name) }, label ?? name);
}

/** `fixture.v1` of `fixture.v1.Widget.Part`: what is left once the short name goes. */
function packageOf(fullName: string): string {
  const rest = short(fullName);
  return fullName.endsWith(rest) ? fullName.slice(0, Math.max(0, fullName.length - rest.length - 1)) : "";
}

/**
 * Where a page is: its package, what it is in between, and the kind of thing
 * it shows. The last crumb is the current one.
 */
export function crumbs(fullName: string, ...between: (HTMLElement | string)[]): HTMLElement {
  const pkg = packageOf(fullName);
  const items: (HTMLElement | string)[] = [pkg === "" ? "(no package)" : pkg, ...between];
  return h(
    "nav",
    { class: "crumbs", "aria-label": "Breadcrumb" },
    h(
      "ol",
      null,
      items.map((item, i) => h("li", i === items.length - 1 ? { "aria-current": "page" } : null, item)),
    ),
  );
}

/** What a method does, in a word and its colour: read, write or stream. */
export function kindOf(method: MethodDoc): { word: string; letter: string; colour: string } {
  if (method.clientStreaming || method.serverStreaming) return { word: "stream", letter: "S", colour: "stream" };
  if (method.idempotency === "no_side_effects") return { word: "read", letter: "R", colour: "read" };
  return { word: "write", letter: "W", colour: "write" };
}

/** A field's type, with a link when it is a message or an enum. */
export function typeOf(field: FieldDoc): HTMLElement {
  const element =
    field.kind === "scalar" ? h("code", null, field.type) : h("code", null, link(field.type, short(field.type)));
  if (field.cardinality === "repeated") return h("span", null, h("code", null, "repeated "), element);
  if (field.cardinality === "map") {
    return h("span", null, h("code", null, `map<${field.mapKey}, `), element, h("code", null, ">"));
  }
  return element;
}

function notes(field: FieldDoc): (HTMLElement | false)[] {
  // "required" is said by its tag; the rules say the rest.
  const rules = field.rules.filter((rule) => rule !== "required");
  return [
    field.deprecated && badge("deprecated", "warn"),
    (field.required || field.presence === "required") && badge("required", "write"),
    field.oneof !== null && badge(`oneof ${field.oneof}`),
    field.reference !== null && badge(`from ${field.reference.method.split("/")[1]}`, "read"),
    rules.length > 0 && h("p", { class: "rules" }, rules.join(" · ")),
    field.example !== null &&
      field.example !== undefined &&
      h("p", { class: "rules" }, "e.g. ", h("code", null, String(field.example))),
  ];
}

/**
 * A table wider than a phone scrolls inside its own box. The box takes the
 * focus, so the keyboard can scroll it, and says what it holds.
 */
function scrollBox(label: string): Record<string, string> {
  return { class: "scroll", tabindex: "0", role: "region", "aria-label": `${label}, scrollable` };
}

export function fieldsTable(message: MessageDoc, caption: string): HTMLElement {
  if (message.fields.length === 0) {
    return h("p", { class: "muted" }, `${short(message.name)} has no fields.`);
  }
  // A list, not a table: a description has the whole width to itself, and a
  // phone needs no sideways scroll.
  return h(
    "ul",
    { class: "props", "aria-label": caption },
    message.fields.map((field) =>
      h(
        "li",
        { id: `m-${field.name}` },
        h(
          "div",
          { class: "prop-head" },
          h("code", { class: "prop-name" }, field.jsonName),
          typeOf(field),
          field.jsonName !== field.name && h("span", { class: "muted small" }, h("code", null, field.name)),
          h("span", { class: "muted small" }, `#${field.number}`),
        ),
        h("div", { class: "notes" }, notes(field)),
        prose(field.doc),
      ),
    ),
  );
}

export function methodBadges(method: MethodDoc): (HTMLElement | false)[] {
  const shape =
    method.clientStreaming && method.serverStreaming
      ? "bidirectional stream"
      : method.clientStreaming
        ? "client stream"
        : method.serverStreaming
          ? "server stream"
          : "unary";
  const kind = kindOf(method);
  return [
    badge(shape, kind.colour === "stream" ? "stream" : ""),
    kind.word !== "stream" && badge(kind.word, kind.colour),
    method.idempotency === "idempotent" && badge("idempotent", "stream"),
    method.deprecated && badge("deprecated", "warn"),
  ];
}

function methodList(service: ServiceDoc): HTMLElement {
  return h(
    "ul",
    { class: "cards" },
    service.methods.map((method) =>
      h(
        "li",
        null,
        h("h3", null, link(method.path, method.name), " ", methodBadges(method)),
        h(
          "p",
          { class: "signature" },
          link(method.input, short(method.input)),
          " → ",
          link(method.output, short(method.output)),
        ),
        method.http.map((binding) => h("p", { class: "rest" }, h("code", null, `${binding.verb} ${binding.path}`))),
        prose(method.doc),
      ),
    ),
  );
}

/** Above this many methods, the home page lists services, not every method. */
const INLINE_METHODS = 24;

/** The method to try first: one that reads, and can be called from a browser. */
function firstMethod(services: ServiceDoc[]): { service: ServiceDoc; method: MethodDoc } | undefined {
  const callable = services.flatMap((service) =>
    service.methods
      .filter((method) => !method.clientStreaming && method.transports.length > 0)
      .map((method) => ({ service, method })),
  );
  return (
    callable.find(({ method }) => method.idempotency === "no_side_effects" && !method.serverStreaming) ??
    callable.find(({ method }) => !method.serverStreaming) ??
    callable[0]
  );
}

/**
 * The first method as a curl command, for the environment the page is set
 * to. With its credential as a shell variable; or, before one is set and the
 * scheme needs one, without authentication at all.
 */
function firstCall(context: Context, method: MethodDoc): string | undefined {
  const environment = context.environment;
  let baseUrl = environment.directUrl ?? environment.baseUrl;
  if (baseUrl.startsWith("/")) baseUrl = location.origin + baseUrl;
  const transport = method.transports.includes("connect-json") ? "connect-json" : method.transports[0]!;
  const snippet = (auth: Auth): string =>
    context.core.snippet(
      {
        method: method.path,
        body: context.core.template(method.input, environment.variables),
        transport,
        binding: 0,
        baseUrl,
        headers: environment.headers,
        variables: environment.variables,
        auth,
        timeoutMs: null,
      },
      "curl",
      true,
    );
  for (const auth of [toAuth(environment.auth, context.secrets.get(environment)), { scheme: "none" } as const]) {
    try {
      return snippet(auth);
    } catch {
      // The next way, or none.
    }
  }
  return undefined;
}

function stat(count: number, one: string, many: string): HTMLElement | false {
  return count > 0 && h("div", null, h("dt", null, count === 1 ? one : many), h("dd", null, String(count)));
}

function serviceCard(service: ServiceDoc): HTMLElement {
  const kinds = { read: 0, write: 0, stream: 0 };
  for (const method of service.methods) kinds[kindOf(method).colour as keyof typeof kinds]++;
  return h(
    "li",
    null,
    h("h3", null, link(service.name, short(service.name)), service.deprecated && [" ", badge("deprecated", "warn")]),
    h("p", { class: "doc-line muted" }, service.doc.split(/\n\s*\n/)[0] ?? ""),
    h(
      "p",
      { class: "counts" },
      `${service.methods.length} ${service.methods.length === 1 ? "method" : "methods"}`,
      kinds.read > 0 && [" · ", h("span", { class: "tag read" }, "R"), ` ${kinds.read}`],
      kinds.write > 0 && [" · ", h("span", { class: "tag write" }, "W"), ` ${kinds.write}`],
      kinds.stream > 0 && [" · ", h("span", { class: "tag stream" }, "S"), ` ${kinds.stream}`],
    ),
  );
}

/** What the page is for, in the three steps a visitor takes. */
function howItWorks(): HTMLElement {
  const step = (word: string, text: string): HTMLElement => h("li", null, h("strong", null, word), h("p", null, text));
  return h(
    "section",
    { class: "how", "aria-labelledby": "how-head" },
    h("h2", { id: "how-head", class: "visually-hidden" }, "How this page works"),
    h(
      "ol",
      null,
      step("Read", "Every service, method, message and enum, with the comments of its proto files."),
      step("Fill", "A request body, as a form drawn from the schema, with the rules and examples it declares."),
      step(
        "Send",
        "A real request, over Connect or REST, from your browser to the environment chosen at the top. Nothing is faked.",
      ),
    ),
    h(
      "p",
      { class: "muted small" },
      "Made with ",
      h("a", { href: REPO, rel: "noopener" }, "wirebook"),
      ": proto files in, an API explorer out.",
    ),
  );
}

/**
 * The page's sections, as a line of links under its title, when there are
 * two or more. A link scrolls to its heading and leaves the address alone:
 * the address names the page.
 */
export function contents(pane: HTMLElement): void {
  const headings = [...pane.querySelectorAll<HTMLHeadingElement>(":scope > h2:not(.visually-hidden)")];
  // The home page's sections are the services, already in the menu.
  const title = pane.querySelector(":scope > h1:not(.hero)");
  if (headings.length < 2 || !title) return;
  const items = headings.map((heading, i) => {
    heading.id ||= `section-${i + 1}`;
    heading.setAttribute("tabindex", "-1");
    return h(
      "li",
      null,
      h(
        "a",
        {
          href: `#${heading.id}`,
          onclick: (event: Event) => {
            event.preventDefault();
            heading.focus({ preventScroll: true });
            heading.scrollIntoView({ block: "start" });
          },
        },
        heading.textContent ?? "",
      ),
    );
  });
  title.after(h("nav", { class: "toc", "aria-label": "On this page" }, h("ol", null, items)));
}

export function home(context: Context): Panes {
  const index: Index = context.core.index;
  const own = packages(index).filter((group) => !group.imported);
  const services = own.flatMap((group) => group.services);
  const methods = services.reduce((n, service) => n + service.methods.length, 0);
  const files = index.files.filter((file) => !file.imported);
  const first = firstMethod(services);
  const call = first && firstCall(context, first.method);
  return {
    reference: [
      h("h1", { class: "hero" }, context.config.title),
      context.config.description
        ? h("p", { class: "lead" }, context.config.description)
        : services.length === 0
          ? h("p", { class: "lead muted" }, "This schema declares no service. Its messages and enums are in the menu.")
          : h(
              "p",
              { class: "lead" },
              "Read every method, then call it from the page. Nothing is faked: each answer comes from the API.",
            ),
      h(
        "dl",
        { class: "stats", "aria-label": "What this schema declares" },
        stat(services.length, "service", "services"),
        stat(methods, "method", "methods"),
        stat(
          own.reduce((n, group) => n + group.messages.length, 0),
          "message",
          "messages",
        ),
        stat(
          own.reduce((n, group) => n + group.enums.length, 0),
          "enum",
          "enums",
        ),
      ),
      index.problems.length > 0 &&
        h(
          "div",
          { class: "notice" },
          h("p", null, "The site's config has entries that are not used:"),
          h(
            "ul",
            null,
            index.problems.map((problem) => h("li", null, problem)),
          ),
        ),
      services.length > 0 && howItWorks(),
      first !== undefined &&
        h(
          "section",
          { class: "card start", "aria-labelledby": "start-head" },
          h("div", { class: "card-head" }, h("h2", { id: "start-head" }, "Start here")),
          h(
            "div",
            { class: "card-body" },
            h(
              "p",
              { class: "signature" },
              h("code", null, `${short(first.service.name)}/${first.method.name}`),
              " ",
              methodBadges(first.method),
            ),
            prose(first.method.doc.split(/\n\s*\n/)[0] ?? ""),
            call !== undefined &&
              block(
                "the command",
                h("pre", { tabindex: "0", "aria-label": "The first call, as curl" }, code(call, "curl")),
                () => call,
              ),
            h(
              "p",
              null,
              h("a", { class: "button primary", href: href(first.method.path) }, `Open ${first.method.name}`),
            ),
          ),
        ),
      ...(methods <= INLINE_METHODS
        ? services.flatMap((service) => [
            h("h2", null, link(service.name), service.deprecated && [" ", badge("deprecated", "warn")]),
            prose(service.doc),
            methodList(service),
          ])
        : [h("h2", null, "Services"), h("ul", { class: "grid", "aria-label": "Services" }, services.map(serviceCard))]),
      h(
        "details",
        { class: "files" },
        h("summary", null, `Files (${files.length})`),
        h(
          "div",
          scrollBox("The proto files this site documents"),
          h(
            "table",
            null,
            h("caption", null, "The proto files this site documents"),
            h(
              "thead",
              null,
              h(
                "tr",
                null,
                h("th", { scope: "col" }, "File"),
                h("th", { scope: "col" }, "Package"),
                h("th", { scope: "col" }, "Syntax"),
              ),
            ),
            h(
              "tbody",
              null,
              files.map((file) =>
                h(
                  "tr",
                  null,
                  h("th", { scope: "row" }, h("code", null, file.name)),
                  h("td", null, h("code", null, file.package)),
                  h("td", null, /^\d+$/.test(file.edition) ? `edition ${file.edition}` : file.edition),
                ),
              ),
            ),
          ),
        ),
      ),
    ],
  };
}

export function servicePage(service: ServiceDoc): Panes {
  return {
    reference: [
      crumbs(service.name, "Service"),
      h("h1", null, service.name, service.deprecated && [" ", badge("deprecated", "warn")]),
      h("p", { class: "muted small" }, h("code", null, service.file)),
      prose(service.doc, "No description."),
      h("h2", null, "Methods"),
      methodList(service),
    ],
  };
}

/** What uses a type: the methods that take or return it, and the messages with a field of it. */
function usedBy(index: Index, name: string): string[] {
  const methods = index.services.flatMap((service) =>
    service.methods.filter((m) => m.input === name || m.output === name).map((m) => m.path),
  );
  const messages = index.messages
    .filter((message) => message.name !== name && message.fields.some((field) => field.type === name))
    .map((message) => message.name);
  return [...methods, ...messages];
}

function users(index: Index, name: string): (HTMLElement | false)[] {
  const list = usedBy(index, name);
  return [
    list.length > 0 && h("h2", { id: "used-by" }, "Used by"),
    list.length > 0 &&
      h(
        "ul",
        { class: "links", "aria-labelledby": "used-by" },
        list.map((user) => h("li", null, link(user))),
      ),
  ];
}

export function messagePage(context: Context, message: MessageDoc): Panes {
  return {
    reference: [
      crumbs(message.name, "Message"),
      h("h1", null, message.name, message.deprecated && [" ", badge("deprecated", "warn")]),
      h("p", { class: "muted small" }, h("code", null, message.file)),
      prose(message.doc, "No description."),
      message.rules.length > 0 && h("p", { class: "rules" }, message.rules.join(" · ")),
      h("h2", null, "Fields"),
      fieldsTable(message, `Fields of ${short(message.name)}`),
      ...users(context.core.index, message.name),
    ],
    side: [
      h("h2", null, "Example"),
      block(
        "the example",
        h(
          "pre",
          { tabindex: "0", "aria-label": "Example JSON" },
          code(context.core.template(message.name, {}), "json"),
        ),
        () => context.core.template(message.name, {}),
      ),
    ],
  };
}

export function enumPage(context: Context, enumeration: EnumDoc): Panes {
  return {
    reference: [
      crumbs(enumeration.name, "Enum"),
      h("h1", null, enumeration.name, enumeration.deprecated && [" ", badge("deprecated", "warn")]),
      h("p", { class: "muted small" }, h("code", null, enumeration.file)),
      prose(enumeration.doc, "No description."),
      h(
        "p",
        null,
        enumeration.closed
          ? "Closed: a number that is not listed is rejected."
          : "Open: a number that is not listed is kept as a number.",
      ),
      h(
        "div",
        scrollBox(`Values of ${short(enumeration.name)}`),
        h(
          "table",
          null,
          h("caption", null, `Values of ${short(enumeration.name)}`),
          h(
            "thead",
            null,
            h(
              "tr",
              null,
              h("th", { scope: "col" }, "Name"),
              h("th", { scope: "col" }, "Number"),
              h("th", { scope: "col" }, "Description"),
            ),
          ),
          h(
            "tbody",
            null,
            enumeration.values.map((value) =>
              h(
                "tr",
                { id: `m-${value.name}` },
                h("th", { scope: "row" }, h("code", null, value.name)),
                h("td", null, value.number),
                h("td", null, value.deprecated && badge("deprecated", "warn"), prose(value.doc)),
              ),
            ),
          ),
        ),
      ),
      ...users(context.core.index, enumeration.name),
    ],
  };
}

export function missing(target: string): Panes {
  return {
    reference: [
      h("h1", null, "Not found"),
      h("p", null, "This schema has nothing named ", h("code", null, target), "."),
      h(
        "p",
        null,
        "The name may have changed. Search for it, or go back to the ",
        h("a", { href: "#/" }, "overview"),
        ".",
      ),
    ],
  };
}
