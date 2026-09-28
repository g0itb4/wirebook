// The documentation pages: home, service, message, enum. The method page,
// with its console, is in console.ts.
import { href, packages, shortName } from "../lib/route";
import type { EnumDoc, FieldDoc, Index, MessageDoc, MethodDoc, ServiceDoc } from "../lib/types";
import type { Context } from "./context";
import { badge, h, prose } from "./dom";

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

/**
 * A table wider than a phone scrolls inside its own box. The box takes the
 * focus, so the keyboard can scroll it, and says what it holds.
 */
function scrollBox(label: string): Record<string, string> {
  return { class: "scroll", tabindex: "0", role: "region", "aria-label": `${label}, scrollable` };
}

function notes(field: FieldDoc): (HTMLElement | false)[] {
  return [
    field.deprecated && badge("deprecated", "warn"),
    field.presence === "required" && badge("required"),
    field.presence === "explicit" && field.kind !== "message" && badge("optional"),
    field.oneof !== null && badge(`oneof ${field.oneof}`),
  ];
}

export function fieldsTable(message: MessageDoc, caption: string): HTMLElement {
  if (message.fields.length === 0) {
    return h("p", { class: "muted" }, `${short(message.name)} has no fields.`);
  }
  return h(
    "div",
    scrollBox(caption),
    h(
      "table",
      null,
      h("caption", null, caption),
      h(
        "thead",
        null,
        h(
          "tr",
          null,
          h("th", { scope: "col" }, "Field"),
          h("th", { scope: "col" }, "Type"),
          h("th", { scope: "col" }, "No."),
          h("th", { scope: "col" }, "Description"),
        ),
      ),
      h(
        "tbody",
        null,
        message.fields.map((field) =>
          h(
            "tr",
            null,
            h(
              "th",
              { scope: "row" },
              h("code", null, field.jsonName),
              field.jsonName !== field.name && h("div", { class: "muted small" }, field.name),
            ),
            h("td", null, typeOf(field)),
            h("td", null, field.number),
            h("td", null, notes(field), prose(field.doc)),
          ),
        ),
      ),
    ),
  );
}

export function methodBadges(method: MethodDoc): (HTMLElement | false)[] {
  const stream =
    method.clientStreaming && method.serverStreaming
      ? "bidirectional stream"
      : method.clientStreaming
        ? "client stream"
        : method.serverStreaming
          ? "server stream"
          : "unary";
  return [
    badge(stream),
    method.idempotency === "no_side_effects" && badge("no side effects"),
    method.idempotency === "idempotent" && badge("idempotent"),
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

export function home(context: Context): HTMLElement[] {
  const index: Index = context.core.index;
  const own = packages(index).filter((group) => !group.imported);
  const services = own.flatMap((group) => group.services);
  const files = index.files.filter((file) => !file.imported);
  return [
    h("h1", null, context.config.title),
    services.length === 0
      ? h("p", { class: "muted" }, "This schema declares no service. Its messages and enums are in the menu.")
      : h(
          "p",
          null,
          `${services.length} ${services.length === 1 ? "service" : "services"}, `,
          `${services.reduce((n, service) => n + service.methods.length, 0)} methods. `,
          "Open a method to read it and to call it.",
        ),
    ...services.flatMap((service) => [
      h("h2", null, link(service.name), service.deprecated && [" ", badge("deprecated", "warn")]),
      prose(service.doc),
      methodList(service),
    ]),
    h("h2", null, "Files"),
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
  ];
}

export function servicePage(service: ServiceDoc): HTMLElement[] {
  return [
    h("p", { class: "kind" }, "Service"),
    h("h1", null, service.name, service.deprecated && [" ", badge("deprecated", "warn")]),
    h("p", { class: "muted small" }, h("code", null, service.file)),
    prose(service.doc, "No description."),
    h("h2", null, "Methods"),
    methodList(service),
  ];
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

export function messagePage(context: Context, message: MessageDoc): HTMLElement[] {
  const users = usedBy(context.core.index, message.name);
  return [
    h("p", { class: "kind" }, "Message"),
    h("h1", null, message.name, message.deprecated && [" ", badge("deprecated", "warn")]),
    h("p", { class: "muted small" }, h("code", null, message.file)),
    prose(message.doc, "No description."),
    h("h2", null, "Fields"),
    fieldsTable(message, `Fields of ${short(message.name)}`),
    h("h2", null, "Example"),
    h("pre", { tabindex: "0", "aria-label": "Example JSON" }, h("code", null, context.core.template(message.name))),
    users.length > 0 && h("h2", { id: "used-by" }, "Used by"),
    users.length > 0 &&
      h(
        "ul",
        { "aria-labelledby": "used-by" },
        users.map((user) => h("li", null, link(user))),
      ),
  ].filter((element): element is HTMLElement => element !== false);
}

export function enumPage(context: Context, enumeration: EnumDoc): HTMLElement[] {
  const users = usedBy(context.core.index, enumeration.name);
  return [
    h("p", { class: "kind" }, "Enum"),
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
              null,
              h("th", { scope: "row" }, h("code", null, value.name)),
              h("td", null, value.number),
              h("td", null, value.deprecated && badge("deprecated", "warn"), prose(value.doc)),
            ),
          ),
        ),
      ),
    ),
    users.length > 0 && h("h2", { id: "used-by" }, "Used by"),
    users.length > 0 &&
      h(
        "ul",
        { "aria-labelledby": "used-by" },
        users.map((user) => h("li", null, link(user))),
      ),
  ].filter((element): element is HTMLElement => element !== false);
}

export function missing(target: string): HTMLElement[] {
  return [
    h("h1", null, "Not found"),
    h("p", null, "This schema has nothing named ", h("code", null, target), "."),
    h(
      "p",
      null,
      "The name may have changed. Search for it, or go back to the ",
      h("a", { href: "#/" }, "overview"),
      ".",
    ),
  ];
}
