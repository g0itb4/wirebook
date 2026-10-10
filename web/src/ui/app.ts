// The shell: header with the search and the environment, the navigation,
// and the page the address names, in one pane or two.
import { href, packages, resolve, shortName, title } from "../lib/route";
import type { Hit } from "../lib/types";
import { type Page, methodPage } from "./console";
import type { Context } from "./context";
import { badge, h, replace } from "./dom";
import { environmentDialog } from "./environments";
import { type Panes, enumPage, home, kindOf, messagePage, missing, servicePage, useNames } from "./pages";

/** Where wirebook lives. Every site says so, in its footer. */
const REPO = "https://github.com/g0itb4/wirebook";

function hitTarget(hit: Hit): string {
  return hit.kind === "field" || hit.kind === "value" ? hit.page : hit.name;
}

export function mount(root: HTMLElement, context: Context): void {
  const { core, config } = context;
  useNames(context.short);
  const main = h("main", { id: "main", tabindex: "-1" });
  const reference = h("div", { class: "pane" });
  const side = h("section", { class: "pane side", "aria-label": "Console and examples" });
  // The footer: who made the page, and the site's own links. A link is
  // text and an href; the config refused anything but https.
  const foot = h(
    "footer",
    { class: "foot" },
    h("span", null, "Built with ", h("a", { href: REPO, rel: "noopener" }, "wirebook on GitHub")),
    config.links
      .filter((link) => link.url.startsWith("https://"))
      .map((link) => h("a", { href: link.url, rel: "noopener" }, link.label)),
  );
  const nav = h("nav", { id: "nav", "aria-label": "Schema" });
  const dialog = environmentDialog(context);
  let page: Page | undefined;

  // ── search ───────────────────────────────────────────────────────────────
  const hits = h("ul", { id: "hits", role: "listbox", "aria-label": "Search results", hidden: true });
  const search = h("input", {
    id: "search",
    type: "search",
    role: "combobox",
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
    // A key alone can be set off by speech input: a setting turns it off.
    if (!context.shortcuts) return;
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
    const environment = context.environment;
    const unset = environment.auth.scheme !== "none" && context.secrets.get(environment) === "";
    replace(
      environmentButton,
      "Environment: ",
      h("strong", null, environment.name),
      // Filled: ready to send. Hollow: a credential is still to be set.
      h("span", { class: unset ? "dot unset" : "dot", "aria-hidden": "true" }),
      unset && h("span", { class: "visually-hidden" }, ", no credential yet"),
    );
    search.placeholder = context.shortcuts ? "Search  ( / )" : "Search";
  };
  context.onChange(showEnvironment);
  document.addEventListener("wirebook:environments", () => dialog.open());

  // ── navigation ───────────────────────────────────────────────────────────
  const item = (name: string, label: string, deprecated: boolean, tag?: HTMLElement): HTMLElement =>
    h("li", null, h("a", { href: href(name), class: deprecated ? "deprecated" : null }, tag, h("span", null, label)));
  // What a method does, before its name: R reads, W writes, S streams.
  const tag = (kind: { word: string; letter: string; colour: string }): HTMLElement =>
    h("span", { class: `tag ${kind.colour}`, title: kind.word, "aria-hidden": "true" }, kind.letter);
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
                    service.methods.map((method) =>
                      item(method.path, method.name, method.deprecated, tag(kindOf(method))),
                    ),
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
    let panes: Panes;
    switch (route.kind) {
      case "home":
        panes = home(context);
        break;
      case "service":
        panes = servicePage(route.service);
        break;
      case "method":
        page = methodPage(context, route.service, route.method);
        panes = page.panes;
        break;
      case "message":
        panes = messagePage(context, route.message);
        break;
      case "enum":
        panes = enumPage(context, route.enumeration);
        break;
      case "missing":
        panes = missing(route.target);
        break;
    }
    replace(reference, panes.reference);
    replace(side, panes.side ?? []);
    side.hidden = panes.side === undefined;
    main.classList.toggle("split", panes.side !== undefined);
    side.scrollTop = 0;
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
  main.append(reference, side, foot);
  showEnvironment();
  showNav();
  show(false);
  window.addEventListener("hashchange", () => show(true));
}
