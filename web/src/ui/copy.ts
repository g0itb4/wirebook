// A block of output with a button that copies it. The button says what it
// copies, and says when it has; when the clipboard refuses, it says what to
// do instead.
import { h } from "./dom";

export function copyButton(label: string, text: () => string): HTMLElement {
  const status = h("span", { class: "visually-hidden", role: "status" });
  const button: HTMLButtonElement = h(
    "button",
    {
      type: "button",
      class: "ghost copy",
      "aria-label": `Copy ${label}`,
      onclick: () => void copy(),
    },
    "Copy",
    status,
  );
  let timer: ReturnType<typeof setTimeout> | undefined;
  const say = (word: string, announce: string): void => {
    button.firstChild!.textContent = word;
    status.textContent = announce;
    clearTimeout(timer);
    timer = setTimeout(() => {
      button.firstChild!.textContent = "Copy";
      status.textContent = "";
    }, 1_500);
  };
  const copy = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(text());
      say("Copied", `Copied ${label}.`);
    } catch {
      say("Select it", "The clipboard refused: select the text to copy it.");
    }
  };
  return button;
}

/** A `pre` with its copy button in the corner. */
export function block(label: string, pre: HTMLElement, text: () => string): HTMLElement {
  return h("div", { class: "block" }, pre, copyButton(label, text));
}
