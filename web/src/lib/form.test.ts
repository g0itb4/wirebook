import { describe, expect, test } from "bun:test";

import { fromInput, getAt, initial, messageOf, oneofs, parseBody, pathKey, setAt, stringify, widgetFor } from "./form";
import { core } from "./testing";
import type { FieldDoc } from "./types";

const index = core().index;
const fieldOf = (message: string, name: string): FieldDoc =>
  messageOf(index, message)!.fields.find((field) => field.name === name)!;

test("a body is a value when it is JSON, and nothing when it is not yet", () => {
  expect(parseBody('{"a": [1]}')).toEqual({ a: [1] });
  expect(parseBody('{"a": ')).toBeUndefined();
  expect(stringify({ a: [1] })).toBe('{\n  "a": [\n    1\n  ]\n}');
});

describe("reading and writing by path", () => {
  const body = { id: "g", spare: { title: "s" }, bundle: [{ title: "a" }, { title: "b" }], labels: { k: "v" } };

  test("a value is read where it is, and is nothing where it is not", () => {
    expect(getAt(body, [])).toBe(body);
    expect(getAt(body, ["id"])).toBe("g");
    expect(getAt(body, ["spare", "title"])).toBe("s");
    expect(getAt(body, ["bundle", 1, "title"])).toBe("b");
    expect(getAt(body, ["labels", "k"])).toBe("v");
    for (const path of [["nope"], ["id", "x"], ["bundle", 5], ["bundle", "x"], ["spare", 0]]) {
      expect(getAt(body, path)).toBeUndefined();
    }
  });

  test("a write returns a copy, and leaves the original", () => {
    const next = setAt(body, ["spare", "title"], "t") as typeof body;
    expect(next.spare.title).toBe("t");
    expect(body.spare.title).toBe("s");
    expect(next.bundle).toBe(body.bundle);
  });

  test("what is on the way and missing is made", () => {
    expect(setAt({}, ["spare", "bundle", 0, "title"], "x")).toEqual({ spare: { bundle: [{ title: "x" }] } });
    expect(setAt(undefined, ["a"], 1)).toEqual({ a: 1 });
    // What is in the way and is not a holder gives way.
    expect(setAt({ a: "text" }, ["a", "b"], 1)).toEqual({ a: { b: 1 } });
    expect(setAt({ a: "text" }, ["a", 0], 1)).toEqual({ a: [1] });
    expect(setAt(body, [], 5)).toBe(5);
  });

  test("writing nothing takes a field or an item away", () => {
    expect(setAt(body, ["id"], undefined)).not.toHaveProperty("id");
    expect((setAt(body, ["bundle", 0], undefined) as typeof body).bundle).toEqual([{ title: "b" }]);
    expect((setAt(body, ["labels", "k"], undefined) as { labels: object }).labels).toEqual({});
    // Deeper, it is the inner field that goes.
    expect(setAt(body, ["spare", "title"], undefined)).toMatchObject({ spare: {} });
  });
});

test("a path is written as the core writes it in a warning", () => {
  expect(pathKey([])).toBe("");
  expect(pathKey(["rackId"])).toBe("rackId");
  expect(pathKey(["gadget", "bundle", 0, "title"])).toBe("gadget.bundle[0].title");
  // The key of a map is quoted.
  expect(pathKey(["sparesBySlot", "left", "rackId"], [1])).toBe('sparesBySlot["left"].rackId');
});

describe("the widget of a field", () => {
  test("follows its type", () => {
    const widget = (message: string, name: string) => widgetFor(fieldOf(message, name));
    expect(widget("fixture.v1.Gadget", "title")).toBe("text");
    expect(widget("fixture.v1.Gadget", "seal")).toBe("text");
    expect(widget("fixture.v1.Gadget", "slots")).toBe("number");
    expect(widget("fixture.v1.Gadget", "weight_kg")).toBe("number");
    expect(widget("fixture.v1.Gadget", "serial")).toBe("digits");
    expect(widget("fixture.v1.Gadget", "boxed")).toBe("checkbox");
    expect(widget("fixture.v1.Gadget", "kind")).toBe("enum");
    expect(widget("fixture.v1.Gadget", "spare")).toBe("message");
    // A list and a map are edited one value at a time.
    expect(widget("fixture.v1.Gadget", "tags")).toBe("text");
    expect(widget("fixture.v1.Gadget", "spares_by_slot")).toBe("message");
  });

  test("a well-known type is edited as its JSON form", () => {
    const widget = (name: string) => widgetFor(fieldOf("fixture.legacy.v1.WellKnown", name));
    for (const name of [
      "timestamp",
      "duration",
      "field_mask",
      "string_wrapper",
      "bytes_wrapper",
      "int64_wrapper",
      "uint64_wrapper",
    ]) {
      expect(widget(name)).toBe("known-text");
    }
    for (const name of ["double_wrapper", "float_wrapper", "int32_wrapper", "uint32_wrapper"]) {
      expect(widget(name)).toBe("number");
    }
    expect(widget("bool_wrapper")).toBe("checkbox");
    for (const name of ["struct_value", "value", "list_value", "empty", "any"]) expect(widget(name)).toBe("json");
  });
});

test("what is typed becomes the JSON value it stands for", () => {
  expect(fromInput("text", "abc")).toBe("abc");
  expect(fromInput("text", "")).toBeUndefined();
  expect(fromInput("number", "12")).toBe(12);
  expect(fromInput("number", "-0.5")).toBe(-0.5);
  expect(fromInput("number", "")).toBeUndefined();
  // As proto JSON writes them, and as a variable is written.
  expect(fromInput("number", "Infinity")).toBe("Infinity");
  expect(fromInput("number", "NaN")).toBe("NaN");
  expect(fromInput("number", "{{count}}")).toBe("{{count}}");
  // 64 bits do not fit a JavaScript number: digits stay text.
  expect(fromInput("digits", "9007199254740993")).toBe("9007199254740993");
  expect(fromInput("known-text", "3s")).toBe("3s");
});

test("a new value starts at the zero of its type", () => {
  const start = (message: string, name: string) => initial(index, fieldOf(message, name));
  expect(start("fixture.v1.Gadget", "title")).toBe("");
  expect(start("fixture.v1.Gadget", "slots")).toBe(0);
  expect(start("fixture.v1.Gadget", "serial")).toBe("0");
  expect(start("fixture.v1.Gadget", "boxed")).toBe(false);
  expect(start("fixture.v1.Gadget", "kind")).toBe("GADGET_KIND_UNSPECIFIED");
  expect(start("fixture.v1.Gadget", "spare")).toEqual({});
  expect(start("fixture.legacy.v1.WellKnown", "timestamp")).toBe("");
  expect(start("fixture.legacy.v1.WellKnown", "value")).toBeNull();
  // An enum the schema does not hold: its number.
  expect(initial(index, { ...fieldOf("fixture.v1.Gadget", "kind"), type: "no.Such" })).toBe(0);
});

test("the members of a oneof are found together", () => {
  const groups = oneofs(messageOf(index, "fixture.v1.Widget")!);
  expect([...groups.keys()]).toEqual(["source"]);
  expect(groups.get("source")!.map((field) => field.name)).toEqual(["factory", "salvaged_from"]);
  expect(oneofs(messageOf(index, "fixture.v1.Gadget")!).size).toBe(0);
  expect(messageOf(index, "no.Such")).toBeUndefined();
});
