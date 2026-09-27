// What the unit tests share: the core, loaded from the built module and the
// fixture image, as the page loads it.
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { Core } from "./core";
import type { Environment, RequestSpec, SiteConfig } from "./types";

const root = join(import.meta.dir, "../../..");

export const ROOTS = [
  "fixture/v1/editions.proto",
  "fixture/v1/library.proto",
  "fixture/legacy/v1/proto3.proto",
  "fixture/legacy/v1/proto2.proto",
];

const loaded = await Core.load(
  readFileSync(join(root, "web/src/gen/core_bg.wasm")),
  new Uint8Array(readFileSync(join(root, "testdata/fixture.binpb"))),
  ROOTS,
);

export function core(): Core {
  return loaded;
}

export function config(overrides: Partial<SiteConfig> = {}): SiteConfig {
  return { id: "fixture", title: "Fixture", roots: ROOTS, environments: [], auth: [], liveReload: false, ...overrides };
}

export function spec(overrides: Partial<RequestSpec> = {}): RequestSpec {
  return {
    method: "fixture.v1.WidgetService/GetWidget",
    body: '{"id":"w1"}',
    transport: "connect-json",
    baseUrl: "http://api.test",
    headers: [],
    auth: { scheme: "none" },
    binding: 0,
    timeoutMs: null,
    ...overrides,
  };
}

export function environment(overrides: Partial<Environment> = {}): Environment {
  return {
    id: "builtin:local",
    name: "local",
    baseUrl: "http://api.test",
    auth: { scheme: "none" },
    headers: [],
    builtin: true,
    ...overrides,
  };
}
