// The core, typed. Every structure crosses the WebAssembly boundary as JSON
// text; this is the one place that parses it.
import init, { Explorer } from "../gen/core.js";
import type {
  BuiltRequest,
  Expect,
  Frames,
  Hit,
  Index,
  Item,
  Language,
  Parsed,
  RequestSpec,
  Validation,
  Variables,
  Violation,
} from "./types";

/** What the site's build tells the core. */
export interface Options {
  roots: string[];
  lookups: Record<string, string | null>;
}

export interface Prepared {
  request: BuiltRequest;
  body: Uint8Array | undefined;
}

export class Core {
  readonly index: Index;

  private constructor(private readonly explorer: Explorer) {
    this.index = JSON.parse(explorer.index()) as Index;
  }

  /**
   * `wasm` is the core, compiled or as bytes; `image` the descriptor set of
   * the site. Instantiation is asynchronous: a browser refuses to compile a
   * module of this size on its main thread any other way.
   */
  static async load(wasm: BufferSource | WebAssembly.Module, image: Uint8Array, options: Options): Promise<Core> {
    await init({ module_or_path: wasm });
    return new Core(new Explorer(image, JSON.stringify(options)));
  }

  /**
   * Another schema in the core that is already loaded. `wirebook serve`
   * reloads the page instead; this is for measuring, without the compile.
   */
  static loadAgain(image: Uint8Array, options: Options): Core {
    return new Core(new Explorer(image, JSON.stringify(options)));
  }

  search(query: string, limit: number): Hit[] {
    return JSON.parse(this.explorer.search(query, limit)) as Hit[];
  }

  /** An example body: variables named as a field, the schema's examples, zero values. */
  template(message: string, variables: Variables): string {
    return this.explorer.template(message, JSON.stringify(variables));
  }

  validate(message: string, json: string, variables: Variables): Validation {
    return JSON.parse(this.explorer.validate(message, json, JSON.stringify(variables))) as Validation;
  }

  /** The schema's rules that a valid body does not meet. Warnings: the server decides. */
  check(message: string, json: string, variables: Variables): Violation[] {
    return JSON.parse(this.explorer.check(message, json, JSON.stringify(variables))) as Violation[];
  }

  /** The body without the fields the schema marks as sensitive. */
  scrub(message: string, json: string, variables: Variables): { body: string; removed: number } {
    return JSON.parse(this.explorer.scrub(message, json, JSON.stringify(variables))) as {
      body: string;
      removed: number;
    };
  }

  /** Throws an `Error` whose message says why the request cannot be made. */
  request(spec: RequestSpec): Prepared {
    const built = this.explorer.request(JSON.stringify(spec));
    try {
      return { request: JSON.parse(built.describe()) as BuiltRequest, body: built.body() };
    } finally {
      built.free();
    }
  }

  /** The request as code. With `redact`, the credential is read from the environment. */
  snippet(spec: RequestSpec, language: Language, redact: boolean): string {
    return this.explorer.snippet(JSON.stringify(spec), language, redact);
  }

  response(expect: Expect, status: number, body: Uint8Array): Parsed {
    return JSON.parse(this.explorer.response(JSON.stringify(expect), status, body)) as Parsed;
  }

  frames(expect: Expect, buffer: Uint8Array): Frames {
    return JSON.parse(this.explorer.frames(JSON.stringify(expect), buffer)) as Frames;
  }

  /**
   * The request that lists the resource a field refers to. `field` is
   * `package.Message.field`; `context` holds what is known, by JSON name.
   * Throws when the list needs something that is not there.
   */
  lookupRequest(field: string, context: Record<string, unknown>, pageToken: string): { method: string; body: string } {
    return JSON.parse(this.explorer.lookup_request(field, JSON.stringify(context), pageToken)) as {
      method: string;
      body: string;
    };
  }

  lookupRead(field: string, response: unknown): { items: Item[]; next: string } {
    return JSON.parse(this.explorer.lookup_read(field, JSON.stringify(response))) as { items: Item[]; next: string };
  }

  /** The ids of resources in a response message, wherever they are in it. */
  seen(message: string, response: unknown): (Item & { resource: string })[] {
    return JSON.parse(this.explorer.seen(message, JSON.stringify(response))) as (Item & { resource: string })[];
  }
}
