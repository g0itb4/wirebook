// The calls made from this browser, newest first. An entry is enough to make
// the call again: the method, the body, the transport and the environment's
// name. It holds no credential and no header: only which scheme was used.
import type { Core } from "./core";
import { sanitizeEnvironment } from "./environments";
import type { Row, Store } from "./store";
import type { Environment, RequestSpec, Transport, Variables } from "./types";

export const HISTORY_LIMIT = 200;

export interface HistoryEntry extends Row {
  time: number;
  method: string;
  transport: Transport;
  binding: number;
  body: string;
  environment: string;
  scheme: string;
  /** The HTTP status, or 0 when no response came. */
  status: number;
  /** `ok`, a Connect code, or `network`. */
  outcome: string;
  durationMs: number;
}

export function entry(
  spec: RequestSpec,
  environment: Environment,
  result: { status: number; outcome: string; durationMs: number },
  now: number,
): HistoryEntry {
  return {
    id: `${now}-${Math.random().toString(36).slice(2, 8)}`,
    time: now,
    method: spec.method,
    transport: spec.transport,
    binding: spec.binding,
    body: spec.body,
    environment: environment.name,
    scheme: environment.auth.scheme,
    status: result.status,
    outcome: result.outcome,
    durationMs: Math.round(result.durationMs),
  };
}

/**
 * The body as the history keeps it: without the fields the schema marks as
 * sensitive (`debug_redact`), so a password typed into a login request is
 * sent and not kept; or not at all, when the person turned that off.
 */
export function keptBody(core: Core, message: string, body: string, keep: boolean, variables: Variables): string {
  if (!keep) return "";
  try {
    // Scrubbed, the body has its variables replaced; left alone, it is kept
    // as typed, placeholders and all.
    const scrubbed = core.scrub(message, body, variables);
    return scrubbed.removed > 0 ? scrubbed.body : body;
  } catch {
    // A body the schema cannot read was not sent either; keep none of it.
    return "";
  }
}

export async function record(store: Store, added: HistoryEntry): Promise<void> {
  await store.put("history", added);
  const all = await list(store);
  for (const old of all.slice(HISTORY_LIMIT)) await store.remove("history", old.id);
}

export async function list(store: Store): Promise<HistoryEntry[]> {
  const all = await store.all<HistoryEntry>("history");
  return all.sort((a, b) => b.time - a.time || (a.id < b.id ? 1 : -1));
}

export interface Exported {
  wirebook: 1;
  environments: Environment[];
  history: HistoryEntry[];
}

/**
 * Everything but the secrets, to move to another browser or to a colleague.
 * Request bodies go along only when asked: they are what someone typed, and
 * may hold what the schema did not mark as sensitive.
 */
export async function exportData(store: Store, options: { bodies: boolean }): Promise<Exported> {
  const history = await list(store);
  return {
    wirebook: 1,
    environments: await store.all<Environment>("environments"),
    history: options.bodies ? history : history.map((past) => ({ ...past, body: "" })),
  };
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const TRANSPORTS = ["connect-json", "connect-proto", "connect-get", "rest"];

/** A history entry from a file: every part of the type it should be, or `null`. */
function sanitizeEntry(row: unknown): HistoryEntry | null {
  if (!isRecord(row)) return null;
  const text = (value: unknown, limit: number): value is string => typeof value === "string" && value.length <= limit;
  const count = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value >= 0;
  const { id, time, method, transport, binding, body, environment, scheme, status, outcome, durationMs } = row;
  if (!text(id, 200) || id === "" || !text(method, 500) || !text(body, 1_000_000)) return null;
  if (!text(environment, 200) || !text(scheme, 20) || !text(outcome, 100)) return null;
  if (typeof transport !== "string" || !TRANSPORTS.includes(transport)) return null;
  if (!count(time) || !count(binding) || !count(status) || !count(durationMs)) return null;
  return {
    id,
    time,
    method,
    transport: transport as Transport,
    binding: Math.floor(binding),
    body,
    environment,
    scheme,
    status: Math.floor(status),
    outcome,
    durationMs: Math.round(durationMs),
  };
}

/**
 * Take in an export.
 *
 * The file may come from anyone, so nothing in it replaces what is here: an
 * environment arrives as a new one, marked as imported, never in the place
 * of one the site declares or the person made. It carries no credential in,
 * and has none here until one is typed for it (see `destination`). A row
 * that is not what it should be is left out.
 */
export async function importData(
  store: Store,
  text: string,
  stamp: number = Date.now(),
): Promise<{ environments: number; history: number }> {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error("The file is not JSON.");
  }
  if (!isRecord(data) || data.wirebook !== 1 || !Array.isArray(data.environments) || !Array.isArray(data.history)) {
    throw new Error("The file is not a wirebook export.");
  }
  const environments = data.environments
    .map(sanitizeEnvironment)
    .filter((row) => row !== null)
    .map((row, i): Environment => ({
      ...row,
      id: `imported:${stamp.toString(36)}-${i}`,
      name: row.name.endsWith(" (imported)") ? row.name : `${row.name} (imported)`,
      builtin: false,
    }));
  const history = data.history.map(sanitizeEntry).filter((row) => row !== null);
  for (const row of environments) await store.put("environments", row);
  for (const row of history) await store.put("history", row);
  return { environments: environments.length, history: history.length };
}
