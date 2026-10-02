// Pick a real id: the list a field's schema points to, called on a click,
// shown under the field. Ids seen in earlier responses are offered at once,
// without a call.
import { toAuth } from "../lib/environments";
import type { Listing } from "../lib/lookup";
import type { FieldDoc, Item } from "../lib/types";
import type { Context } from "./context";
import { h, replace } from "./dom";

export interface PickerOptions {
  /** `package.Message.field`: the key the core knows the field by. */
  key: string;
  field: FieldDoc;
  /** What is known around the field, by JSON name. */
  context: () => Record<string, unknown>;
  onPick: (id: string) => void;
}

/** The button that opens the list, and the box the list appears in. */
export function picker(context: Context, options: PickerOptions): { button: HTMLElement; panel: HTMLElement } {
  const reference = options.field.reference!;
  const method = reference.method.split("/")[1]!;
  const panel = h("div", { class: "picker", hidden: true });
  const button = h(
    "button",
    { type: "button", "aria-expanded": "false", "aria-label": `Pick ${options.field.jsonName} from ${method}` },
    "pick",
  );
  let filter = "";
  let failure = "";
  let busy = false;

  const close = (): void => {
    panel.hidden = true;
    button.setAttribute("aria-expanded", "false");
  };

  const choose = (item: Item): void => {
    options.onPick(item.id);
    close();
    button.focus();
  };

  const row = (item: Item): HTMLElement =>
    h(
      "li",
      {
        role: "option",
        tabindex: "0",
        "aria-selected": "false",
        onclick: () => choose(item),
        onkeydown: (event: Event) => {
          const key = (event as KeyboardEvent).key;
          if (key === "Enter" || key === " ") {
            event.preventDefault();
            choose(item);
          }
        },
      },
      h("span", null, item.id),
      item.label !== "" && h("span", { class: "muted" }, item.label),
    );

  const matches = (item: Item): boolean =>
    filter === "" || `${item.id} ${item.label}`.toLowerCase().includes(filter.toLowerCase());

  const render = (): void => {
    const environment = context.environment;
    const listing: Listing | undefined = context.lookups.cached(options.key, options.context(), environment);
    const listed = listing?.items ?? [];
    // Seen in responses, and not in the list already.
    const seen = context.lookups
      .seen(reference.resource, environment)
      .filter((item) => !listed.some((other) => other.id === item.id));
    const shown = [...listed, ...seen].filter(matches);
    const input = h("input", {
      type: "text",
      "aria-label": `Filter ${method}`,
      placeholder: "filter",
      value: filter,
      autocomplete: "off",
      spellcheck: "false",
    });
    input.addEventListener("input", () => {
      filter = input.value;
      render();
      (panel.querySelector("input") as HTMLInputElement | null)?.focus();
    });
    replace(
      panel,
      h(
        "div",
        { class: "row" },
        input,
        h("button", { type: "button", onclick: () => void load(false), disabled: busy }, listing ? "refresh" : "list"),
        listing?.next && h("button", { type: "button", onclick: () => void load(true), disabled: busy }, "more"),
        h("button", { type: "button", onclick: close }, "close"),
      ),
      h(
        "p",
        { class: failure ? "row bad" : "row muted", role: "status" },
        busy
          ? `Calling ${method}…`
          : failure ||
              (listing
                ? `${listed.length} from ${method}${listing.next ? ", more to fetch" : ""}.`
                : seen.length > 0
                  ? `${seen.length} seen in responses. "list" calls ${method}.`
                  : `Nothing yet from ${method}.`),
      ),
      shown.length > 0 &&
        h("ul", { role: "listbox", "aria-label": `${short(reference.resource)} to pick from` }, shown.map(row)),
    );
  };

  const load = async (more: boolean): Promise<void> => {
    const environment = context.environment;
    busy = true;
    failure = "";
    render();
    try {
      await context.lookups.fetch(
        options.key,
        options.context(),
        environment,
        toAuth(environment.auth, context.secrets.get(environment)),
        { fetch: globalThis.fetch.bind(globalThis), now: () => performance.now(), pageUrl: location.href },
        more,
      );
    } catch (error) {
      failure = error instanceof Error ? error.message : String(error);
    }
    busy = false;
    render();
  };

  button.addEventListener("click", () => {
    if (!panel.hidden) return close();
    panel.hidden = false;
    button.setAttribute("aria-expanded", "true");
    failure = "";
    filter = "";
    // The click is the consent: the list is called now. Unless there is
    // something to show already: the list as it was, or ids seen go by.
    const known =
      context.lookups.cached(options.key, options.context(), context.environment) !== undefined ||
      context.lookups.seen(reference.resource, context.environment).length > 0;
    if (known) render();
    else void load(false);
  });

  return { button, panel };
}

function short(fullName: string): string {
  return fullName.slice(fullName.lastIndexOf(".") + 1);
}
