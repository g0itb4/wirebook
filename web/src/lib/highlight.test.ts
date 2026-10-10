import { expect, test } from "bun:test";

import { MAX_HIGHLIGHTED, type Token, tokens } from "./highlight";

const kinds = (list: Token[]): string => list.map((token) => `${token.kind}:${token.text}`).join("|");

test("JSON: keys, strings, numbers, literals and punctuation", () => {
  const text = '{\n  "id": "w1",\n  "n": -1.5e3,\n  "ok": true,\n  "none": null,\n  "list": [1, "a"]\n}';
  const list = tokens(text, "json");
  expect(list.filter((t) => t.kind === "key").map((t) => t.text)).toEqual(['"id"', '"n"', '"ok"', '"none"', '"list"']);
  expect(list.filter((t) => t.kind === "str").map((t) => t.text)).toEqual(['"w1"', '"a"']);
  expect(list.filter((t) => t.kind === "num").map((t) => t.text)).toEqual(["-1.5e3", "1"]);
  expect(list.filter((t) => t.kind === "lit").map((t) => t.text)).toEqual(["true", "null"]);
  // The pieces put back together are the text.
  expect(list.map((t) => t.text).join("")).toBe(text);
});

test("JSON: a key with an escaped quote, a bare word, and a string left open", () => {
  expect(kinds(tokens('{"a\\"b": x', "json"))).toBe('punct:{|key:"a\\"b"|punct::|text: x');
  expect(kinds(tokens('"open', "json"))).toBe('str:"open');
  expect(kinds(tokens('"line\nbreak"', "json"))).toBe('str:"line|text:\nbreak|str:"');
});

test("a request as sent: the verb, the header names, then the body as JSON", () => {
  const list = tokens('POST https://x/y\nContent-Type: application/json\nno colon\n\n{"id": "w1"}', "http");
  expect(list[0]).toEqual({ kind: "kw", text: "POST" });
  expect(list.filter((t) => t.kind === "key").map((t) => t.text)).toEqual(["Content-Type", '"id"']);
  expect(list.map((t) => t.text).join("")).toContain("no colon");
  // No body, or a body that is not JSON.
  expect(kinds(tokens("GET https://x", "http"))).toBe("kw:GET|text: https://x");
  expect(kinds(tokens("GET\n\n(binary body)", "http"))).toBe("kw:GET|text:\n\n(binary body)");
});

test("curl: the command, its flags, strings and a comment", () => {
  const list = tokens("curl -X POST --header 'A: b' \"$TOKEN\" 'it''s' # note\nnext", "curl");
  expect(list[0]).toEqual({ kind: "kw", text: "curl" });
  expect(list.filter((t) => t.kind === "key").map((t) => t.text)).toEqual(["-X", "--header"]);
  expect(list.filter((t) => t.kind === "str").map((t) => t.text)).toEqual(["'A: b'", '"$TOKEN"', "'it''s'"]);
  expect(list.filter((t) => t.kind === "cmt").map((t) => t.text)).toEqual(["# note"]);
  expect(list.map((t) => t.text).join("")).toContain("\nnext");
});

test("fetch, Python and Go: keywords, numbers, punctuation, and comments to the end", () => {
  const js = tokens("const r = await fetch(`u`, {method: 'POST'}); // go\nx1 = 12.5", "fetch");
  expect(js.filter((t) => t.kind === "kw").map((t) => t.text)).toEqual(["const", "await"]);
  expect(js.filter((t) => t.kind === "str").map((t) => t.text)).toEqual(["`u`", "'POST'"]);
  expect(js.filter((t) => t.kind === "cmt").map((t) => t.text)).toEqual(["// go"]);
  expect(js.filter((t) => t.kind === "num").map((t) => t.text)).toEqual(["12.5"]);
  const py = tokens("import json\ndef f():\n    return None # end", "python");
  expect(py.filter((t) => t.kind === "kw").map((t) => t.text)).toEqual(["import", "def", "return", "None"]);
  const go = tokens('package main\nfunc main() { var s string = "x" }', "go");
  expect(go.filter((t) => t.kind === "kw").map((t) => t.text)).toEqual(["package", "func", "var", "string"]);
  expect(
    go
      .filter((t) => t.kind === "punct")
      .map((t) => t.text)
      .join(""),
  ).toBe("(){=}");
});

test("a long block is one piece of text", () => {
  const text = `{"a": "${"x".repeat(MAX_HIGHLIGHTED)}"}`;
  expect(tokens(text, "json")).toEqual([{ kind: "text", text }]);
});
