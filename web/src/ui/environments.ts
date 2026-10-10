// The dialog where an environment is set: where requests go, how they
// authenticate, which headers they carry. Also the page's data: export,
// import, clear.
import {
  SCHEME_LABEL,
  type Scheme,
  isBaseUrl,
  isCredentialHeader,
  isVariableName,
  offered,
  settingFor,
} from "../lib/environments";
import { exportData, importData } from "../lib/history";
import type { AuthSetting, Environment, HeaderSpec } from "../lib/types";
import type { Context } from "./context";
import { h, replace } from "./dom";

const SECRET_LABEL: Record<Scheme, string> = {
  none: "",
  bearer: "Token",
  basic: "Password",
  "api-key": "Key",
};

export function environmentDialog(context: Context): { element: HTMLDialogElement; open(): void } {
  const form = h("form", { method: "dialog", novalidate: true });
  const element = h("dialog", { "aria-labelledby": "env-title" }, form);
  let editing: Environment;
  let headers: HeaderSpec[] = [];
  /** The variables, as rows: a name may be half typed. */
  let variables: HeaderSpec[] = [];
  let message = "";

  const blank = (): Environment => ({
    id: `env:${Date.now().toString(36)}`,
    name: "",
    baseUrl: "",
    auth: { scheme: "none" },
    headers: [],
    variables: {},
    builtin: false,
  });

  const render = (): void => {
    const picker = h(
      "select",
      { id: "env-pick" },
      context.environments.map((env) => h("option", { value: env.id, selected: env.id === editing.id }, env.name)),
      !context.environments.some((env) => env.id === editing.id) &&
        h("option", { value: editing.id, selected: true }, "New environment"),
    );
    picker.addEventListener("change", () => {
      edit(context.environments.find((env) => env.id === picker.value) ?? editing);
    });

    const name = h("input", {
      id: "env-name",
      type: "text",
      value: editing.name,
      required: true,
      readonly: editing.builtin,
      autocomplete: "off",
    });
    const baseUrl = h("input", {
      id: "env-url",
      type: "text",
      value: editing.baseUrl,
      required: true,
      inputmode: "url",
      autocomplete: "off",
      spellcheck: "false",
      placeholder: "https://api.example.com",
    });
    const scheme = h(
      "select",
      { id: "env-scheme" },
      offered(context.config).map((s) =>
        h("option", { value: s, selected: s === editing.auth.scheme }, SCHEME_LABEL[s]),
      ),
    );
    const schemeFields = h("div", null);
    // "new-password": a browser's password manager is not offered the
    // credential of an API, and does not fill in one it saved for this site.
    const secret = h("input", {
      id: "env-secret",
      type: "password",
      autocomplete: "new-password",
      spellcheck: "false",
    });
    // Set as the field's value, not as an attribute: the markup of the page
    // never holds the secret.
    secret.value = context.secrets.get(editing);
    // Pages opened from the disk share one store in some browsers: any other
    // local file could read what is kept there.
    const fromDisk = location.protocol === "file:";
    const remember = h("input", {
      id: "env-remember",
      type: "checkbox",
      checked: !fromDisk && context.secrets.isRemembered(editing),
      disabled: fromDisk,
    });
    const username = h("input", {
      id: "env-user",
      type: "text",
      autocomplete: "off",
      spellcheck: "false",
      value: editing.auth.scheme === "basic" ? editing.auth.username : "",
    });
    const keyName = h("input", {
      id: "env-key-name",
      type: "text",
      autocomplete: "off",
      spellcheck: "false",
      value: editing.auth.scheme === "api-key" ? editing.auth.name : "X-API-Key",
    });
    const keyLocation = h(
      "select",
      { id: "env-key-location" },
      h("option", { value: "header" }, "In a header"),
      h(
        "option",
        { value: "query", selected: editing.auth.scheme === "api-key" && editing.auth.location === "query" },
        "In the query string",
      ),
    );

    const showScheme = (): void => {
      const chosen = scheme.value as Scheme;
      replace(
        schemeFields,
        chosen === "basic" && h("div", { class: "field" }, h("label", { for: "env-user" }, "User name"), username),
        chosen === "api-key" &&
          h("div", { class: "field" }, h("label", { for: "env-key-name" }, "Name of the header or parameter"), keyName),
        chosen === "api-key" &&
          h(
            "div",
            { class: "field" },
            h("label", { for: "env-key-location" }, "Where the key goes"),
            keyLocation,
            h(
              "p",
              { class: "hint" },
              "A key in the query string is kept in the logs of every server on the way. Prefer a header when the API takes one.",
            ),
          ),
        chosen !== "none" &&
          h(
            "div",
            { class: "field" },
            h("label", { for: "env-secret" }, SECRET_LABEL[chosen]),
            secret,
            h("label", { class: "check" }, remember, " Remember in this browser"),
            h(
              "p",
              { class: "hint" },
              "Kept in this tab's memory, and used only for this base URL. Tick the box to store it in this browser, where any page of this site's origin can read it. It is never written to the history, to an export or to a copied command unless you ask.",
            ),
          ),
      );
    };
    scheme.addEventListener("change", () => {
      const setting = settingFor(scheme.value as Scheme, context.config);
      if (setting.scheme === "api-key") {
        keyName.value = setting.name;
        keyLocation.value = setting.location;
      }
      showScheme();
    });
    showScheme();

    /** Rows of a name and a value, with a button to add one. */
    const pairs = (rows: HeaderSpec[], what: string): HTMLElement => {
      const box = h("div", { class: "headers" });
      const show = (): void => {
        replace(
          box,
          rows.map((row, i) =>
            h(
              "div",
              { class: "row" },
              h("input", {
                type: "text",
                "aria-label": `Name of ${what} ${i + 1}`,
                placeholder: "Name",
                value: row.name,
                autocomplete: "off",
                spellcheck: "false",
                oninput: (e: Event) => {
                  row.name = (e.target as HTMLInputElement).value;
                },
              }),
              h("input", {
                type: "text",
                "aria-label": `Value of ${what} ${i + 1}`,
                placeholder: "Value",
                value: row.value,
                autocomplete: "off",
                spellcheck: "false",
                oninput: (e: Event) => {
                  row.value = (e.target as HTMLInputElement).value;
                },
              }),
              h(
                "button",
                {
                  type: "button",
                  "aria-label": `Remove ${what} ${i + 1}`,
                  onclick: () => {
                    rows.splice(i, 1);
                    show();
                  },
                },
                "Remove",
              ),
            ),
          ),
          h(
            "button",
            {
              type: "button",
              onclick: () => {
                rows.push({ name: "", value: "" });
                show();
                (box.querySelector(".row:last-of-type input") as HTMLInputElement | null)?.focus();
              },
            },
            `Add a ${what}`,
          ),
        );
      };
      show();
      return box;
    };
    const headerRows = pairs(headers, "header");
    const variableRows = pairs(variables, "variable");

    const status = h(
      "p",
      { class: message.startsWith("!") ? "bad" : "muted", role: "status" },
      message.replace(/^!/, ""),
    );
    const say = (text: string): void => {
      status.className = text.startsWith("!") ? "bad" : "muted";
      status.textContent = text.replace(/^!/, "");
    };

    const auth = (): AuthSetting => {
      switch (scheme.value as Scheme) {
        case "bearer":
          return { scheme: "bearer" };
        case "basic":
          return { scheme: "basic", username: username.value };
        case "api-key":
          return {
            scheme: "api-key",
            name: keyName.value.trim(),
            location: keyLocation.value === "query" ? "query" : "header",
          };
        default:
          return { scheme: "none" };
      }
    };

    const save = async (event: Event): Promise<void> => {
      event.preventDefault();
      if (name.value.trim() === "") return (say("!Give the environment a name."), name.focus());
      if (!isBaseUrl(baseUrl.value.trim())) {
        say(
          "!The base URL must start with http://, https:// or a single /, and hold no user name, query or backslash.",
        );
        return baseUrl.focus();
      }
      const credential = headers.find((header) => isCredentialHeader(header.name));
      if (credential) {
        return say(
          `!The header ${credential.name.trim()} is a credential. Set it under Authentication: headers are stored and exported, credentials are not.`,
        );
      }
      const named = variables.filter((variable) => variable.name.trim() !== "");
      const badName = named.find((variable) => !isVariableName(variable.name.trim()));
      if (badName) {
        return say(
          `!The variable ${badName.name.trim()} cannot be written {{…}}: use letters, digits and _, and start with a letter.`,
        );
      }
      const hidden = named.find((variable) => isCredentialHeader(variable.name));
      if (hidden) {
        return say(
          `!The variable ${hidden.name.trim()} is named like a credential. Set it under Authentication: variables are stored and exported, credentials are not.`,
        );
      }
      const saved: Environment = {
        ...editing,
        name: name.value.trim(),
        baseUrl: baseUrl.value.trim(),
        auth: auth(),
        headers: headers.filter((header) => header.name.trim() !== ""),
        variables: Object.fromEntries(named.map((variable) => [variable.name.trim(), variable.value])),
      };
      await context.store.put("environments", saved);
      await context.secrets.set(saved, saved.auth.scheme === "none" ? "" : secret.value, remember.checked);
      await context.reload();
      await context.choose(saved.id);
      element.close();
    };

    const remove = async (): Promise<void> => {
      await context.store.remove("environments", editing.id);
      await context.secrets.forget(editing.id);
      await context.reload();
      context.changed();
      message = editing.builtin ? "Back to the site's settings." : "Removed.";
      edit(context.environment);
    };

    const withBodies = h("input", { type: "checkbox", id: "env-export-bodies" });
    const keepBodies = h("input", { type: "checkbox", id: "env-keep-bodies", checked: context.keepBodies });
    keepBodies.addEventListener("change", () => void context.setKeepBodies(keepBodies.checked));
    const shortcuts = h("input", { type: "checkbox", id: "env-shortcuts", checked: context.shortcuts });
    shortcuts.addEventListener(
      "change",
      () => void context.setShortcuts(shortcuts.checked).then(() => context.changed()),
    );
    const download = async (): Promise<void> => {
      const data = await exportData(context.store, { bodies: withBodies.checked });
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      h("a", { href: url, download: "wirebook-export.json" }).click();
      URL.revokeObjectURL(url);
      say(
        withBodies.checked
          ? "Exported: environments and history with its request bodies, without credentials."
          : "Exported: environments and history, without request bodies and without credentials.",
      );
    };

    const upload = h("input", {
      type: "file",
      accept: "application/json,.json",
      id: "env-import",
      class: "visually-hidden",
    });
    upload.addEventListener("change", async () => {
      const file = upload.files?.[0];
      if (!file) return;
      try {
        const count = await importData(context.store, await file.text());
        await context.reload();
        context.changed();
        message = `Imported ${count.environments} environments and ${count.history} calls.`;
        edit(context.environment);
      } catch (error) {
        say(`!${error instanceof Error ? error.message : String(error)}`);
      }
    });

    form.onsubmit = (event) => void save(event);
    replace(
      form,
      h("h2", { id: "env-title" }, "Environment"),
      h(
        "div",
        { class: "row" },
        h("div", { class: "field grow" }, h("label", { for: "env-pick" }, "Edit"), picker),
        h(
          "button",
          {
            type: "button",
            onclick: () => {
              message = "";
              edit(blank());
            },
          },
          "New",
        ),
      ),
      h(
        "div",
        { class: "grid2" },
        h(
          "div",
          { class: "field" },
          h("label", { for: "env-name" }, "Name"),
          name,
          editing.builtin && h("p", { class: "hint" }, "This environment comes with the site."),
        ),
        h(
          "div",
          { class: "field" },
          h("label", { for: "env-url" }, "Base URL"),
          baseUrl,
          h("p", { class: "hint" }, "Where the API listens. A path such as /proxy stays on this origin."),
        ),
      ),
      h("div", { class: "field" }, h("label", { for: "env-scheme" }, "Authentication"), scheme),
      schemeFields,
      h(
        "div",
        { class: "grid2" },
        h(
          "fieldset",
          null,
          h("legend", null, "Headers sent with every request"),
          h(
            "p",
            { class: "hint" },
            "Stored in this browser and included in an export. Not the place for a credential.",
          ),
          headerRows,
        ),
        h(
          "fieldset",
          null,
          h("legend", null, "Variables"),
          h(
            "p",
            { class: "hint" },
            "Written {{name}} in a body's text values and in header values. A field named as a variable starts with it. Stored and exported: not the place for a credential.",
          ),
          variableRows,
        ),
      ),
      status,
      h(
        "div",
        { class: "row" },
        h("button", { type: "submit", class: "primary" }, "Save and use"),
        h("button", { type: "button", onclick: () => element.close() }, "Close"),
        h(
          "button",
          { type: "button", onclick: () => void remove() },
          editing.builtin ? "Reset to the site's settings" : "Delete",
        ),
      ),
      h("hr"),
      h(
        "section",
        { class: "browser", "aria-labelledby": "browser-head" },
        h("h3", { id: "browser-head" }, "This browser"),
        h(
          "p",
          { class: "hint" },
          "Environments and the history of calls are kept in this browser only. A request body is kept without the fields its schema marks as sensitive; what else you typed into it is kept as typed.",
        ),
        h(
          "p",
          null,
          h(
            "label",
            { class: "check" },
            shortcuts,
            " Keyboard shortcuts of one key ( / for search; ⌘K or Ctrl K always work)",
          ),
        ),
        h("p", null, h("label", { class: "check" }, keepBodies, " Keep request bodies in the history")),
        h("p", null, h("label", { class: "check" }, withBodies, " Include request bodies in an export")),
        h(
          "div",
          { class: "row" },
          h("button", { type: "button", onclick: () => void download() }, "Export"),
          h("label", { for: "env-import", class: "button" }, "Import"),
          upload,
          h(
            "button",
            {
              type: "button",
              class: "ghost",
              onclick: () =>
                void context.store.clear("history").then(() => {
                  context.changed();
                  say("History cleared.");
                }),
            },
            "Clear the history",
          ),
        ),
      ),
    );
  };

  const edit = (environment: Environment): void => {
    editing = structuredClone(environment);
    headers = structuredClone(environment.headers);
    variables = Object.entries(environment.variables).map(([name, value]) => ({ name, value }));
    render();
  };

  // Closed, the dialog holds nothing: no field with a secret stays in the
  // page for the life of the tab.
  element.addEventListener("close", () => form.replaceChildren());

  return {
    element,
    open() {
      message = "";
      edit(context.environment);
      element.showModal();
    },
  };
}
