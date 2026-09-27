// An environment is where requests go and how they authenticate: a base URL,
// a scheme, and headers. The secret of the scheme is kept apart from it, so
// that nothing that stores or exports an environment can carry one.
import type { Store } from "./store";
import type { Auth, AuthSetting, Environment, SiteConfig } from "./types";

export const SCHEMES = ["none", "bearer", "basic", "api-key"] as const;
export type Scheme = (typeof SCHEMES)[number];

export const SCHEME_LABEL: Record<Scheme, string> = {
  none: "None",
  bearer: "Bearer token",
  basic: "Basic (user name and password)",
  "api-key": "API key",
};

/** The default setting of a scheme, as the site's config declares it. */
export function settingFor(scheme: Scheme, config: SiteConfig): AuthSetting {
  const declared = config.auth.find((setting) => setting.scheme === scheme);
  if (declared) return structuredClone(declared);
  switch (scheme) {
    case "none":
      return { scheme: "none" };
    case "bearer":
      return { scheme: "bearer" };
    case "basic":
      return { scheme: "basic", username: "" };
    case "api-key":
      return { scheme: "api-key", name: "X-API-Key", location: "header" };
  }
}

/** The schemes offered: those the config declares, or all four. `none` always. */
export function offered(config: SiteConfig): Scheme[] {
  if (config.auth.length === 0) return [...SCHEMES];
  return SCHEMES.filter((scheme) => scheme === "none" || config.auth.some((s) => s.scheme === scheme));
}

/** The setting and the secret, joined for one request. */
export function toAuth(setting: AuthSetting, secret: string): Auth {
  switch (setting.scheme) {
    case "none":
      return { scheme: "none" };
    case "bearer":
      return { scheme: "bearer", token: secret };
    case "basic":
      return { scheme: "basic", username: setting.username, password: secret };
    case "api-key":
      return { scheme: "api-key", name: setting.name, value: secret, location: setting.location };
  }
}

