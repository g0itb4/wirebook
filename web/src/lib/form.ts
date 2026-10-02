// The form is a second view of the body. The body stays one JSON text, which
// is what the core validates and sends; the form reads a value out of it and
// writes one back. Nothing here knows the DOM.
import type { FieldDoc, Index, MessageDoc } from "./types";

export type Path = (string | number)[];

/** The body as a value, or `undefined` when it is not JSON yet. */
export function parseBody(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

export function stringify(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** The value at a path, or `undefined` when nothing is there. */
export function getAt(value: unknown, path: Path): unknown {
  let at = value;
  for (const key of path) {
    if (Array.isArray(at) && typeof key === "number") at = at[key];
    else if (isObject(at) && typeof key === "string") at = at[key];
    else return undefined;
  }
  return at;
}

/**
 * A copy of `value` with `next` at `path`; `undefined` takes the field or
 * the item away. What is on the way and missing is made: an object for a
 * name, a list for a number.
 */
export function setAt(value: unknown, path: Path, next: unknown): unknown {
  const [key, ...rest] = path;
  if (key === undefined) return next;
  if (typeof key === "number") {
    const list = Array.isArray(value) ? [...(value as unknown[])] : [];
    if (rest.length === 0 && next === undefined) list.splice(key, 1);
    else list[key] = setAt(list[key], rest, next);
    return list;
  }
  const object: Record<string, unknown> = isObject(value) ? { ...value } : {};
  if (rest.length === 0 && next === undefined) delete object[key];
  else object[key] = setAt(object[key], rest, next);
  return object;
}

/** A path as the core writes it in a warning: `gadget.bundle[0].title`, `labels["a"]`. */
export function pathKey(path: Path, mapAt: number[] = []): string {
  let out = "";
  path.forEach((key, i) => {
    if (typeof key === "number") out += `[${key}]`;
    else if (mapAt.includes(i)) out += `[${JSON.stringify(key)}]`;
    else out += out === "" ? key : `.${key}`;
  });
  return out;
}

/** How a field is edited. */
export type Widget =
  | "text"
  | "number"
  /** A 64-bit number: text in JSON, digits to the person. */
  | "digits"
  | "checkbox"
  | "enum"
  /** A well-known type that is a text in JSON: a time, a duration, a field mask. */
  | "known-text"
  | "message"
  /** No form for it: a box of JSON for that field alone. */
  | "json";

const DIGITS = ["int64", "uint64", "sint64", "fixed64", "sfixed64"];
const KNOWN_TEXT = ["Timestamp", "Duration", "FieldMask", "StringValue", "BytesValue", "Int64Value", "UInt64Value"];
const KNOWN_NUMBER = ["DoubleValue", "FloatValue", "Int32Value", "UInt32Value"];

/** The widget for one value of a field: an item of a list, a value of a map. */
export function widgetFor(field: FieldDoc): Widget {
  if (field.kind === "enum") return "enum";
  if (field.kind === "scalar") {
    if (field.type === "bool") return "checkbox";
    if (field.type === "string" || field.type === "bytes") return "text";
    return DIGITS.includes(field.type) ? "digits" : "number";
  }
  const known = field.type.startsWith("google.protobuf.") ? field.type.slice("google.protobuf.".length) : "";
  if (KNOWN_TEXT.includes(known)) return "known-text";
  if (KNOWN_NUMBER.includes(known)) return "number";
  if (known === "BoolValue") return "checkbox";
  // Any, Struct, Value, ListValue, Empty: whatever JSON they hold.
  return known === "" ? "message" : "json";
}

/** What a person typed into a widget, as the JSON value it stands for. */
export function fromInput(widget: Widget, raw: string): unknown {
  if (raw === "") return undefined;
  if (widget !== "number") return raw;
  const number = Number(raw);
  // "Infinity" and "NaN" are how proto JSON writes them: as text.
  return Number.isFinite(number) ? number : raw;
}

export function messageOf(index: Index, name: string): MessageDoc | undefined {
  return index.messages.find((message) => message.name === name);
}

/** The value a new item of a list, or a field switched on, starts with. */
export function initial(index: Index, field: FieldDoc): unknown {
  switch (widgetFor(field)) {
    case "checkbox":
      return false;
    case "number":
      return 0;
    case "digits":
      return "0";
    case "enum":
      return index.enums.find((enumeration) => enumeration.name === field.type)?.values[0]?.name ?? 0;
    case "message":
      return {};
    case "json":
      return null;
    default:
      return "";
  }
}

/** The members of each oneof of a message, by the oneof's name. */
export function oneofs(message: MessageDoc): Map<string, FieldDoc[]> {
  const out = new Map<string, FieldDoc[]>();
  for (const field of message.fields) {
    if (field.oneof === null) continue;
    out.set(field.oneof, [...(out.get(field.oneof) ?? []), field]);
  }
  return out;
}
