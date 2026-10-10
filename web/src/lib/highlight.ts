// Code, cut into the pieces a reader tells apart: keys, values, punctuation,
// comments, keywords. The page paints them with lightness, not with colour:
// the palette's colours are signals, and a block of code signals nothing.
// Each token is text; the page makes a text node of it.

export type Language = "json" | "curl" | "fetch" | "python" | "go" | "http";

export type Kind = "key" | "str" | "num" | "lit" | "punct" | "cmt" | "kw" | "text";

export interface Token {
  kind: Kind;
  text: string;
}

/** Above this, a block is one text node: a reader scrolls it, not reads it. */
export const MAX_HIGHLIGHTED = 64 * 1024;

const KEYWORDS: Record<Exclude<Language, "json" | "http">, Set<string>> = {
  curl: new Set(["curl"]),
  fetch: new Set(["const", "let", "await", "async", "function", "return", "new", "for", "of", "if", "else", "throw"]),
  python: new Set([
    "import",
    "from",
    "def",
    "return",
    "with",
    "as",
    "for",
    "in",
    "if",
    "else",
    "raise",
    "print",
    "None",
    "True",
    "False",
  ]),
  go: new Set([
    "package",
    "import",
    "func",
    "var",
    "const",
    "return",
    "if",
    "else",
    "for",
    "range",
    "defer",
    "err",
    "nil",
    "true",
    "false",
    "string",
    "byte",
    "int",
    "map",
    "struct",
    "type",
  ]),
};

const LITERALS = new Set(["true", "false", "null"]);

function isDigit(c: string): boolean {
  return c >= "0" && c <= "9";
}

function isWord(c: string): boolean {
  return (c >= "a" && c <= "z") || (c >= "A" && c <= "Z") || c === "_" || c === "$" || isDigit(c);
}

/** The end of a quoted string that starts at `start`, past its closing quote. */
function stringEnd(text: string, start: number): number {
  const quote = text[start]!;
  let i = start + 1;
  while (i < text.length) {
    if (text[i] === "\\" && quote !== "'") i += 2;
    else if (text[i] === quote) return i + 1;
    else if (text[i] === "\n" && quote !== "`") return i;
    else i++;
  }
  return text.length;
}

function push(out: Token[], kind: Kind, text: string): void {
  if (text === "") return;
  const last = out[out.length - 1];
  if (last && last.kind === kind) last.text += text;
  else out.push({ kind, text });
}

/** A JSON document: keys, strings, numbers, literals, punctuation. */
function json(text: string, out: Token[]): void {
  let i = 0;
  while (i < text.length) {
    const c = text[i]!;
    if (c === '"') {
      const end = stringEnd(text, i);
      let after = end;
      while (text[after] === " ") after++;
      push(out, text[after] === ":" ? "key" : "str", text.slice(i, end));
      i = end;
    } else if (isDigit(c) || (c === "-" && isDigit(text[i + 1] ?? ""))) {
      let end = i + 1;
      while (end < text.length && /[\d.eE+-]/.test(text[end]!)) end++;
      push(out, "num", text.slice(i, end));
      i = end;
    } else if (isWord(c)) {
      let end = i + 1;
      while (end < text.length && isWord(text[end]!)) end++;
      const word = text.slice(i, end);
      push(out, LITERALS.has(word) ? "lit" : "text", word);
      i = end;
    } else if ("{}[]:,".includes(c)) {
      push(out, "punct", c);
      i++;
    } else {
      push(out, "text", c);
      i++;
    }
  }
}

/** A request as sent: the verb and the URL, header names, then its body as JSON. */
function http(text: string, out: Token[]): void {
  const blank = text.indexOf("\n\n");
  const head = blank >= 0 ? text.slice(0, blank + 2) : text;
  const lines = head.split("\n");
  lines.forEach((line, n) => {
    if (n === 0) {
      const space = line.indexOf(" ");
      push(out, "kw", space >= 0 ? line.slice(0, space) : line);
      push(out, "text", space >= 0 ? line.slice(space) : "");
    } else {
      const colon = line.indexOf(":");
      push(out, "key", colon >= 0 ? line.slice(0, colon) : "");
      push(out, "punct", colon >= 0 ? ":" : "");
      push(out, "text", colon >= 0 ? line.slice(colon + 1) : line);
    }
    if (n < lines.length - 1) push(out, "text", "\n");
  });
  if (blank >= 0) {
    const body = text.slice(blank + 2);
    if (body.trimStart().startsWith("{") || body.trimStart().startsWith("[")) json(body, out);
    else push(out, "text", body);
  }
}

/** A snippet in a programming language, or a shell command. */
function source(text: string, language: Exclude<Language, "json" | "http">, out: Token[]): void {
  const keywords = KEYWORDS[language];
  const comment = language === "curl" || language === "python" ? "#" : "//";
  let i = 0;
  while (i < text.length) {
    const c = text[i]!;
    if (text.startsWith(comment, i)) {
      let end = text.indexOf("\n", i);
      if (end < 0) end = text.length;
      push(out, "cmt", text.slice(i, end));
      i = end;
    } else if (c === '"' || c === "'" || c === "`") {
      const end = stringEnd(text, i);
      push(out, "str", text.slice(i, end));
      i = end;
    } else if (isDigit(c) && !isWord(text[i - 1] ?? " ")) {
      let end = i + 1;
      while (end < text.length && /[\d.]/.test(text[end]!)) end++;
      push(out, "num", text.slice(i, end));
      i = end;
    } else if (isWord(c)) {
      let end = i + 1;
      while (end < text.length && isWord(text[end]!)) end++;
      const word = text.slice(i, end);
      push(out, keywords.has(word) ? "kw" : "text", word);
      i = end;
    } else if (c === "-" && language === "curl" && (isWord(text[i + 1] ?? "") || text[i + 1] === "-")) {
      // A flag: -X, --header.
      let end = i + 1;
      while (end < text.length && (isWord(text[end]!) || text[end] === "-")) end++;
      push(out, "key", text.slice(i, end));
      i = end;
    } else if ("{}[]():,;=.<>+-*/&|!".includes(c)) {
      push(out, "punct", c);
      i++;
    } else {
      push(out, "text", c);
      i++;
    }
  }
}

export function tokens(text: string, language: Language): Token[] {
  if (text.length > MAX_HIGHLIGHTED) return [{ kind: "text", text }];
  const out: Token[] = [];
  if (language === "json") json(text, out);
  else if (language === "http") http(text, out);
  else source(text, language, out);
  return out;
}
