// What every part of the page shares: the core, the site's config, and the
// state a visit builds up.
import type { Core } from "../lib/core";
import { Secrets, merge } from "../lib/environments";
import { Lookups } from "../lib/lookup";
import { namer } from "../lib/route";
import type { Store } from "../lib/store";
import type { Environment, SiteConfig } from "../lib/types";

export class Context {
  environments: Environment[] = [];
  current = "";
  readonly secrets: Secrets;
  /** Whether the history keeps request bodies. On, until the person says no. */
  keepBodies = true;
  /** Whether a key alone, such as "/", does something. */
  shortcuts = true;
  /** How a body is edited: as a form, or as JSON. */
  view: "form" | "json" = "form";
  /** What lists returned and which ids were seen: in memory, for this tab. */
  readonly lookups: Lookups;
  /** The body someone was typing for a method, kept while the page is open. */
  readonly drafts = new Map<string, string>();
  private readonly listeners = new Set<() => void>();
  /** `Widget.Part` for `fixture.v1.Widget.Part`. */
  readonly short: (fullName: string) => string;

  constructor(
    readonly core: Core,
    readonly config: SiteConfig,
    readonly store: Store,
  ) {
    this.secrets = new Secrets(store);
    this.lookups = new Lookups(core);
    this.short = namer(core.index);
  }

  async load(): Promise<void> {
    await this.secrets.load();
    await this.reload();
    const settings = await this.store.all<{ id: string; value: string }>("settings");
    const [setting] = settings.filter((row) => row.id === "environment");
    const setting_ = (id: string): string | undefined => settings.find((row) => row.id === id)?.value;
    this.keepBodies = setting_("keepBodies") !== "no";
    this.shortcuts = setting_("shortcuts") !== "no";
    this.view = setting_("view") === "json" ? "json" : "form";
    this.current = this.environments.some((env) => env.id === setting?.value)
      ? setting!.value
      : this.environments[0]!.id;
  }

  async reload(): Promise<void> {
    this.environments = merge(this.config, await this.store.all<Environment>("environments"));
    if (!this.environments.some((env) => env.id === this.current)) this.current = this.environments[0]!.id;
  }

  get environment(): Environment {
    return this.environments.find((env) => env.id === this.current) ?? this.environments[0]!;
  }

  async choose(id: string): Promise<void> {
    this.current = id;
    await this.store.put("settings", { id: "environment", value: id });
    this.changed();
  }

  async setKeepBodies(keep: boolean): Promise<void> {
    this.keepBodies = keep;
    await this.store.put("settings", { id: "keepBodies", value: keep ? "yes" : "no" });
  }

  async setShortcuts(on: boolean): Promise<void> {
    this.shortcuts = on;
    await this.store.put("settings", { id: "shortcuts", value: on ? "yes" : "no" });
  }

  async setView(view: "form" | "json"): Promise<void> {
    this.view = view;
    await this.store.put("settings", { id: "view", value: view });
  }

  /** Call when the environments or their secrets changed. */
  changed(): void {
    for (const listener of this.listeners) listener();
  }

  onChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}
