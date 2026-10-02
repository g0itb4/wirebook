// The body as a form: one control per field, drawn from the schema. It is a
// view of the JSON text; each edit writes the value back, and the console
// validates the text as before.
import {
  type Path,
  type Widget,
  fromInput,
  getAt,
  initial,
  messageOf,
  oneofs,
  pathKey,
  setAt,
  widgetFor,
} from "../lib/form";
import type { FieldDoc, Index, MessageDoc, Violation } from "../lib/types";
import type { Context } from "./context";
import { badge, h, replace } from "./dom";
import { picker } from "./picker";

export interface FormOptions {
  message: MessageDoc;
  /** The body, as a value. */
  value: () => unknown;
  /** Write a new body. `redraw` when its shape changed, not only a value. */
  commit: (next: unknown, redraw: boolean) => void;
}

export interface Form {
  element: HTMLElement;
  /** Draw the form again from the body. */
  draw(): void;
  /** Show the warnings at their fields. Returns those that have no field here. */
  warn(violations: Violation[]): Violation[];
}

/** How a well-known type is written, shown where nothing is typed yet. */
const WRITTEN: Record<string, string> = {
  "google.protobuf.Timestamp": "2026-01-02T15:04:05Z",
  "google.protobuf.Duration": "1.5s",
  "google.protobuf.FieldMask": "title,labels",
};

