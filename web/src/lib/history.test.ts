import { describe, expect, test } from "bun:test";

import { Secrets, merge } from "./environments";
import { HISTORY_LIMIT, entry, exportData, importData, keptBody, list, record } from "./history";
import { MemoryStore } from "./store";
import { config, core, environment, spec } from "./testing";

const result = { status: 200, outcome: "ok", durationMs: 12.6 };

test("an entry can make the call again, and holds no credential", () => {
  const secret = "s3cr3t-token";
  const made = entry(
    spec({ auth: { scheme: "bearer", token: secret }, headers: [{ name: "X-Trace", value: secret }] }),
    environment({ auth: { scheme: "bearer" } }),
    result,
    1_000,
  );
  expect(made).toMatchObject({
    time: 1_000,
    method: "fixture.v1.WidgetService/GetWidget",
    transport: "connect-json",
    binding: 0,
    body: '{"id":"w1"}',
    environment: "local",
    scheme: "bearer",
    status: 200,
    outcome: "ok",
    durationMs: 13,
  });
  expect(made.id).toStartWith("1000-");
  expect(JSON.stringify(made)).not.toContain(secret);
  expect(Object.keys(made).sort()).toEqual(
    [
      "binding",
      "body",
      "durationMs",
      "environment",
      "id",
      "method",
      "outcome",
      "scheme",
      "status",
      "time",
      "transport",
    ].sort(),
  );
});

describe("the list", () => {
  test("is newest first", async () => {
    const store = new MemoryStore();
    for (const time of [2, 3, 1]) await record(store, entry(spec(), environment(), result, time));
    expect((await list(store)).map((e) => e.time)).toEqual([3, 2, 1]);
  });

  test("two calls in one millisecond keep a fixed order", async () => {
    const store = new MemoryStore();
    await store.put("history", { ...entry(spec(), environment(), result, 5), id: "5-a" });
    await store.put("history", { ...entry(spec(), environment(), result, 5), id: "5-b" });
    expect((await list(store)).map((e) => e.id)).toEqual(["5-b", "5-a"]);
  });

  test("drops the oldest past the limit", async () => {
    const store = new MemoryStore();
    for (let time = 1; time <= HISTORY_LIMIT + 3; time++) {
      await record(store, entry(spec(), environment(), result, time));
    }
    const kept = await list(store);
    expect(kept.length).toBe(HISTORY_LIMIT);
    expect(kept.at(-1)!.time).toBe(4);
  });
});

