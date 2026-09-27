// The shapes that cross between the core (WebAssembly), the site's config
// and the page. The core's side of each is in crates/core/src.

export interface Index {
  files: FileDoc[];
  services: ServiceDoc[];
  messages: MessageDoc[];
  enums: EnumDoc[];
}

export interface FileDoc {
  name: string;
  package: string;
  edition: string;
  imported: boolean;
}

export interface ServiceDoc {
  name: string;
  file: string;
  imported: boolean;
  doc: string;
  deprecated: boolean;
  methods: MethodDoc[];
}

export type Transport = "connect-json" | "connect-proto" | "connect-get" | "rest";

export interface Binding {
  verb: string;
  path: string;
  body: string;
}

export interface MethodDoc {
  name: string;
  /** `package.Service/Method`: the key of every call to the core. */
  path: string;
  doc: string;
  deprecated: boolean;
  input: string;
  output: string;
  clientStreaming: boolean;
  serverStreaming: boolean;
  idempotency: "" | "no_side_effects" | "idempotent";
  http: Binding[];
  transports: Transport[];
}

export interface MessageDoc {
  name: string;
  file: string;
  imported: boolean;
  doc: string;
  deprecated: boolean;
  fields: FieldDoc[];
}

export interface FieldDoc {
  name: string;
  jsonName: string;
  number: number;
  cardinality: "singular" | "repeated" | "map";
  kind: "scalar" | "enum" | "message";
  type: string;
  mapKey: string | null;
  presence: "" | "explicit" | "implicit" | "required";
  oneof: string | null;
  doc: string;
  deprecated: boolean;
}

export interface EnumDoc {
  name: string;
  file: string;
  imported: boolean;
  doc: string;
  deprecated: boolean;
  closed: boolean;
  values: { name: string; number: number; doc: string; deprecated: boolean }[];
}

export interface Hit {
  kind: "service" | "method" | "message" | "field" | "enum" | "value";
  name: string;
  page: string;
  doc: string;
}

export interface Validation {
  ok: boolean;
  message: string;
  line: number;
  column: number;
}

/** The credential of a request, as the core takes it. */
export type Auth =
  | { scheme: "none" }
  | { scheme: "bearer"; token: string }
  | { scheme: "basic"; username: string; password: string }
  | { scheme: "api-key"; name: string; value: string; location: "header" | "query" };

export interface HeaderSpec {
  name: string;
  value: string;
}

export interface RequestSpec {
  method: string;
  body: string;
  transport: Transport;
  baseUrl: string;
  headers: HeaderSpec[];
  auth: Auth;
  binding: number;
  timeoutMs: number | null;
}

export interface Expect {
  framing: "unary" | "stream" | "rest";
  codec: "json" | "proto";
  message: string;
}

export interface BuiltRequest {
  verb: string;
  url: string;
  redactedUrl: string;
  headers: { name: string; value: string; redacted: string | null }[];
  bodyText: string | null;
  expect: Expect;
}

export interface RpcError {
  code: string;
  message: string;
  details: { type: string; value: unknown; debug: unknown }[];
}

export interface Parsed {
  ok: boolean;
  message: unknown;
  error: RpcError | null;
}

export type Frame =
  | { kind: "message"; message: unknown }
  | { kind: "end"; error: RpcError | null; metadata: Record<string, string[]> }
  | { kind: "invalid"; reason: string };

export interface Frames {
  consumed: number;
  frames: Frame[];
}

/** How an environment authenticates, without the secret. */
export type AuthSetting =
  | { scheme: "none" }
  | { scheme: "bearer" }
  | { scheme: "basic"; username: string }
  | { scheme: "api-key"; name: string; location: "header" | "query" };

export interface Environment {
  id: string;
  name: string;
  baseUrl: string;
  auth: AuthSetting;
  headers: HeaderSpec[];
  /** Came with the site, from its config. It can be changed, not removed. */
  builtin: boolean;
  /**
   * Where the API really is, when `baseUrl` is the proxy of `wirebook serve`.
   * A copied curl command goes there: curl has no use for the proxy.
   */
  directUrl?: string;
}

/** config.json, written by `wirebook build`. It never holds a secret. */
export interface SiteConfig {
  /** Which API this is: sites served from one address keep separate stores. */
  id: string;
  title: string;
  roots: string[];
  environments: { name: string; baseUrl: string; directUrl?: string }[];
  /** The schemes the API accepts. Empty means all four are offered. */
  auth: AuthSetting[];
  /** Set by `wirebook serve`: reload when the protos change. */
  liveReload: boolean;
}