/** An id for the control at a path: the same one after the form is drawn again. */
function idOf(path: Path): string {
  return `f-${path.map((key) => encodeURIComponent(String(key)).replaceAll(".", "%2E")).join(".")}`;
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

export function form(context: Context, options: FormOptions): Form {
  const index: Index = context.core.index;
  const element = h("div", { class: "form" });
  /** Where each field's warnings go, by its path as the core writes it. */
  const warnings = new Map<string, HTMLElement>();

  const write = (path: Path, next: unknown, redraw = false, focus?: string): void => {
    options.commit(setAt(options.value(), path, next), redraw);
    if (focus !== undefined) document.getElementById(focus)?.focus();
  };

  /** One value: of a field, of an item of a list, of an entry of a map. */
  const control = (owner: MessageDoc, field: FieldDoc, path: Path, id: string, label: string): HTMLElement[] => {
    const widget: Widget = widgetFor(field);
    const value = getAt(options.value(), path);
    const common = { id, "aria-label": label, "aria-describedby": `${idOf(path)}-warn` };
    if (widget === "checkbox") {
      const select = h(
        "select",
        common,
        h("option", { value: "" }, "—"),
        h("option", { value: "true", selected: value === true }, "true"),
        h("option", { value: "false", selected: value === false }, "false"),
      );
      select.addEventListener("change", () => write(path, select.value === "" ? undefined : select.value === "true"));
      return [select];
    }
    if (widget === "enum") {
      const values = index.enums.find((enumeration) => enumeration.name === field.type)?.values ?? [];
      const select = h(
        "select",
        common,
        h("option", { value: "" }, "—"),
        values.map((v) => h("option", { value: v.name, selected: value === v.name }, v.name)),
        // A number the enum does not name, as an open enum may hold.
        typeof value === "number" && h("option", { value: String(value), selected: true }, String(value)),
      );
      select.addEventListener("change", () =>
        write(
          path,
          select.value === "" ? undefined : /^-?\d+$/.test(select.value) ? Number(select.value) : select.value,
        ),
      );
      return [select];
    }
    if (widget === "json") {
      const box = h("textarea", { ...common, rows: 3, spellcheck: "false" });
      box.value = value === undefined ? "" : JSON.stringify(value, null, 2);
      box.addEventListener("input", () => {
        if (box.value.trim() === "") return write(path, undefined);
        try {
          write(path, JSON.parse(box.value));
          box.removeAttribute("aria-invalid");
        } catch {
          // Not JSON yet: the body keeps what it had.
          box.setAttribute("aria-invalid", "true");
        }
      });
      return [box];
    }
    const input = h("input", {
      ...common,
      type: "text",
      autocomplete: "off",
      spellcheck: "false",
      inputmode: widget === "number" || widget === "digits" ? "decimal" : null,
      placeholder:
        field.example !== null && field.example !== undefined ? String(field.example) : (WRITTEN[field.type] ?? null),
    });
    input.value = value === undefined || value === null ? "" : String(value);
    input.addEventListener("input", () => write(path, fromInput(widget, input.value)));
    if (field.reference === null) return [input];

    // A field that names a resource: pick one from its list.
    const pick = picker(context, {
      key: `${owner.name}.${field.name}`,
      field,
      // What is around the field, over the top of the body, over the variables.
      context: () => ({
        ...context.environment.variables,
        ...asRecord(options.value()),
        ...asRecord(getAt(options.value(), path.slice(0, -1))),
      }),
      onPick: (picked) => {
        input.value = picked;
        write(path, picked);
      },
    });
    // The list opens under the field, over its whole width.
    return [h("div", { class: "f-pick" }, h("div", { class: "f-control" }, input, pick.button), pick.panel)];
  };

  const typeLabel = (field: FieldDoc): string => {
    const name = field.kind === "scalar" ? field.type : context.short(field.type);
    if (field.cardinality === "repeated") return `repeated ${name}`;
    if (field.cardinality === "map") return `map<${field.mapKey}, ${name}>`;
    return name;
  };

  const row = (owner: MessageDoc, field: FieldDoc, path: Path, mapAt: number[]): HTMLElement => {
    const id = idOf(path);
    const warning = h("p", { class: "f-warn", id: `${id}-warn`, role: "status" });
    warnings.set(pathKey(path, mapAt), warning);
    const rules = field.rules.filter((rule) => rule !== "required");
    const value = getAt(options.value(), path);
    const nested = widgetFor(field) === "message";
    // One control has a label. A list, a map or a message has a name, and
    // each of its controls says what it is.
    const single = field.cardinality === "singular" && !nested;
    const head = h(
      "div",
      { class: "f-head" },
      single ? h("label", { for: id }, field.jsonName) : h("span", { class: "f-name" }, field.jsonName),
      h("span", { class: "f-type" }, typeLabel(field)),
      (field.required || field.presence === "required") && badge("required", "write"),
      rules.length > 0 && h("span", { class: "f-type" }, rules.join(" · ")),
    );
    let body: (HTMLElement | false)[];

    if (field.cardinality === "repeated") {
      const items = Array.isArray(value) ? value : [];
      body = [
        ...items.map((_, i) => {
          const at = [...path, i];
          const label = `${field.jsonName} ${i + 1}`;
          return h(
            "div",
            { class: nested ? "f-item" : "f-control" },
            nested ? group(field, at, mapAt, label) : control(owner, field, at, idOf(at), label),
            h(
              "button",
              { type: "button", "aria-label": `Remove ${label}`, onclick: () => write(at, undefined, true, id) },
              "×",
            ),
          );
        }),
        h(
          "button",
          { type: "button", id, onclick: () => write([...path, items.length], initial(index, field), true) },
          `+ ${field.jsonName}`,
        ),
      ];
    } else if (field.cardinality === "map") {
      const held = asRecord(value);
      const entries = Object.keys(held);
      body = [
        ...entries.map((entry, i) => {
          const at = [...path, entry];
          const name = h("input", {
            id: `${id}-key-${i}`,
            type: "text",
            value: entry,
            "aria-label": `Key ${i + 1} of ${field.jsonName}`,
            autocomplete: "off",
            spellcheck: "false",
          });
          // A key that changes is another entry, at the same place.
          name.addEventListener("change", () => {
            if (name.value === "" || (name.value !== entry && name.value in held)) return void (name.value = entry);
            const renamed = Object.fromEntries(entries.map((key) => [key === entry ? name.value : key, held[key]]));
            options.commit(setAt(options.value(), path, renamed), true);
          });
          return h(
            "div",
            { class: nested ? "f-item" : "f-control" },
            name,
            nested
              ? group(field, at, [...mapAt, at.length - 1], `${field.jsonName} ${entry}`)
              : control(owner, field, at, idOf(at), `Value of ${entry} in ${field.jsonName}`),
            h(
              "button",
              {
                type: "button",
                "aria-label": `Remove ${entry} from ${field.jsonName}`,
                onclick: () => write(at, undefined, true, id),
              },
              "×",
            ),
          );
        }),
        h(
          "button",
          {
            type: "button",
            id,
            onclick: () => {
              let name = "key";
              for (let n = 2; entries.includes(name); n++) name = `key${n}`;
              write([...path, name], initial(index, field), true);
            },
          },
          `+ ${field.jsonName}`,
        ),
      ];
    } else if (nested) {
      body = [group(field, path, mapAt, field.jsonName, id)];
    } else {
      body = [h("div", { class: "f-control" }, control(owner, field, path, id, field.jsonName))];
    }
    return h("div", { class: "f" }, head, body, warning);
  };

  /** A message inside the body: a button to put it there, then its fields. */
  const group = (field: FieldDoc, path: Path, mapAt: number[], label: string, id?: string): HTMLElement => {
    const message = messageOf(index, field.type);
    if (getAt(options.value(), path) === undefined || !message) {
      return h("button", { type: "button", id: id ?? null, onclick: () => write(path, {}, true) }, `+ ${label}`);
    }
    return h(
      "div",
      { class: "f-nested", role: "group", "aria-label": label },
      fields(message, path, mapAt),
      // An item of a list or a map has its own button to remove it.
      id !== undefined &&
        h("button", { type: "button", id, onclick: () => write(path, undefined, true) }, `× ${label}`),
    );
  };

  /** The fields of a message. Of a oneof: a chooser, and the member chosen. */
  const fields = (message: MessageDoc, path: Path, mapAt: number[]): HTMLElement[] => {
    const groups = oneofs(message);
    const out: HTMLElement[] = [];
    const done = new Set<string>();
    for (const field of message.fields) {
      if (field.oneof === null) {
        out.push(row(message, field, [...path, field.jsonName], mapAt));
        continue;
      }
      if (done.has(field.oneof)) continue;
      done.add(field.oneof);
      const members = groups.get(field.oneof)!;
      const held = asRecord(getAt(options.value(), path));
      const chosen = members.find((member) => member.jsonName in held);
      const id = `${idOf([...path, field.oneof])}-oneof`;
      const select = h(
        "select",
        { id },
        h("option", { value: "" }, "—"),
        members.map((member) => h("option", { value: member.jsonName, selected: member === chosen }, member.jsonName)),
      );
      select.addEventListener("change", () => {
        // Only one member of a oneof may be set: the others go.
        let next = options.value();
        for (const member of members) next = setAt(next, [...path, member.jsonName], undefined);
        const pick = members.find((member) => member.jsonName === select.value);
        if (pick) next = setAt(next, [...path, pick.jsonName], initial(index, pick));
        options.commit(next, true);
      });
      out.push(
        h(
          "div",
          { class: "f" },
          h("div", { class: "f-head" }, h("label", { for: id }, field.oneof), h("span", { class: "f-type" }, "one of")),
          h("div", { class: "f-control" }, select),
          chosen ? h("div", { class: "f-nested" }, row(message, chosen, [...path, chosen.jsonName], mapAt)) : false,
        ),
      );
    }
    return out;
  };

  return {
    element,
    draw() {
      // Drawn again, the control that had the focus keeps it.
      const focused = element.contains(document.activeElement) ? document.activeElement?.id : undefined;
      warnings.clear();
      replace(
        element,
        options.message.fields.length === 0
          ? h("p", { class: "muted" }, "This request has no fields.")
          : fields(options.message, [], []),
      );
      if (focused) document.getElementById(focused)?.focus();
    },
    warn(violations) {
      for (const warning of warnings.values()) warning.textContent = "";
      return violations.filter((violation) => {
        const at = warnings.get(violation.path);
        if (!at) return true;
        at.textContent = at.textContent ? `${at.textContent} · ${violation.message}` : violation.message;
        return false;
      });
    },
  };
}
