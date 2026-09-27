import { describe, expect, test } from "bun:test";

import {
  Secrets,
  isBaseUrl,
  isCredentialHeader,
  isPlaintext,
  merge,
  offered,
  sanitizeEnvironment,
  settingFor,
  toAuth,
} from "./environments";
import { MemoryStore } from "./store";
import { config, environment } from "./testing";

describe("the schemes a site offers", () => {
  test("all four when the config names none", () => {
    expect(offered(config())).toEqual(["none", "bearer", "basic", "api-key"]);
  });

  test("the declared ones, and none, otherwise", () => {
    const site = config({ auth: [{ scheme: "api-key", name: "X-Token", location: "query" }] });
    expect(offered(site)).toEqual(["none", "api-key"]);
    // The declared setting is the default of its scheme.
    expect(settingFor("api-key", site)).toEqual({ scheme: "api-key", name: "X-Token", location: "query" });
  });

  test("a scheme the config does not declare has a plain default", () => {
    expect(settingFor("none", config())).toEqual({ scheme: "none" });
    expect(settingFor("bearer", config())).toEqual({ scheme: "bearer" });
    expect(settingFor("basic", config())).toEqual({ scheme: "basic", username: "" });
    expect(settingFor("api-key", config())).toEqual({ scheme: "api-key", name: "X-API-Key", location: "header" });
  });
});

test("a setting and a secret make the credential of a request", () => {
  expect(toAuth({ scheme: "none" }, "ignored")).toEqual({ scheme: "none" });
  expect(toAuth({ scheme: "bearer" }, "t")).toEqual({ scheme: "bearer", token: "t" });
  expect(toAuth({ scheme: "basic", username: "u" }, "p")).toEqual({ scheme: "basic", username: "u", password: "p" });
  expect(toAuth({ scheme: "api-key", name: "X-K", location: "query" }, "k")).toEqual({
    scheme: "api-key",
    name: "X-K",
    value: "k",
    location: "query",
  });
});

describe("the environments of a page", () => {
  test("a site without any points at its own origin", () => {
    expect(merge(config(), [])).toEqual([
      {
        id: "builtin:This origin",
        name: "This origin",
        baseUrl: "/",
        auth: { scheme: "none" },
        headers: [],
        builtin: true,
      },
    ]);
  });

  test("the config's environments start with the scheme the API needs", () => {
    const site = config({
      environments: [
        { name: "local", baseUrl: "http://localhost:8080" },
        { name: "staging", baseUrl: "https://staging.example.com" },
      ],
      auth: [{ scheme: "bearer" }],
    });
    const merged = merge(site, []);
    expect(merged.map((env) => [env.name, env.baseUrl, env.auth.scheme, env.builtin])).toEqual([
      ["local", "http://localhost:8080", "bearer", true],
      ["staging", "https://staging.example.com", "bearer", true],
    ]);
  });

  test("the proxy of `wirebook serve` remembers where the API really is", () => {
    const site = config({ environments: [{ name: "proxy", baseUrl: "/proxy", directUrl: "http://localhost:8080" }] });
    expect(merge(site, [])[0]).toMatchObject({ baseUrl: "/proxy", directUrl: "http://localhost:8080" });
  });

  test("an edit of a built-in one replaces it, and added ones follow", () => {
    const site = config({ environments: [{ name: "local", baseUrl: "http://localhost:8080" }] });
    const edited = environment({ id: "builtin:local", baseUrl: "http://localhost:9999" });
    const added = environment({ id: "mine", name: "mine", builtin: false });
    // A built-in one that the config no longer has is gone.
    const stale = environment({ id: "builtin:old", name: "old" });
    expect(merge(site, [added, edited, stale]).map((env) => [env.id, env.baseUrl])).toEqual([
      ["builtin:local", "http://localhost:9999"],
      ["mine", "http://api.test"],
    ]);
  });
});

