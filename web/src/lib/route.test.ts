import { describe, expect, test } from "bun:test";

import { href, namer, packages, resolve, shortName, title } from "./route";
import { core } from "./testing";

const index = core().index;

describe("resolve", () => {
  test("the empty hash is the home page", () => {
    expect(resolve(index, "").kind).toBe("home");
    expect(resolve(index, "#").kind).toBe("home");
    expect(resolve(index, "#/").kind).toBe("home");
  });

  test("a name is looked up as a service, a message, then an enum", () => {
    const service = resolve(index, "#/fixture.v1.WidgetService");
    expect(service.kind === "service" && service.service.name).toBe("fixture.v1.WidgetService");
    const message = resolve(index, "#/fixture.v1.Widget.Part");
    expect(message.kind === "message" && message.message.name).toBe("fixture.v1.Widget.Part");
    const enumeration = resolve(index, "#/fixture.v1.Colour");
    expect(enumeration.kind === "enum" && enumeration.enumeration.name).toBe("fixture.v1.Colour");
  });

  test("a method is its service, a slash, its name", () => {
    const route = resolve(index, href("fixture.v1.WidgetService/GetWidget"));
    expect(route.kind === "method" && route.method.path).toBe("fixture.v1.WidgetService/GetWidget");
    expect(route.kind === "method" && route.service.name).toBe("fixture.v1.WidgetService");
  });

  test("what the schema lacks is missing, and says what was asked for", () => {
    expect(resolve(index, "#/no.Such")).toEqual({ kind: "missing", target: "no.Such" });
    expect(resolve(index, "#/fixture.v1.WidgetService/Nope")).toEqual({
      kind: "missing",
      target: "fixture.v1.WidgetService/Nope",
    });
    expect(resolve(index, "#/no.Service/GetWidget").kind).toBe("missing");
  });

  test("an escaped address is unescaped, and a broken escape is taken as written", () => {
    expect(resolve(index, "#/fixture.v1.WidgetService%2FGetWidget").kind).toBe("method");
    expect(resolve(index, "#/%E0%A4%A")).toEqual({ kind: "missing", target: "%E0%A4%A" });
  });
});

test("the tab is named after the page", () => {
  const name = (hash: string) => title(resolve(index, hash), "Fixture");
  expect(name("")).toBe("Fixture");
  expect(name("#/fixture.v1.WidgetService")).toBe("WidgetService · Fixture");
  expect(name("#/fixture.v1.WidgetService/GetWidget")).toBe("GetWidget · Fixture");
  expect(name("#/fixture.v1.Widget")).toBe("Widget · Fixture");
  expect(name("#/fixture.v1.Colour")).toBe("Colour · Fixture");
  expect(name("#/nope")).toBe("Not found · Fixture");
});

test("a short name keeps the nesting when the package is known", () => {
  expect(shortName("fixture.v1.Widget.Part")).toBe("Part");
  expect(shortName("fixture.v1.Widget.Part", "fixture.v1")).toBe("Widget.Part");
  expect(shortName("Bare", "")).toBe("Bare");
  expect(shortName("other.Thing", "fixture.v1")).toBe("Thing");
});

test("the navigation groups by package, the site's own first", () => {
  const groups = packages(index);
  expect(groups.map((group) => [group.name, group.imported])).toEqual([
    ["fixture.legacy.v1", false],
    ["fixture.v1", false],
    ["google.protobuf", true],
    ["buf.validate", true],
    ["google.api", true],
  ]);
  const own = groups[1]!;
  expect(own.services.map((service) => service.name)).toEqual([
    "fixture.v1.CatalogService",
    "fixture.v1.WidgetService",
    "fixture.v1.LibraryService",
  ]);
  expect(own.messages.some((message) => message.name === "fixture.v1.Widget.Part")).toBe(true);
  expect(own.enums.map((enumeration) => enumeration.name)).toEqual([
    "fixture.v1.GadgetKind",
    "fixture.v1.Colour",
    "fixture.v1.Size",
  ]);
});

test("a name is shortened by the package that declares it", () => {
  const short = namer(index);
  expect(short("fixture.v1.Widget.Part")).toBe("Widget.Part");
  expect(short("fixture.v1.WidgetService")).toBe("WidgetService");
  expect(short("fixture.v1.Colour")).toBe("Colour");
  expect(short("google.protobuf.Timestamp")).toBe("Timestamp");
  expect(short("not.in.the.Schema")).toBe("Schema");
});