describe("export and import", () => {
  test("carry environments and history, and never a secret", async () => {
    const store = new MemoryStore();
    await store.put("environments", environment({ id: "mine", name: "mine", builtin: false }));
    await store.put("secrets", { id: "mine", secret: "s3cr3t" });
    await record(store, entry(spec(), environment(), result, 7));

    const exported = await exportData(store, { bodies: true });
    expect(exported.wirebook).toBe(1);
    expect(exported.environments.map((env) => env.id)).toEqual(["mine"]);
    expect(exported.history.map((e) => [e.time, e.body])).toEqual([[7, '{"id":"w1"}']]);
    expect(JSON.stringify(exported)).not.toContain("s3cr3t");

    // Without the bodies, unless asked: they are what someone typed.
    const bare = await exportData(store, { bodies: false });
    expect(bare.history.map((e) => [e.time, e.method, e.body])).toEqual([
      [7, "fixture.v1.WidgetService/GetWidget", ""],
    ]);
    expect(JSON.stringify(bare)).not.toContain("w1");

    const other = new MemoryStore();
    expect(await importData(other, JSON.stringify(exported), 1_000)).toEqual({ environments: 1, history: 1 });
    expect(await list(other)).toEqual(exported.history);
    expect(await other.all("secrets")).toEqual([]);
  });

  test("an imported environment is a new one, and says where it came from", async () => {
    const store = new MemoryStore();
    const mine = environment({ id: "mine", name: "mine", builtin: false });
    await store.put("environments", mine);
    const file = {
      wirebook: 1,
      // The id of one that is here, the id of one the site declares, and one
      // already imported once.
      environments: [
        { ...mine, baseUrl: "https://elsewhere.example" },
        environment({ id: "builtin:Production", name: "Production", baseUrl: "https://look-alike.example" }),
        environment({ id: "x", name: "Staging (imported)" }),
      ],
      history: [],
    };
    expect(await importData(store, JSON.stringify(file), 1_000)).toEqual({ environments: 3, history: 0 });
    const rows = await store.all<{ id: string; name: string; baseUrl: string; builtin: boolean }>("environments");
    expect(rows.map((row) => [row.id, row.name, row.baseUrl, row.builtin]).sort()).toEqual([
      ["imported:rs-0", "mine (imported)", "https://elsewhere.example", false],
      ["imported:rs-1", "Production (imported)", "https://look-alike.example", false],
      ["imported:rs-2", "Staging (imported)", "http://api.test", false],
      ["mine", "mine", "http://api.test", false],
    ]);
    // The site's own "Production" is still the site's.
    const site = config({ environments: [{ name: "Production", baseUrl: "https://api.example.com" }] });
    expect(merge(site, rows)[0]).toMatchObject({ id: "builtin:Production", baseUrl: "https://api.example.com" });
  });

  test("a file that is not an export is refused", async () => {
    const store = new MemoryStore();
    expect(importData(store, "{")).rejects.toThrow("The file is not JSON.");
    for (const text of [
      "[]",
      "null",
      '{"wirebook":2,"environments":[],"history":[]}',
      '{"wirebook":1,"environments":{},"history":[]}',
      '{"wirebook":1,"environments":[]}',
    ]) {
      expect(importData(store, text)).rejects.toThrow("The file is not a wirebook export.");
    }
  });

  test("rows that are not what they should be are left out", async () => {
    const store = new MemoryStore();
    const good = entry(spec(), environment(), result, 7);
    const file = {
      wirebook: 1,
      environments: [
        environment({ id: "ok", builtin: false }),
        { name: "no id" },
        5,
        null,
        [],
        { id: "bad", name: "x", baseUrl: "//evil.example" },
      ],
      history: [
        good,
        { ...good, id: "" },
        { ...good, id: 5 },
        { ...good, id: "b", transport: "telnet" },
        { ...good, id: "c", body: { not: "text" } },
        { ...good, id: "d", time: "yesterday" },
        { ...good, id: "e", status: -1 },
        { ...good, id: "f", durationMs: Number.NaN },
        { ...good, id: "g", method: "m".repeat(501) },
        { ...good, id: "h", environment: 5 },
        "text",
        null,
      ],
    };
    expect(await importData(store, JSON.stringify(file))).toEqual({ environments: 1, history: 1 });
    expect((await store.all("environments")).map((row) => row.name)).toEqual(["local (imported)"]);
    expect(await list(store)).toEqual([good]);
  });

  test("a file cannot bring a credential in, or send one somewhere else", async () => {
    const store = new MemoryStore();
    const secrets = new Secrets(store);
    const site = config({
      environments: [{ name: "prod", baseUrl: "https://api.example.com" }],
      auth: [{ scheme: "bearer" }],
    });
    const [prod] = merge(site, []);
    await secrets.set(prod!, "s3cr3t", true);

    // The same environment, pointed at someone else's server, with a
    // credential header and a few fields that are not an environment's.
    const hostile = {
      wirebook: 1,
      environments: [
        {
          ...prod,
          baseUrl: "https://evil.example",
          headers: [{ name: "Authorization", value: "Bearer planted" }],
          secret: "planted",
          directUrl: "https://evil.example",
        },
      ],
      history: [],
      secrets: [{ id: prod!.id, secret: "planted", destination: "anything" }],
    };
    expect(await importData(store, JSON.stringify(hostile), 1_000)).toEqual({ environments: 1, history: 0 });

    const after = new Secrets(store);
    await after.load();
    const all = merge(site, await store.all("environments"));
    // The site's environment is as it was, and still has its secret.
    expect(all[0]).toEqual(prod!);
    expect(after.get(all[0]!)).toBe("s3cr3t");
    // The imported one stands beside it, with no header and no secret.
    expect(all[1]).toEqual({
      id: "imported:rs-0",
      name: "prod (imported)",
      baseUrl: "https://evil.example",
      auth: { scheme: "bearer" },
      headers: [],
      variables: {},
      builtin: false,
    });
    expect(after.get(all[1]!)).toBe("");
    expect((await store.all("secrets")).map((row) => [row.id, row.secret])).toEqual([[prod!.id, "s3cr3t"]]);
  });
});

describe("what the history keeps of a body", () => {
  test("is the body as typed, when nothing in it is sensitive", () => {
    expect(keptBody(core(), "fixture.v1.GetWidgetRequest", '{ "id": "w1" }', true, {})).toBe('{ "id": "w1" }');
  });

  test("is the body without the fields the schema marks as sensitive", () => {
    const typed = '{"username": "ada", "password": "s3cr3t", "previous": {"password": "older"}}';
    const kept = keptBody(core(), "fixture.v1.Login", typed, true, {});
    expect(JSON.parse(kept)).toEqual({ username: "ada", previous: {} });
    expect(kept).not.toContain("s3cr3t");
    expect(kept).not.toContain("older");
  });

  test("is nothing, for a body the schema cannot read", () => {
    expect(keptBody(core(), "fixture.v1.Login", '{"password": "s3cr3t"', true, {})).toBe("");
    expect(keptBody(core(), "no.Such", '{"password": "s3cr3t"}', true, {})).toBe("");
  });

  test("is kept as typed with its variables, unless a field was taken out", () => {
    const typed = '{"username": "{{user}}"}';
    expect(keptBody(core(), "fixture.v1.Login", typed, true, { user: "ada" })).toBe(typed);
    const secret = '{"username": "{{user}}", "password": "x"}';
    expect(JSON.parse(keptBody(core(), "fixture.v1.Login", secret, true, { user: "ada" }))).toEqual({
      username: "ada",
    });
    // A variable that is not set: the body could not be sent, and is not kept.
    expect(keptBody(core(), "fixture.v1.Login", typed, true, {})).toBe("");
  });

  test("is nothing, when the person turned it off", () => {
    expect(keptBody(core(), "fixture.v1.GetWidgetRequest", '{"id": "w1"}', false, {})).toBe("");
  });
});