describe("secrets", () => {
  const local = environment();

  test("are held in memory, and stored only when asked", async () => {
    const store = new MemoryStore();
    const secrets = new Secrets(store);
    expect(secrets.get(local)).toBe("");

    await secrets.set(local, "s3cr3t", false);
    expect(secrets.get(local)).toBe("s3cr3t");
    expect(secrets.isRemembered(local)).toBe(false);
    expect(await store.all("secrets")).toEqual([]);

    await secrets.set(local, "s3cr3t", true);
    expect(secrets.isRemembered(local)).toBe(true);
    expect(await store.all("secrets")).toEqual([
      { id: local.id, secret: "s3cr3t", destination: '["http://api.test","",{"scheme":"none"},[]]' },
    ]);

    // The next visit finds it.
    const next = new Secrets(store);
    await next.load();
    expect(next.get(local)).toBe("s3cr3t");
    expect(next.isRemembered(local)).toBe(true);

    // Unticking "remember" takes it out of the store, not out of the page.
    await next.set(local, "s3cr3t", false);
    expect(next.get(local)).toBe("s3cr3t");
    expect(await store.all("secrets")).toEqual([]);
  });

  test("an empty secret is never stored, and forgetting removes both copies", async () => {
    const store = new MemoryStore();
    const secrets = new Secrets(store);
    await secrets.set(local, "", true);
    expect(await store.all("secrets")).toEqual([]);
    expect(secrets.isRemembered(local)).toBe(false);

    await secrets.set(local, "x", true);
    await secrets.forget(local.id);
    expect(secrets.get(local)).toBe("");
    expect(secrets.isRemembered(local)).toBe(false);
    expect(await store.all("secrets")).toEqual([]);
  });

  test("a secret does not follow its environment to another address", async () => {
    const store = new MemoryStore();
    const secrets = new Secrets(store);
    const prod = environment({ id: "builtin:prod", baseUrl: "https://api.example.com", auth: { scheme: "bearer" } });
    await secrets.set(prod, "s3cr3t", true);
    expect(secrets.get(prod)).toBe("s3cr3t");

    // The same environment, as an imported file or a new build could make it.
    const moved = { ...prod, baseUrl: "https://evil.example" };
    expect(secrets.get(moved)).toBe("");
    expect(secrets.isRemembered(moved)).toBe(false);
    // A curl command would go to directUrl: that counts too.
    expect(secrets.get({ ...prod, directUrl: "https://evil.example" })).toBe("");
    // Another scheme would put the same secret somewhere else in the request.
    expect(secrets.get({ ...prod, auth: { scheme: "api-key", name: "k", location: "query" } })).toBe("");
    // So would a header the server may act on.
    expect(secrets.get({ ...prod, headers: [{ name: "X-HTTP-Method-Override", value: "DELETE" }] })).toBe("");
    // Its name is not where it goes.
    expect(secrets.get({ ...prod, name: "renamed" })).toBe("s3cr3t");

    // A key that would move from a header into the URL, or change its name.
    const keyed = environment({ id: "k", auth: { scheme: "api-key", name: "X-API-Key", location: "header" } });
    await secrets.set(keyed, "k3y", false);
    expect(secrets.get(keyed)).toBe("k3y");
    expect(secrets.get({ ...keyed, auth: { scheme: "api-key", name: "X-API-Key", location: "query" } })).toBe("");
    expect(secrets.get({ ...keyed, auth: { scheme: "api-key", name: "X-Other", location: "header" } })).toBe("");

    // After a reload it is the same.
    const next = new Secrets(store);
    await next.load();
    expect(next.get(moved)).toBe("");
    expect(next.get(prod)).toBe("s3cr3t");
  });

  test("a stored row that is not a secret with its destination is not used", async () => {
    const store = new MemoryStore();
    await store.put("secrets", { id: local.id, secret: "from an older version" });
    await store.put("secrets", { id: "other", secret: 5, destination: "x" });
    const secrets = new Secrets(store);
    await secrets.load();
    expect(secrets.get(local)).toBe("");
    expect(secrets.isRemembered(local)).toBe(false);
  });
});

describe("a base URL", () => {
  test("is an origin, or one slash and a path", () => {
    for (const url of ["http://localhost:8080", "https://api.example.com/v1", "/", "/proxy", "http://h/a@b"]) {
      expect(isBaseUrl(url)).toBe(true);
    }
  });

  test("cannot name another origin while looking like a path, or carry a credential", () => {
    for (const url of [
      "",
      "api.example.com",
      "//evil.example",
      "/\\evil.example",
      "https://user:pass@api.example.com",
      "https://token@api.example.com/x",
      "https://api.example.com/?key=1",
      "https://api.example.com/#x",
      "http://a b",
      "http://",
      "javascript:alert(1)",
      "ftp://x",
    ]) {
      expect(isBaseUrl(url)).toBe(false);
    }
  });
});

test("a header that is a credential is told from one that is not", () => {
  for (const name of [
    "Authorization",
    " authorization ",
    "Cookie",
    "X-API-Key",
    "api-key",
    "apikey",
    "X-Auth-Token",
    "X-Auth",
    "Proxy-Authorization",
    "X-Access-Token",
    "Private-Token",
    "X-Vault-Token",
    "X-Amz-Security-Token",
    "X-Client-Secret",
    "X-Password",
    "X-Credential",
    "X_AUTH_USER",
  ]) {
    expect(isCredentialHeader(name)).toBe(true);
  }
  for (const name of [
    "X-Trace",
    "Accept-Language",
    "X-Request-Id",
    "Idempotency-Key",
    "X-Author",
    "X-Session-Id",
    "",
  ]) {
    expect(isCredentialHeader(name)).toBe(false);
  }
});

