import { describe, expect, test } from "bun:test";

import {
  MAX_BYTES,
  MAX_FRAMES,
  type Outcome,
  type SendOptions,
  explainNetworkFailure,
  outcomeLabel,
  send,
} from "./send";
import { core, spec } from "./testing";
import type { Frame } from "./types";

interface Call {
  url: string;
  init: RequestInit;
}

/** A `fetch` that records what it was asked and answers as told. */
function fake(answer: (call: Call) => Response | Promise<Response>): { calls: Call[]; options: SendOptions } {
  const calls: Call[] = [];
  let clock = 1_000;
  const options: SendOptions = {
    fetch: (async (url: string, init: RequestInit) => {
      const call = { url, init };
      calls.push(call);
      return answer(call);
    }) as unknown as typeof fetch,
    now: () => (clock += 25),
    pageUrl: "https://docs.test/site/",
  };
  return { calls, options };
}

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

function envelope(flags: number, payload: string): Uint8Array {
  const bytes = new TextEncoder().encode(payload);
  const out = new Uint8Array(5 + bytes.length);
  out[0] = flags;
  new DataView(out.buffer).setUint32(1, bytes.length);
  out.set(bytes, 5);
  return out;
}

function streamOf(chunks: Uint8Array[], fail = false): Response {
  // One chunk per read, so that a failure comes after the chunks, not
  // instead of them.
  let next = 0;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      const chunk = chunks[next++];
      if (chunk) controller.enqueue(chunk);
      else if (fail) controller.error(new Error("reset by peer"));
      else controller.close();
    },
  });
  return new Response(body, { status: 200, headers: { "Content-Type": "application/connect+json" } });
}

describe("a unary call", () => {
  test("is sent as the core built it, with no cookie and no redirect", async () => {
    const { calls, options } = fake(() => json({ widget: { id: "w1" } }));
    const outcome = await send(core(), spec({ auth: { scheme: "bearer", token: "t0k3n" } }), options);

    expect(calls.length).toBe(1);
    const { url, init } = calls[0]!;
    expect(url).toBe("http://api.test/fixture.v1.WidgetService/GetWidget");
    expect(init.method).toBe("POST");
    expect(init.headers).toEqual([
      ["Content-Type", "application/json"],
      ["Connect-Protocol-Version", "1"],
      ["Authorization", "Bearer t0k3n"],
    ]);
    expect(new TextDecoder().decode(init.body as Uint8Array)).toBe('{"id":"w1"}');
    expect(init.credentials).toBe("omit");
    expect(init.redirect).toBe("error");
    expect(init.mode).toBe("cors");
    expect(init.cache).toBe("no-store");
    expect(init.referrerPolicy).toBe("no-referrer");

    expect(outcome.status).toBe(200);
    expect(outcome.parsed).toEqual({ ok: true, message: { widget: { id: "w1" } }, error: null });
    expect(outcome.raw).toBe('{"widget":{"id":"w1"}}');
    expect(outcome.size).toBe(22);
    expect(outcome.headers).toContainEqual(["content-type", "application/json"]);
    expect(outcome.durationMs).toBe(25);
    expect(outcome.failure).toBeNull();
    expect(outcome.frames).toEqual([]);
    expect(outcomeLabel(outcome)).toBe("ok");
  });

  test("a GET carries no body", async () => {
    const { calls, options } = fake(() => json({}));
    await send(core(), spec({ transport: "connect-get" }), options);
    expect(calls[0]!.init.method).toBe("GET");
    expect(calls[0]!.init.body).toBeNull();
    expect(calls[0]!.url).toContain("?connect=v1&encoding=json&message=");
  });

  test("an error is read with its code", async () => {
    const { options } = fake(() => json({ code: "unauthenticated", message: "who are you?" }, 401));
    const outcome = await send(core(), spec(), options);
    expect(outcome.status).toBe(401);
    expect(outcome.parsed).toEqual({
      ok: false,
      message: null,
      error: { code: "unauthenticated", message: "who are you?", details: [] },
    });
    expect(outcomeLabel(outcome)).toBe("unauthenticated");
  });

  test("a binary answer has no text form", async () => {
    const { options } = fake(() => new Response(new Uint8Array([0x0a, 0x04, 0x0a, 0x02, 0x77, 0xff]), { status: 200 }));
    const outcome = await send(core(), spec({ transport: "connect-proto" }), options);
    expect(outcome.raw).toBeNull();
    expect(outcome.size).toBe(6);
    expect(outcome.parsed?.ok).toBe(false);
  });

  test("a request the core refuses is not sent", async () => {
    const { calls, options } = fake(() => json({}));
    expect(send(core(), spec({ body: '{"nope":1}' }), options)).rejects.toThrow(
      'the body is not a valid message: unknown field "nope"',
    );
    expect(send(core(), spec({ baseUrl: "" }), options)).rejects.toThrow("the base URL must start with");
    expect(calls).toEqual([]);
  });
});

