import { expect, test } from "bun:test";

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { Core } from "./core";
import { core, spec } from "./testing";

test("the page reads the same index the core built", () => {
  const { index } = core();
  expect(index.files.find((file) => file.name === "fixture/v1/editions.proto")).toEqual({
    name: "fixture/v1/editions.proto",
    package: "fixture.v1",
    edition: "2024",
    imported: false,
  });
  expect(index.files.find((file) => file.name === "google/api/http.proto")?.imported).toBe(true);
});

test("search, template and validation cross the boundary", () => {
  expect(core().search("getwidget", 1)).toEqual([
    {
      kind: "method",
      name: "fixture.v1.WidgetService/GetWidget",
      page: "fixture.v1.WidgetService",
      doc: "One widget by id. Has no side effects, so Connect allows GET.",
    },
  ]);
  expect(core().template("fixture.v1.GetWidgetRequest", {})).toBe('{\n  "id": ""\n}');
  expect(core().validate("fixture.v1.GetWidgetRequest", '{"id": "w"}', {}).ok).toBe(true);
  expect(core().validate("fixture.v1.GetWidgetRequest", '{"id": 5}', {})).toMatchObject({ ok: false, line: 1 });
  expect(() => core().template("no.Such", {})).toThrow("the schema has no message no.Such");
});

test("a request comes back as its description and its bytes", () => {
  const { request, body } = core().request(spec({ transport: "connect-proto" }));
  expect(request.verb).toBe("POST");
  expect(request.expect).toEqual({ framing: "unary", codec: "proto", message: "fixture.v1.GetWidgetResponse" });
  expect([...body!]).toEqual([0x0a, 0x02, 0x77, 0x31]);
  expect(core().request(spec({ transport: "connect-get" })).body).toBeUndefined();
});

test("curl hides the secret unless asked", () => {
  const withToken = spec({ auth: { scheme: "bearer", token: "s3cr3t" } });
  expect(core().snippet(withToken, "curl", true)).toContain(`'Authorization: Bearer '"$TOKEN"`);
  expect(core().snippet(withToken, "curl", true)).not.toContain("s3cr3t");
  expect(core().snippet(withToken, "curl", false)).toContain("'Authorization: Bearer s3cr3t'");
});

test("a second schema loads into the core that is already there", () => {
  const image = new Uint8Array(readFileSync(join(import.meta.dir, "../../../testdata/fixture.binpb")));
  const again = Core.loadAgain(image, { roots: [], lookups: {} });
  // Without roots, nothing is an import.
  expect(again.index.files.every((file) => !file.imported)).toBe(true);
  expect(again.index.messages.length).toBe(core().index.messages.length);
});

test("a body is scrubbed of what the schema marks as sensitive", () => {
  expect(core().scrub("fixture.v1.Login", '{"username":"ada","password":"x"}', {})).toEqual({
    body: '{\n  "username": "ada"\n}',
    removed: 1,
  });
});

test("rules, variables, lookups and snippets cross the boundary", () => {
  const gadget = "fixture.v1.Gadget";
  expect(core().check(gadget, '{"rackId": "nope"}', {})).toContainEqual({ path: "rackId", message: "must be a UUID" });
  expect(core().check(gadget, '{"rackId": "{{rack}}"}', { rack: "nope" })).toContainEqual({
    path: "rackId",
    message: "must be a UUID",
  });
  // A variable named as a field stands in for it; the schema's example for another.
  const template = JSON.parse(core().template(gadget, { rackId: "r" })) as Record<string, unknown>;
  expect(template.rackId).toBe("{{rackId}}");
  expect(template.title).toBe("Sprocket");
  expect(core().validate("fixture.v1.GetWidgetRequest", '{"id": "{{w}}"}', { w: "w1" }).ok).toBe(true);
  expect(core().validate("fixture.v1.GetWidgetRequest", '{"id": "{{w}}"}', {})).toMatchObject({
    ok: false,
    message: "the variable w is not set in this environment",
  });

  const field = "fixture.v1.GetGadgetRequest.gadget_id";
  expect(() => core().lookupRequest(field, {}, "")).toThrow("ListGadgets needs rackId: set it first");
  expect(core().lookupRequest(field, { rackId: "r1" }, "")).toEqual({
    method: "fixture.v1.CatalogService/ListGadgets",
    body: '{"rackId":"r1","pageSize":20}',
  });
  expect(core().lookupRead(field, { gadgets: [{ id: "g1", title: "One" }], nextPageToken: "n" })).toEqual({
    items: [{ id: "g1", label: "One" }],
    next: "n",
  });
  expect(core().seen("fixture.v1.GetGadgetResponse", { gadget: { id: "g1", title: "One" } })).toEqual([
    { resource: "fixture.v1.Gadget", id: "g1", label: "One" },
  ]);

  const withToken = spec({ auth: { scheme: "bearer", token: "s3cr3t" } });
  expect(core().snippet(withToken, "fetch", true)).toContain('"Authorization": "Bearer " + process.env.TOKEN,');
  expect(core().snippet(withToken, "python", true)).toContain('os.environ["TOKEN"]');
  expect(core().snippet(withToken, "go", true)).toContain('"Bearer "+os.Getenv("TOKEN")');
});
