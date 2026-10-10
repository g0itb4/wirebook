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

// With the page's own cache mode, so that the preload of each file in the
// page's head is what this reads, and the host's Cache-Control decides.
async function get(path: string): Promise<Response> {
  const response = await fetch(path);
  if (!response.ok) throw new Error(`${path} could not be loaded: HTTP ${response.status}`);
  return response;
}

async function bytes(path: string): Promise<Uint8Array> {
  return new Uint8Array(await (await get(path)).arrayBuffer());
}

const FRAMED = "This page does not run inside a frame of another site. Open it in a tab of its own.";

// The marks a speed test reads: when the script started, when every file
// was here, when the core had the schema, when the page was built.
const mark = (name: string): void => {
  performance.mark(`wirebook:${name}`);
};

async function boot(): Promise<void> {
  mark("boot");
  if (framedByAnotherSite(window)) throw new Error(FRAMED);
  const inlineConfig = inline("wirebook-config");
  const inlineSchema = inline("wirebook-schema");
  const inlineCore = inline("wirebook-core");

  // The schema and the core come down together, and the core is compiled
  // as it arrives: a Response goes to WebAssembly.instantiateStreaming.
  // The store opens meanwhile.
  const config = (inlineConfig ? JSON.parse(inlineConfig) : await (await get("config.json")).json()) as SiteConfig;
  const opening = openStore(globalThis.indexedDB, `wirebook:${config.id}:${location.pathname}`);
  const [image, wasm] = await Promise.all([
    inlineSchema ? decode(inlineSchema) : bytes("schema.binpb"),
    inlineCore ? decode(inlineCore) : get("core.wasm"),
  ]);
  mark("fetched");
  const core = await Core.load(wasm, image, { roots: config.roots, lookups: config.lookups });
  mark("core");

  // One store per site: two sites on one origin do not share environments.
  // And one per API: `wirebook serve` shows every repository at the same
  // address, and one repository's environments are not another's.
  const context = new Context(core, config, await opening);
  await context.load();
  mount(document.body, context);
  requestAnimationFrame(() => requestAnimationFrame(() => mark("painted")));

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
