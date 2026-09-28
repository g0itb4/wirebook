// Start: the site's config, the descriptor set and the core, then the page.
// A site is either a directory, with the three next to the page, or a single
// file, with them inside it.
import { Core } from "./lib/core";
import { framedByAnotherSite } from "./lib/guard";
import { openStore } from "./lib/store";
import type { SiteConfig } from "./lib/types";
import { mount } from "./ui/app";
import { Context } from "./ui/context";

function inline(id: string): string | undefined {
  return document.getElementById(id)?.textContent ?? undefined;
}

function decode(base64: string): Uint8Array {
  const binary = atob(base64.trim());
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

async function get(path: string): Promise<Response> {
  const response = await fetch(path, { cache: "no-cache" });
  if (!response.ok) throw new Error(`${path} could not be loaded: HTTP ${response.status}`);
  return response;
}

const FRAMED = "This page does not run inside a frame of another site. Open it in a tab of its own.";

async function boot(): Promise<void> {
  if (framedByAnotherSite(window)) throw new Error(FRAMED);
  const inlineConfig = inline("wirebook-config");
  const inlineSchema = inline("wirebook-schema");
  const inlineCore = inline("wirebook-core");

  const config = (inlineConfig ? JSON.parse(inlineConfig) : await (await get("config.json")).json()) as SiteConfig;
  const image = inlineSchema ? decode(inlineSchema) : new Uint8Array(await (await get("schema.binpb")).arrayBuffer());
  const wasm = inlineCore ? decode(inlineCore) : await (await get("core.wasm")).arrayBuffer();
  const core = await Core.load(wasm as BufferSource, image, config.roots);

  // One store per site: two sites on one origin do not share environments.
  // And one per API: `wirebook serve` shows every repository at the same
  // address, and one repository's environments are not another's.
  const store = await openStore(globalThis.indexedDB, `wirebook:${config.id}:${location.pathname}`);
  const context = new Context(core, config, store);
  await context.load();
  mount(document.body, context);

  if (config.liveReload) {
    new EventSource("events").addEventListener("reload", () => location.reload());
  }
}

boot().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  const main = document.createElement("main");
  main.className = "fatal";
  const heading = document.createElement("h1");
  heading.textContent = "The schema could not be loaded";
  const detail = document.createElement("p");
  detail.textContent = message;
  const hint = document.createElement("p");
  hint.textContent =
    message === FRAMED
      ? ""
      : location.protocol === "file:"
        ? "A site built as a directory needs a web server. Run `wirebook serve`, or build one file with the buf plugin."
        : "Check that config.json, schema.binpb and core.wasm are next to this page.";
  main.append(heading, detail, hint);
  document.body.replaceChildren(main);
});
