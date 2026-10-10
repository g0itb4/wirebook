// The shapes that cross between the core (WebAssembly), the site's config
// and the page. The core's side of each is in crates/core/src.

export interface Index {
  files: FileDoc[];
  services: ServiceDoc[];
  messages: MessageDoc[];
  enums: EnumDoc[];
  /** What in the site's config could not be used, and why. */
  problems: string[];
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
  /** The rules of the message as a whole, each in a few words. */
  rules: string[];
  fields: FieldDoc[];
}

/** How to list the resource a field refers to. */
export interface Reference {
  resource: string;
  /** `package.Service/Method`: the list that is called. */
  method: string;
  items: string;
  label: string | null;
  pageSize: [string, number] | null;
  pageToken: [string, string] | null;
  params: { field: string; needed: boolean }[];
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
  /** The schema says a request is refused without it. */
  required: boolean;
  /** What the schema asks of a value, each rule in a few words. */
  rules: string[];
  /** A value the schema gives as an example. */
  example: unknown;
  reference: Reference | null;
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

/** A rule of the schema that a body does not meet. */
export interface Violation {
  path: string;
  message: string;
}

export type Language = "curl" | "fetch" | "python" | "go";

/** A resource to pick: its id, and a name to know it by. */
export interface Item {
  id: string;
  label: string;
}

export type Variables = Record<string, string>;

export interface RequestSpec {
  method: string;
  body: string;
  transport: Transport;
  baseUrl: string;
  headers: HeaderSpec[];
  auth: Auth;
  binding: number;
  timeoutMs: number | null;
  variables: Variables;
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
  /** Values several requests share, written `{{name}}`. Not secrets. */
  variables: Variables;
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
  /** One line on what the API is, for the home page. Empty when the config gives none. */
  description: string;
  roots: string[];
  environments: { name: string; baseUrl: string; directUrl?: string; variables?: Variables }[];
  /** The list a field's value is picked from, where the convention finds none. */
  lookups: Record<string, string | null>;
  /** The schemes the API accepts. Empty means all four are offered. */
  auth: AuthSetting[];
  /** The footer's links beside the one to wirebook: https URLs, checked at build. */
  links: { label: string; url: string }[];
  /** Set by `wirebook serve`: reload when the protos change. */
  liveReload: boolean;
}
