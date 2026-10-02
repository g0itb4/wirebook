import { describe, expect, test } from "bun:test";

import { Lookups } from "./lookup";
import type { SendOptions } from "./send";
import { core, environment } from "./testing";

const GADGET_ID = "fixture.v1.GetGadgetRequest.gadget_id";
const RACK_ID = "fixture.v1.Gadget.rack_id";

interface Call {
  url: string;
  body: unknown;
  headers: string[][];
}

/** An API that lists racks, and gadgets two to a page. */
function api(): { calls: Call[]; options: SendOptions } {
  const calls: Call[] = [];
  const options: SendOptions = {
    fetch: (async (url: string, init: RequestInit) => {
      const body = JSON.parse(new TextDecoder().decode(init.body as Uint8Array)) as Record<string, unknown>;
      calls.push({ url, body, headers: init.headers as string[][] });
      if (url.endsWith("/ListRacks")) {
        return Response.json({
          racks: [
            { id: "r1", name: "North" },
            { id: "r2", name: "South" },
          ],
        });
      }
      if (body.rackId === "denied") {
        return Response.json({ code: "permission_denied", message: "not your rack" }, { status: 403 });
      }
      if (body.rackId === "bare") return Response.json({ code: "unavailable" }, { status: 503 });
      const first = body.pageToken === undefined;
      return Response.json({
        gadgets: first
          ? [
              { id: "g1", title: "One" },
              { id: "g2", title: "Two" },
            ]
          : [{ id: "g3", title: "Three" }],
        nextPageToken: first ? "page-2" : "",
      });
    }) as unknown as typeof fetch,
    now: () => 0,
    pageUrl: "https://docs.test/",
  };
  return { calls, options };
}

const env = environment({ auth: { scheme: "bearer" } });
const auth = { scheme: "bearer", token: "t0k3n" } as const;

describe("a list", () => {
  test("is called with the environment's credential, and nothing is known before", async () => {
    const { calls, options } = api();
    const lookups = new Lookups(core());
    expect(lookups.cached(RACK_ID, {}, env)).toBeUndefined();
    expect(calls).toEqual([]);

    const listing = await lookups.fetch(RACK_ID, {}, env, auth, options);
    expect(listing).toEqual({
      items: [
        { id: "r1", label: "North" },
        { id: "r2", label: "South" },
      ],
      next: "",
    });
    expect(calls.length).toBe(1);
    expect(calls[0]!.url).toBe("http://api.test/fixture.v1.CatalogService/ListRacks");
    expect(calls[0]!.headers).toContainEqual(["Authorization", "Bearer t0k3n"]);
    // Known now, without a second call.
    expect(lookups.cached(RACK_ID, {}, env)).toEqual(listing);
    expect(calls.length).toBe(1);
  });

  test("is asked with what the body holds, and says what it lacks", async () => {
    const { calls, options } = api();
    const lookups = new Lookups(core());
    expect(lookups.fetch(GADGET_ID, {}, env, auth, options)).rejects.toThrow("ListGadgets needs rackId: set it first");
    expect(lookups.cached(GADGET_ID, {}, env)).toBeUndefined();
    expect(calls).toEqual([]);

    await lookups.fetch(GADGET_ID, { rackId: "r1", title: "ignored" }, env, auth, options);
    expect(calls[0]!.body).toEqual({ rackId: "r1", pageSize: 20 });
  });

  test("gives its next page when asked for more, and starts over when not", async () => {
    const { calls, options } = api();
    const lookups = new Lookups(core());
    const context = { rackId: "r1" };
    const first = await lookups.fetch(GADGET_ID, context, env, auth, options);
    expect(first.items.map((item) => item.id)).toEqual(["g1", "g2"]);
    expect(first.next).toBe("page-2");

    const more = await lookups.fetch(GADGET_ID, context, env, auth, options, true);
    expect(more.items.map((item) => item.id)).toEqual(["g1", "g2", "g3"]);
    expect(more.next).toBe("");
    expect(calls[1]!.body).toEqual({ rackId: "r1", pageSize: 20, pageToken: "page-2" });
    expect(lookups.cached(GADGET_ID, context, env)).toEqual(more);

    // Nothing more to fetch: asking again is a refresh from the start.
    const again = await lookups.fetch(GADGET_ID, context, env, auth, options, true);
    expect(again.items.map((item) => item.id)).toEqual(["g1", "g2"]);
    const refreshed = await lookups.fetch(GADGET_ID, context, env, auth, options);
    expect(refreshed.items.length).toBe(2);
  });

  test("is kept per environment and per request", async () => {
    const { options } = api();
    const lookups = new Lookups(core());
    await lookups.fetch(GADGET_ID, { rackId: "r1" }, env, auth, options);
    expect(lookups.cached(GADGET_ID, { rackId: "r2" }, env)).toBeUndefined();
    expect(lookups.cached(GADGET_ID, { rackId: "r1" }, { ...env, baseUrl: "https://other.test" })).toBeUndefined();
    expect(lookups.cached(GADGET_ID, { rackId: "r1" }, env)).toBeDefined();
  });

  test("says what the API answered when it refuses, or cannot be reached", async () => {
    const { options } = api();
    const lookups = new Lookups(core());
    expect(lookups.fetch(GADGET_ID, { rackId: "denied" }, env, auth, options)).rejects.toThrow(
      "permission_denied: not your rack",
    );
    expect(lookups.fetch(GADGET_ID, { rackId: "bare" }, env, auth, options)).rejects.toThrow(/^unavailable$/);
    const down: SendOptions = {
      ...options,
      fetch: (async () => {
        throw new TypeError("Failed to fetch");
      }) as unknown as typeof fetch,
    };
    expect(lookups.fetch(RACK_ID, {}, env, auth, down)).rejects.toThrow("The browser blocked the request");
    expect(lookups.cached(GADGET_ID, { rackId: "denied" }, env)).toBeUndefined();
  });
});

describe("ids in responses", () => {
  test("are noticed per resource and per environment, and offered without a call", () => {
    const lookups = new Lookups(core());
    expect(lookups.seen("fixture.v1.Gadget", env)).toEqual([]);
    lookups.notice("fixture.v1.ListGadgetsResponse", { gadgets: [{ id: "g1", title: "One" }, { id: "g2" }] }, env);
    expect(lookups.seen("fixture.v1.Gadget", env)).toEqual([
      { id: "g1", label: "One" },
      { id: "g2", label: "" },
    ]);
    expect(lookups.seen("fixture.v1.Rack", env)).toEqual([]);
    expect(lookups.seen("fixture.v1.Gadget", { ...env, baseUrl: "https://other.test" })).toEqual([]);
  });

  test("an id seen again keeps the label it had", () => {
    const lookups = new Lookups(core());
    lookups.notice("fixture.v1.GetGadgetResponse", { gadget: { id: "g1", title: "One" } }, env);
    lookups.notice("fixture.v1.GetGadgetResponse", { gadget: { id: "g1" } }, env);
    lookups.notice("fixture.v1.GetGadgetResponse", { gadget: { id: "g2", title: "Two" } }, env);
    expect(lookups.seen("fixture.v1.Gadget", env)).toEqual([
      { id: "g1", label: "One" },
      { id: "g2", label: "Two" },
    ]);
  });
});
