// Sending: the core builds the request, `fetch` carries it, the core reads
// the answer. Nothing here adds a header or changes a URL.
import type { Core } from "./core";
import type { BuiltRequest, Frame, Parsed, RequestSpec, RpcError } from "./types";

export interface Outcome {
  request: BuiltRequest;
  /** 0 when no response came. */
  status: number;
  statusText: string;
  headers: [string, string][];
  durationMs: number;
  /** Bytes of the response body. */
  size: number;
  /** The body as text, when it is text; for the raw view. */
  raw: string | null;
  /** The message or the error. `null` when no response came. */
  parsed: Parsed | null;
  /** The frames of a stream, in order: the last `MAX_FRAMES` of them. */
  frames: Frame[];
  /** How many earlier frames were let go. */
  framesDropped: number;
  /** Why no response came, or why it stopped. */
  failure: Failure | null;
}

/** A response, or one frame of a stream, is read up to this size. */
export const MAX_BYTES = 32 * 1024 * 1024;
/** A stream keeps its last frames; one that never ends must not fill the tab. */
export const MAX_FRAMES = 1000;

export interface Failure {
  kind: "refused" | "network" | "aborted";
  message: string;
}

export interface SendOptions {
  fetch: typeof fetch;
  now: () => number;
  /** The page's own address, to explain a failure. */
  pageUrl: string;
  signal?: AbortSignal;
  /** Called for every frame of a stream, as it arrives. */
  onFrame?: (frame: Frame) => void;
}

function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length + b.length);
  out.set(a);
  out.set(b, a.length);
  return out;
}

function text(bytes: Uint8Array): string | null {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

/**
 * `fetch` rejects with the same TypeError whether the API is down, the name
 * does not resolve, or the API answered without allowing this origin to read
 * it. The page cannot tell them apart, so it says what to check.
 */
export function explainNetworkFailure(requestUrl: string, pageUrl: string): string {
  let page: URL;
  let target: URL;
  try {
    page = new URL(pageUrl);
    target = new URL(requestUrl, pageUrl);
  } catch {
    return "The request could not be sent: its URL is not valid.";
  }
  if (page.protocol === "https:" && target.protocol === "http:") {
    return `The browser blocked the request: this page is served over https and ${target.origin} is not. Use an https base URL, or open the page over http.`;
  }
  if (target.origin === page.origin) {
    return `No answer from ${target.origin}. Check that the server is running.`;
  }
  return (
    `The browser could not read an answer from ${target.origin}. Either the API is not reachable, ` +
    `or it does not allow requests from ${page.origin} (CORS). To allow them, the API must answer the preflight ` +
    `with this origin and the headers of the request. Without changing the API: run \`wirebook serve --target ${target.origin}\` ` +
    `and choose the proxy environment.`
  );
}

export function outcomeLabel(outcome: Outcome): string {
  if (outcome.failure && outcome.status === 0) return outcome.failure.kind === "aborted" ? "cancelled" : "network";
  const end = outcome.frames.findLast((frame) => frame.kind === "end");
  const error: RpcError | null | undefined = end?.kind === "end" ? end.error : outcome.parsed?.error;
  return error ? error.code : "ok";
}

export async function send(core: Core, spec: RequestSpec, options: SendOptions): Promise<Outcome> {
  const started = options.now();
  let prepared;
  try {
    prepared = core.request(spec);
  } catch (error) {
    throw new Error(error instanceof Error ? error.message : String(error));
  }
  const { request, body } = prepared;
  const outcome: Outcome = {
    request,
    status: 0,
    statusText: "",
    headers: [],
    durationMs: 0,
    size: 0,
    raw: null,
    parsed: null,
    frames: [],
    framesDropped: 0,
    failure: null,
  };
  const finish = (): Outcome => {
    outcome.durationMs = options.now() - started;
    return outcome;
  };
  const failed = (error: unknown): Outcome => {
    const aborted = options.signal?.aborted === true;
    outcome.failure = aborted
      ? { kind: "aborted", message: "Cancelled." }
      : outcome.status === 0
        ? { kind: "refused", message: explainNetworkFailure(request.url, options.pageUrl) }
        : {
            kind: "network",
            message: `The connection was lost: ${error instanceof Error ? error.message : String(error)}`,
          };
    return finish();
  };

  let response: Response;
  try {
    response = await options.fetch(request.url, {
      method: request.verb,
      headers: request.headers.map((header): [string, string] => [header.name, header.value]),
      body: (body as BodyInit | undefined) ?? null,
      // No cookie is ever sent along, and a redirect is refused: the
      // credential goes to the origin that was chosen, and nowhere else.
      credentials: "omit",
      redirect: "error",
      referrerPolicy: "no-referrer",
      mode: "cors",
      cache: "no-store",
      signal: options.signal ?? null,
    });
  } catch (error) {
    return failed(error);
  }
  outcome.status = response.status;
  outcome.statusText = response.statusText;
  outcome.headers = [...response.headers.entries()];

  const streaming = request.expect.framing === "stream" && response.status === 200;
  const tooLarge = (what: string): Outcome => {
    outcome.failure = {
      kind: "network",
      message: `${what} is larger than ${MAX_BYTES / 1024 / 1024} MB. The console stopped reading.`,
    };
    return finish();
  };
  try {
    const reader = response.body?.getReader();
    let buffer: Uint8Array = new Uint8Array(0);
    for (;;) {
      const { done, value } = reader ? await reader.read() : { done: true, value: undefined };
      if (done || !value) break;
      outcome.size += value.length;
      buffer = concat(buffer, value);
      if (streaming) {
        const read = core.frames(request.expect, buffer);
        buffer = buffer.slice(read.consumed);
        for (const frame of read.frames) {
          outcome.frames.push(frame);
          if (outcome.frames.length > MAX_FRAMES) {
            outcome.frames.shift();
            outcome.framesDropped++;
          }
          options.onFrame?.(frame);
        }
      }
      // What is held: a whole response, or the part of a stream that is not
      // yet a whole frame. A server that never stops must not fill the tab.
      if (buffer.length > MAX_BYTES) {
        await reader?.cancel();
        return tooLarge(streaming ? "A frame of the stream" : "The response");
      }
    }
    if (streaming) {
      outcome.parsed = core.response(request.expect, response.status, new Uint8Array(0));
      if (buffer.length > 0 || !outcome.frames.some((frame) => frame.kind === "end")) {
        outcome.failure = { kind: "network", message: "The stream stopped before its end." };
      }
    } else {
      outcome.raw = text(buffer);
      outcome.parsed = core.response(request.expect, response.status, buffer);
    }
  } catch (error) {
    return failed(error);
  }
  return finish();
}
