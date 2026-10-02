// Real ids, picked from the API. A field that names a resource knows the
// list that finds one (the core works that out from the schema); this calls
// the list when asked, and remembers the answer for the life of the tab.
//
// The call carries the credential of the environment, so it is made only on
// a click, and through the same path as a request from the console.
import type { Core } from "./core";
import { destination } from "./environments";
import { type SendOptions, send } from "./send";
import type { Auth, Environment, Item, RequestSpec } from "./types";

export interface Listing {
  items: Item[];
  /** The token of the next page, or "" when there is none. */
  next: string;
}

export class Lookups {
  /** What lists returned, by environment, method and request. */
  private readonly listings = new Map<string, Listing>();
  /** Ids noticed in responses, by environment and resource. */
  private readonly noticed = new Map<string, Map<string, string>>();

  constructor(private readonly core: Core) {}

  private key(environment: Environment, plan: { method: string; body: string }): string {
    return JSON.stringify([destination(environment), plan.method, plan.body]);
  }

  /** What is already known for a field, without a call. */
  cached(field: string, context: Record<string, unknown>, environment: Environment): Listing | undefined {
    try {
      return this.listings.get(this.key(environment, this.core.lookupRequest(field, context, "")));
    } catch {
      return undefined;
    }
  }

  /**
   * Call the list of a field: its first page, or with `more` the page after
   * what is known. Throws an `Error` that says what is missing or what the
   * API answered.
   */
  async fetch(
    field: string,
    context: Record<string, unknown>,
    environment: Environment,
    auth: Auth,
    options: SendOptions,
    more = false,
  ): Promise<Listing> {
    const first = this.core.lookupRequest(field, context, "");
    const key = this.key(environment, first);
    // More of a list that has no more is the list again, from its start.
    const known = more ? [this.listings.get(key)].find((listing) => listing?.next) : undefined;
    const plan = known ? this.core.lookupRequest(field, context, known.next) : first;
    const spec: RequestSpec = {
      method: plan.method,
      body: plan.body,
      transport: "connect-json",
      binding: 0,
      baseUrl: environment.baseUrl,
      headers: environment.headers,
      variables: environment.variables,
      auth,
      timeoutMs: null,
    };
    const outcome = await send(this.core, spec, options);
    if (outcome.failure) throw new Error(outcome.failure.message);
    const error = outcome.parsed?.error;
    if (error) throw new Error(`${error.code}${error.message ? `: ${error.message}` : ""}`);
    const page = this.core.lookupRead(field, outcome.parsed?.message);
    const listing = { items: [...(known?.items ?? []), ...page.items], next: page.next };
    this.listings.set(key, listing);
    return listing;
  }

  /** Take note of the ids in a response. */
  notice(message: string, response: unknown, environment: Environment): void {
    for (const seen of this.core.seen(message, response)) {
      const key = JSON.stringify([destination(environment), seen.resource]);
      const ids = this.noticed.get(key) ?? new Map<string, string>();
      // A label seen once is kept when the id comes again without one.
      ids.set(seen.id, seen.label || (ids.get(seen.id) ?? ""));
      this.noticed.set(key, ids);
    }
  }

  /** The ids of a resource noticed in responses from this environment. */
  seen(resource: string, environment: Environment): Item[] {
    const ids = this.noticed.get(JSON.stringify([destination(environment), resource]));
    return [...(ids ?? [])].map(([id, label]) => ({ id, label }));
  }
}