describe("when no answer comes", () => {
  const refused = async (baseUrl: string, pageUrl = "https://docs.test/site/"): Promise<Outcome> => {
    const { options } = fake(() => {
      throw new TypeError("Failed to fetch");
    });
    return send(core(), spec({ baseUrl }), { ...options, pageUrl });
  };

  test("another origin: the API is down, or does not allow this one", async () => {
    const outcome = await refused("https://api.test");
    expect(outcome.status).toBe(0);
    expect(outcome.parsed).toBeNull();
    expect(outcome.failure?.kind).toBe("refused");
    expect(outcome.failure?.message).toContain("does not allow requests from https://docs.test (CORS)");
    expect(outcome.failure?.message).toContain("wirebook serve --target https://api.test");
    expect(outcomeLabel(outcome)).toBe("network");
  });

  test("the same origin: the server is down", async () => {
    const outcome = await refused("/proxy");
    expect(outcome.failure?.message).toBe("No answer from https://docs.test. Check that the server is running.");
  });

  test("an http API from an https page: the browser blocked it", async () => {
    const outcome = await refused("http://api.test");
    expect(outcome.failure?.message).toStartWith("The browser blocked the request: this page is served over https");
  });

  test("a URL that is none", () => {
    expect(explainNetworkFailure("http://[", "https://docs.test/")).toBe(
      "The request could not be sent: its URL is not valid.",
    );
  });

  test("cancelled by the person", async () => {
    const controller = new AbortController();
    const { options } = fake(() => {
      controller.abort();
      throw new DOMException("aborted", "AbortError");
    });
    const outcome = await send(core(), spec(), { ...options, signal: controller.signal });
    expect(outcome.failure).toEqual({ kind: "aborted", message: "Cancelled." });
    expect(outcomeLabel(outcome)).toBe("cancelled");
  });
});

describe("a server stream", () => {
  const watch = spec({ method: "fixture.v1.WidgetService/WatchWidgets", body: "{}" });
  const a = envelope(0, '{"widget":{"id":"a"}}');
  const b = envelope(0, '{"widget":{"id":"b"}}');
  const end = envelope(2, "{}");

  test("is read frame by frame, however the chunks fall", async () => {
    // The first chunk ends inside the second envelope.
    const first = new Uint8Array([...a, ...b.slice(0, 7)]);
    const second = new Uint8Array([...b.slice(7), ...end]);
    const { calls, options } = fake(() => streamOf([first, second]));
    const seen: Frame[] = [];
    const outcome = await send(core(), watch, { ...options, onFrame: (frame) => seen.push(frame) });

    expect((calls[0]!.init.headers as string[][])[0]).toEqual(["Content-Type", "application/connect+json"]);
    expect(outcome.frames).toEqual([
      { kind: "message", message: { widget: { id: "a" } } },
      { kind: "message", message: { widget: { id: "b" } } },
      { kind: "end", error: null, metadata: {} },
    ]);
    expect(seen).toEqual(outcome.frames);
    expect(outcome.parsed).toEqual({ ok: true, message: null, error: null });
    expect(outcome.size).toBe(a.length + b.length + end.length);
    expect(outcome.failure).toBeNull();
    expect(outcomeLabel(outcome)).toBe("ok");
  });

  test("that ends with an error says which", async () => {
    const failed = envelope(2, '{"error":{"code":"unavailable","message":"gone"}}');
    const { options } = fake(() => streamOf([a, failed]));
    const outcome = await send(core(), watch, options);
    expect(outcomeLabel(outcome)).toBe("unavailable");
    expect(outcome.failure).toBeNull();
  });

  test("that stops without its end is a failure", async () => {
    for (const chunks of [[a], [a, b.slice(0, 7)], []]) {
      const { options } = fake(() => streamOf(chunks));
      const outcome = await send(core(), watch, options);
      expect(outcome.failure).toEqual({ kind: "network", message: "The stream stopped before its end." });
      expect(outcome.frames.length).toBe(chunks.length > 0 ? 1 : 0);
    }
  });

  test("that breaks keeps the frames it had", async () => {
    const { options } = fake(() => streamOf([a], true));
    const outcome = await send(core(), watch, options);
    expect(outcome.status).toBe(200);
    expect(outcome.frames).toEqual([{ kind: "message", message: { widget: { id: "a" } } }]);
    expect(outcome.failure).toEqual({ kind: "network", message: "The connection was lost: reset by peer" });
  });

  test("that never started is an error like any other", async () => {
    const { options } = fake(() => json({ code: "permission_denied", message: "no" }, 403));
    const outcome = await send(core(), watch, options);
    expect(outcome.frames).toEqual([]);
    expect(outcomeLabel(outcome)).toBe("permission_denied");
  });

  test("a failure that is not an Error is still said", async () => {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.error("plain text");
      },
    });
    const { options } = fake(() => new Response(body, { status: 200 }));
    const outcome = await send(core(), watch, options);
    expect(outcome.failure).toEqual({ kind: "network", message: "The connection was lost: plain text" });
  });
});