describe("an environment from outside this code", () => {
  const good = {
    id: "mine",
    name: " Mine ",
    baseUrl: "https://api.example.com",
    auth: { scheme: "api-key", name: "X-K", location: "query", value: "smuggled" },
    headers: [{ name: "X-A", value: "b", extra: 1 }],
    builtin: true,
    directUrl: "https://evil.example",
    surprise: "ignored",
  };

  test("keeps only what an environment is made of", () => {
    expect(sanitizeEnvironment(good)).toEqual({
      id: "mine",
      name: "Mine",
      baseUrl: "https://api.example.com",
      auth: { scheme: "api-key", name: "X-K", location: "query" },
      headers: [{ name: "X-A", value: "b" }],
      // Whether it came with the site is read from its id, not taken on trust.
      builtin: false,
    });
    expect(sanitizeEnvironment({ ...good, id: "builtin:local" })?.builtin).toBe(true);
  });

  test("gives every scheme its own shape, and an unknown one none", () => {
    const auth = (value: unknown) => sanitizeEnvironment({ ...good, auth: value })?.auth;
    expect(auth({ scheme: "bearer", token: "smuggled" })).toEqual({ scheme: "bearer" });
    expect(auth({ scheme: "basic", username: "ada", password: "smuggled" })).toEqual({
      scheme: "basic",
      username: "ada",
    });
    expect(auth({ scheme: "basic", username: 5 })).toEqual({ scheme: "basic", username: "" });
    expect(auth({ scheme: "api-key" })).toEqual({ scheme: "api-key", name: "X-API-Key", location: "header" });
    expect(auth({ scheme: "api-key", name: "", location: "cookie" })).toEqual({
      scheme: "api-key",
      name: "X-API-Key",
      location: "header",
    });
    for (const value of [{ scheme: "oauth2" }, { scheme: "none" }, "bearer", null, undefined, []]) {
      expect(auth(value)).toEqual({ scheme: "none" });
    }
  });

  test("drops a header that is a credential, or is not a header", () => {
    const headers = [
      { name: "Authorization", value: "Bearer smuggled" },
      { name: "X-Ok", value: "1" },
      { name: 5, value: "x" },
      { name: "X-No-Value" },
      "text",
      null,
    ];
    expect(sanitizeEnvironment({ ...good, headers })?.headers).toEqual([{ name: "X-Ok", value: "1" }]);
    expect(sanitizeEnvironment({ ...good, headers: "none" })?.headers).toEqual([]);
  });

  test("refuses what is not an environment", () => {
    for (const row of [
      null,
      "text",
      [],
      { ...good, id: "" },
      { ...good, id: 5 },
      { ...good, id: "x".repeat(201) },
      { ...good, name: "  " },
      { ...good, name: 5 },
      { ...good, name: "x".repeat(201) },
      { ...good, baseUrl: "//evil.example" },
      { ...good, baseUrl: "https://user:pass@host" },
      { ...good, baseUrl: 5 },
    ]) {
      expect(sanitizeEnvironment(row)).toBeNull();
    }
  });

  test("a stored row that is not one is left out of the page's environments", () => {
    const merged = merge(config(), [null, { id: "x" }, good]);
    expect(merged.map((env) => env.id)).toEqual(["builtin:This origin", "mine"]);
  });

  test("where the API really is comes from the site, not from the stored copy", () => {
    const site = config({ environments: [{ name: "proxy", baseUrl: "/proxy", directUrl: "http://localhost:8080" }] });
    const edited = { ...good, id: "builtin:proxy", baseUrl: "/proxy", directUrl: "https://evil.example" };
    expect(merge(site, [edited])[0]?.directUrl).toBe("http://localhost:8080");
    const plain = config({ environments: [{ name: "proxy", baseUrl: "/proxy" }] });
    expect(merge(plain, [edited])[0]).not.toHaveProperty("directUrl");
  });
});

test("a credential over plain http is unencrypted, unless it stays on this machine", () => {
  const page = "https://docs.example/site/";
  expect(isPlaintext("http://api.example.com", page)).toBe(true);
  expect(isPlaintext("http://192.168.1.5:8080", page)).toBe(true);
  expect(isPlaintext("https://api.example.com", page)).toBe(false);
  for (const local of [
    "http://localhost:8080",
    "http://127.0.0.1",
    "http://127.8.9.1:1",
    "http://[::1]:9000",
    "http://api.localhost",
  ]) {
    expect(isPlaintext(local, page)).toBe(false);
  }
  // A path is on the page's own origin.
  expect(isPlaintext("/proxy", page)).toBe(false);
  expect(isPlaintext("/proxy", "http://intranet.example/site/")).toBe(true);
  expect(isPlaintext("/proxy", "http://127.0.0.1:9000/")).toBe(false);
  expect(isPlaintext("http://[", page)).toBe(false);
  // A name that only starts like a loopback address is not one.
  expect(isPlaintext("http://127.evil.example", page)).toBe(true);
  expect(isPlaintext("http://127.0.0.1.evil.example", page)).toBe(true);
});
