// The core, typed. Every structure crosses the WebAssembly boundary as JSON
// text; this is the one place that parses it.
import init, { Explorer } from "../gen/core.js";
import type { BuiltRequest, Expect, Frames, Hit, Index, Parsed, RequestSpec, Validation } from "./types";

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
  static async load(wasm: BufferSource | WebAssembly.Module, image: Uint8Array, roots: string[]): Promise<Core> {
    await init({ module_or_path: wasm });
    return new Core(new Explorer(image, JSON.stringify(roots)));
  }

  /**
   * Another schema in the core that is already loaded. `wirebook serve`
   * reloads the page instead; this is for measuring, without the compile.
   */
  static loadAgain(image: Uint8Array, roots: string[]): Core {
    return new Core(new Explorer(image, JSON.stringify(roots)));
  }

  search(query: string, limit: number): Hit[] {
    return JSON.parse(this.explorer.search(query, limit)) as Hit[];
  }

  template(message: string): string {
    return this.explorer.template(message);
  }

  validate(message: string, json: string): Validation {
    return JSON.parse(this.explorer.validate(message, json)) as Validation;
  }

  /** The body without the fields the schema marks as sensitive. */
  scrub(message: string, json: string): { body: string; removed: number } {
    return JSON.parse(this.explorer.scrub(message, json)) as { body: string; removed: number };
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

  curl(spec: RequestSpec, redact: boolean): string {
    return this.explorer.curl(JSON.stringify(spec), redact);
  }

  response(expect: Expect, status: number, body: Uint8Array): Parsed {
    return JSON.parse(this.explorer.response(JSON.stringify(expect), status, body)) as Parsed;
  }

  frames(expect: Expect, buffer: Uint8Array): Frames {
    return JSON.parse(this.explorer.frames(JSON.stringify(expect), buffer)) as Frames;
  }
}