describe("an answer that does not stop", () => {
  /** A body of `chunks` chunks of `size` bytes, made as they are read. */
  const endless = (size: number, chunks: number, fill = 0x20): { response: Response; cancelled: () => boolean } => {
    let sent = 0;
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (sent++ < chunks) controller.enqueue(new Uint8Array(size).fill(fill));
        else controller.close();
      },
      cancel() {
        cancelled = true;
      },
    });
    return { response: new Response(body, { status: 200 }), cancelled: () => cancelled };
  };

  test("is read up to a limit, then let go", async () => {
    const big = endless(4 * 1024 * 1024, 64);
    const { options } = fake(() => big.response);
    const outcome = await send(core(), spec(), options);
    expect(outcome.failure).toEqual({
      kind: "network",
      message: "The response is larger than 32 MB. The console stopped reading.",
    });
    expect(outcome.status).toBe(200);
    expect(outcome.parsed).toBeNull();
    // It stopped at the first chunk past the limit, and told the server.
    expect(outcome.size).toBe(MAX_BYTES + 4 * 1024 * 1024);
    expect(big.cancelled()).toBe(true);
  });

  test("a response at the limit is read whole", async () => {
    const { options } = fake(() => endless(MAX_BYTES / 8, 8).response);
    const outcome = await send(core(), spec(), options);
    expect(outcome.failure).toBeNull();
    expect(outcome.size).toBe(MAX_BYTES);
  });

  test("a frame that claims more than the limit is not waited for", async () => {
    // An envelope of 4 GB, of which the server sends the start for ever.
    const prefix = new Uint8Array([0, 0xff, 0xff, 0xff, 0xff]);
    let first = true;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.enqueue(first ? prefix : new Uint8Array(8 * 1024 * 1024));
        first = false;
      },
    });
    const { options } = fake(() => new Response(body, { status: 200 }));
    const outcome = await send(core(), spec({ method: "fixture.v1.WidgetService/WatchWidgets", body: "{}" }), options);
    expect(outcome.failure?.message).toBe("A frame of the stream is larger than 32 MB. The console stopped reading.");
    expect(outcome.frames).toEqual([]);
  });

  test("a stream keeps its last frames, and counts the ones it let go", async () => {
    const frame = envelope(0, '{"widget":{"id":"a"}}');
    const total = MAX_FRAMES + 25;
    const all = new Uint8Array(frame.length * total);
    for (let i = 0; i < total; i++) all.set(frame, i * frame.length);
    const { options } = fake(() => streamOf([all, envelope(2, "{}")]));
    let seen = 0;
    const outcome = await send(core(), spec({ method: "fixture.v1.WidgetService/WatchWidgets", body: "{}" }), {
      ...options,
      onFrame: () => seen++,
    });
    expect(seen).toBe(total + 1);
    expect(outcome.frames.length).toBe(MAX_FRAMES);
    expect(outcome.framesDropped).toBe(26);
    expect(outcome.frames.at(-1)).toEqual({ kind: "end", error: null, metadata: {} });
    expect(outcome.failure).toBeNull();
  });
});

test("a response with no body at all is an empty one", async () => {
  const { options } = fake(() => new Response(null, { status: 204 }));
  const outcome = await send(core(), spec({ transport: "rest" }), options);
  expect(outcome.size).toBe(0);
  expect(outcome.parsed).toEqual({ ok: true, message: {}, error: null });
});
