// The shell: header with the search and the environment, the navigation,
// and the page the address names.
import { href, packages, resolve, shortName, title } from "../lib/route";
import type { Hit } from "../lib/types";
import { type Page, methodPage } from "./console";
import type { Context } from "./context";
import { badge, h, replace } from "./dom";
import { environmentDialog } from "./environments";
import { enumPage, home, messagePage, missing, servicePage, useNames } from "./pages";

function hitTarget(hit: Hit): string {
  return hit.kind === "field" || hit.kind === "value" ? hit.page : hit.name;
}

export function mount(root: HTMLElement, context: Context): void {
  const { core, config } = context;
  useNames(context.short);
  const main = h("main", { id: "main", tabindex: "-1" });
  const nav = h("nav", { id: "nav", "aria-label": "Schema" });
  const dialog = environmentDialog(context);
  let page: Page | undefined;

  // ── search ───────────────────────────────────────────────────────────────
  const hits = h("ul", { id: "hits", role: "listbox", "aria-label": "Search results", hidden: true });
  const search = h("input", {
    id: "search",
    type: "search",
    role: "combobox",
    placeholder: "Search  ( / )",
    "aria-label": "Search the schema",
    "aria-controls": "hits",
    "aria-expanded": "false",
    "aria-autocomplete": "list",
    autocomplete: "off",
    spellcheck: "false",
  });
  let found: Hit[] = [];
  let active = -1;

  const showHits = (): void => {
    const open = search.value.trim() !== "";
    hits.hidden = !open;
    search.setAttribute("aria-expanded", String(open));
    if (active >= 0) search.setAttribute("aria-activedescendant", `hit-${active}`);
    else search.removeAttribute("aria-activedescendant");
    replace(
      hits,
      found.length === 0 && h("li", { class: "muted", role: "presentation" }, "Nothing matches."),
      found.map((hit, i) =>
        h(
          "li",
          {
            id: `hit-${i}`,
            role: "option",
            "aria-selected": String(i === active),
            onmousedown: (event: Event) => {
              event.preventDefault();
              go(hit);
            },
          },
          badge(hit.kind),
          " ",
          h("span", { class: "hit-name" }, hit.name),
          hit.doc !== "" && h("span", { class: "muted small" }, ` ${hit.doc}`),
        ),
      ),
    );
  };
  const closeHits = (): void => {
    search.value = "";
    found = [];
    active = -1;
    showHits();
  };
  const go = (hit: Hit): void => {
    closeHits();
    location.hash = href(hitTarget(hit));
  };
  search.addEventListener("input", () => {
    found = core.search(search.value, 12);
    active = found.length > 0 ? 0 : -1;
    showHits();
  });
  search.addEventListener("keydown", (event) => {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      if (found.length === 0) return;
      event.preventDefault();
      active = (active + (event.key === "ArrowDown" ? 1 : found.length - 1)) % found.length;
      showHits();
      document.getElementById(`hit-${active}`)?.scrollIntoView({ block: "nearest" });
    } else if (event.key === "Enter") {
      const hit = found[active];
      if (hit) {
        event.preventDefault();
        go(hit);
      }
    } else if (event.key === "Escape") {
      closeHits();
    }
  });
  search.addEventListener("blur", () => {
    hits.hidden = true;
    search.setAttribute("aria-expanded", "false");
  });
  search.addEventListener("focus", () => {
    if (search.value.trim() !== "") showHits();
  });
  document.addEventListener("keydown", (event) => {
    const typing =
      event.target instanceof HTMLElement && event.target.matches("input, textarea, select, [contenteditable]");
    if (event.key === "/" && !typing && !event.metaKey && !event.ctrlKey && !event.altKey) {
      event.preventDefault();
      search.focus();
    }
  });

  // ── header ───────────────────────────────────────────────────────────────
  const environmentButton = h("button", { type: "button", id: "environment", onclick: () => dialog.open() });
  const menuButton = h(
    "button",
    { type: "button", id: "menu", "aria-controls": "nav", "aria-expanded": "false" },
    "Menu",
  );
  menuButton.addEventListener("click", () => {
    const open = root.classList.toggle("nav-open");
    menuButton.setAttribute("aria-expanded", String(open));
  });
  const showEnvironment = (): void => {
    replace(environmentButton, "Environment: ", h("strong", null, context.environment.name));
  };
  context.onChange(showEnvironment);
  document.addEventListener("wirebook:environments", () => dialog.open());

  // ── navigation ───────────────────────────────────────────────────────────
  const item = (name: string, label: string, deprecated: boolean): HTMLElement =>
    h("li", null, h("a", { href: href(name), class: deprecated ? "deprecated" : null }, label));
  const showNav = (): void => {
    replace(
      nav,
      h("p", null, h("a", { href: "#/" }, "Overview")),
      packages(core.index).map((group) =>
        h(
          "details",
          { open: !group.imported },
          h(
            "summary",
            null,
            group.name === "" ? "(no package)" : group.name,
            group.imported && h("span", { class: "muted small" }, " imported"),
          ),
          group.services.length > 0 && h("h2", null, "Services"),
          group.services.length > 0 &&
            h(
              "ul",
              null,
              group.services.map((service) =>
                h(
                  "li",
                  null,
                  h(
                    "a",
                    { href: href(service.name), class: service.deprecated ? "deprecated" : null },
                    shortName(service.name, group.name),
                  ),
                  h(
                    "ul",
                    null,
                    service.methods.map((method) => item(method.path, method.name, method.deprecated)),
                  ),
                ),
              ),
            ),
          group.messages.length > 0 && h("h2", null, "Messages"),
          group.messages.length > 0 &&
            h(
              "ul",
              null,
              group.messages.map((m) => item(m.name, shortName(m.name, group.name), m.deprecated)),
            ),
          group.enums.length > 0 && h("h2", null, "Enums"),
          group.enums.length > 0 &&
            h(
              "ul",
              null,
              group.enums.map((e) => item(e.name, shortName(e.name, group.name), e.deprecated)),
            ),
        ),
      ),
    );
  };

  // ── pages ────────────────────────────────────────────────────────────────
  const show = (focus: boolean): void => {
    page?.dispose();
    page = undefined;
    const route = resolve(core.index, location.hash);
    document.title = title(route, config.title);
    switch (route.kind) {
      case "home":
        replace(main, home(context));
        break;
      case "service":
        replace(main, servicePage(route.service));
        break;
      case "method":
        page = methodPage(context, route.service, route.method);
        replace(main, page.elements);
        break;
      case "message":
        replace(main, messagePage(context, route.message));
        break;
      case "enum":
        replace(main, enumPage(context, route.enumeration));
        break;
      case "missing":
        replace(main, missing(route.target));
        break;
    }
    const current = location.hash === "" || location.hash === "#" ? "#/" : location.hash;
    for (const anchor of nav.querySelectorAll("a")) {
      if (anchor.getAttribute("href") === current) {
        anchor.setAttribute("aria-current", "page");
        // The page may be in a package that is folded.
        anchor.closest("details")?.setAttribute("open", "");
      } else {
        anchor.removeAttribute("aria-current");
      }
    }
    root.classList.remove("nav-open");
    menuButton.setAttribute("aria-expanded", "false");
    if (focus) {
      // A new page: start reading, and tabbing, from its top.
      main.focus({ preventScroll: true });
      window.scrollTo(0, 0);
    }
  };

  replace(
    root,
    h(
      "a",
      {
        class: "skip",
        href: "#main",
        onclick: (event: Event) => {
          event.preventDefault();
          main.focus();
        },
      },
      "Skip to the content",
    ),
    h(
      "header",
      { class: "top" },
      menuButton,
      h("a", { class: "brand", href: "#/" }, config.title),
      h("div", { class: "search", role: "search" }, search, hits),
      environmentButton,
    ),
    h("div", { class: "layout" }, nav, main),
    dialog.element,
  );
  showEnvironment();
  showNav();
  show(false);
  window.addEventListener("hashchange", () => show(true));
}
