// A page built with the DOM's own calls. Text reaches the page only as text
// nodes, never as markup: a comment in a proto file cannot inject anything.
import { type Language, tokens } from "../lib/highlight";

type Child = Node | string | number | null | undefined | false;
type Attributes = Record<string, string | number | boolean | null | undefined | ((event: Event) => void)>;

export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attributes?: Attributes | null,
  ...children: (Child | Child[])[]
): HTMLElementTagNameMap[K] {
  const element = document.createElement(tag);
  for (const [name, value] of Object.entries(attributes ?? {})) {
    if (value === null || value === undefined || value === false) continue;
    if (typeof value === "function") element.addEventListener(name.replace(/^on/, ""), value);
    else element.setAttribute(name, value === true ? "" : String(value));
  }
  append(element, children);
  return element;
}

export function append(parent: Node, children: (Child | Child[])[]): void {
  for (const child of children.flat()) {
    if (child === null || child === undefined || child === false) continue;
    parent.appendChild(child instanceof Node ? child : document.createTextNode(String(child)));
  }
}

export function replace(parent: Element, ...children: (Child | Child[])[]): void {
  parent.replaceChildren();
  append(parent, children);
}

/** A comment from a proto file: paragraphs at blank lines, as plain text. */
export function prose(text: string, fallback?: string): HTMLElement {
  if (text.trim() === "") {
    return h("p", { class: "doc muted" }, fallback ?? "");
  }
  return h(
    "div",
    { class: "doc" },
    text.split(/\n\s*\n/).map((paragraph) => h("p", null, paragraph)),
  );
}

/** Code, with its pieces told apart by lightness: a `code` element of spans. */
export function code(text: string, language: Language): HTMLElement {
  return h(
    "code",
    null,
    tokens(text, language).map((token) =>
      token.kind === "text" ? token.text : h("span", { class: `tk-${token.kind}` }, token.text),
    ),
  );
}

export function badge(text: string, kind = ""): HTMLElement {
  return h("span", { class: `badge ${kind}`.trim() }, text);
}

export function pretty(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

export function bytes(size: number): string {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} kB`;
  return `${(size / 1024 / 1024).toFixed(1)} MB`;
}

/** The most text one block shows. More than this, and the page stops answering. */
export const MAX_SHOWN = 500_000;

export function clip(text: string): string {
  if (text.length <= MAX_SHOWN) return text;
  return `${text.slice(0, MAX_SHOWN)}\n… ${text.length - MAX_SHOWN} more characters are not shown.`;
}