const builtinId = (name: string): string => `builtin:${name}`;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** A base URL as the core accepts it: an origin, or one slash and a path. */
export function isBaseUrl(url: string): boolean {
  return /^(https?:\/\/[^/@\\\s?#]+(\/[^\\\s?#]*)?|\/(?!\/)[^\\\s?#]*)$/.test(url);
}

/**
 * A header that is a credential under another name: `Authorization`,
 * `X-Vault-Token`, `apikey`. It belongs under Authentication, where it is
 * neither stored nor exported, and where the API key scheme takes a header
 * of any name. Headers here are stored, exported and shown as they are.
 */
export function isCredentialHeader(name: string): boolean {
  return /(^|[-_])auth(orization|entication)?([-_]|$)|token|secret|passw|credential|api[-_]?key|cookie/i.test(
    name.trim(),
  );
}

function sanitizeAuth(value: unknown): AuthSetting {
  if (!isRecord(value)) return { scheme: "none" };
  switch (value.scheme) {
    case "bearer":
      return { scheme: "bearer" };
    case "basic":
      return { scheme: "basic", username: typeof value.username === "string" ? value.username : "" };
    case "api-key":
      return {
        scheme: "api-key",
        name: typeof value.name === "string" && value.name !== "" ? value.name : "X-API-Key",
        location: value.location === "query" ? "query" : "header",
      };
    default:
      return { scheme: "none" };
  }
}

/**
 * An environment read from somewhere that is not this code: the browser's
 * store, or a file someone imported. Only what an environment is made of is
 * kept, each part checked; a row that is not one gives `null`.
 *
 * `directUrl` is never taken: where the API really is comes from the site.
 */
export function sanitizeEnvironment(row: unknown): Environment | null {
  if (!isRecord(row)) return null;
  const { id, name, baseUrl } = row;
  if (typeof id !== "string" || id === "" || id.length > 200) return null;
  if (typeof name !== "string" || name.trim() === "" || name.length > 200) return null;
  if (typeof baseUrl !== "string" || !isBaseUrl(baseUrl)) return null;
  const headers = (Array.isArray(row.headers) ? row.headers : []).filter(
    (header): header is { name: string; value: string } =>
      isRecord(header) &&
      typeof header.name === "string" &&
      typeof header.value === "string" &&
      !isCredentialHeader(header.name),
  );
  return {
    id,
    name: name.trim(),
    baseUrl,
    auth: sanitizeAuth(row.auth),
    headers: headers.map((header) => ({ name: header.name, value: header.value })),
    builtin: id.startsWith("builtin:"),
  };
}

/**
 * The environments of the page: those of the site's config, each as last
 * edited here if it was, then the ones added here. A site without any gets
 * one that points at the page's own origin.
 */
export function merge(config: SiteConfig, stored: unknown[]): Environment[] {
  const kept = stored.map(sanitizeEnvironment).filter((env): env is Environment => env !== null);
  const declared: SiteConfig["environments"] =
    config.environments.length > 0 ? config.environments : [{ name: "This origin", baseUrl: "/" }];
  const first = offered(config).find((scheme) => scheme !== "none") ?? "none";
  const builtin = declared.map((env): Environment => {
    const id = builtinId(env.name);
    const direct = env.directUrl === undefined ? {} : { directUrl: env.directUrl };
    const edited = kept.find((s) => s.id === id);
    if (edited) return { ...edited, ...direct };
    return {
      id,
      name: env.name,
      baseUrl: env.baseUrl,
      // When the config names schemes, the API needs one: start with it.
      auth: config.auth.length > 0 ? settingFor(first, config) : { scheme: "none" },
      headers: [],
      builtin: true,
      ...direct,
    };
  });
  const ids = new Set(builtin.map((env) => env.id));
  return [...builtin, ...kept.filter((env) => !env.builtin && !ids.has(env.id))];
}

/**
 * What a secret was typed for: where it goes, and how. A secret is used only
 * for the environment as it was then. Change where the environment points,
 * by hand, by an imported file or by a new build of the site, and the secret
 * has to be typed again: it does not follow a URL it was never meant for.
 */
export function destination(environment: Environment): string {
  return JSON.stringify([
    environment.baseUrl,
    environment.directUrl ?? "",
    // How it is sent: a key moved from a header to the query, or sent under
    // another name, is not what the person agreed to either.
    environment.auth,
    environment.headers.map((header) => [header.name, header.value]),
  ]);
}

interface Held {
  secret: string;
  destination: string;
}

/** Secrets, by environment. In memory; in the store only when asked. */
export class Secrets {
  private readonly held = new Map<string, Held>();
  private readonly remembered = new Set<string>();

  constructor(private readonly store: Store) {}

  async load(): Promise<void> {
    for (const row of await this.store.all("secrets")) {
      if (typeof row.secret !== "string" || typeof row.destination !== "string") continue;
      this.held.set(row.id, { secret: row.secret, destination: row.destination });
      this.remembered.add(row.id);
    }
  }

  /** The secret of an environment, or "" when it has none for where it points now. */
  get(environment: Environment): string {
    const held = this.held.get(environment.id);
    return held && held.destination === destination(environment) ? held.secret : "";
  }

  isRemembered(environment: Environment): boolean {
    return this.remembered.has(environment.id) && this.get(environment) !== "";
  }

  async set(environment: Environment, secret: string, remember: boolean): Promise<void> {
    const held = { secret, destination: destination(environment) };
    this.held.set(environment.id, held);
    if (remember && secret !== "") {
      this.remembered.add(environment.id);
      await this.store.put("secrets", { id: environment.id, ...held });
    } else {
      this.remembered.delete(environment.id);
      await this.store.remove("secrets", environment.id);
    }
  }

  async forget(id: string): Promise<void> {
    this.held.delete(id);
    this.remembered.delete(id);
    await this.store.remove("secrets", id);
  }
}

/**
 * Whether a credential sent to this base URL travels unencrypted: plain
 * http, to a host that is not this machine.
 */
export function isPlaintext(baseUrl: string, pageUrl: string): boolean {
  let url: URL;
  try {
    url = new URL(baseUrl, pageUrl);
  } catch {
    return false;
  }
  const host = url.hostname.replace(/^\[|\]$/g, "");
  const local =
    host === "localhost" || host.endsWith(".localhost") || /^127(\.\d{1,3}){3}$/.test(host) || host === "::1";
  return url.protocol === "http:" && !local;
}
