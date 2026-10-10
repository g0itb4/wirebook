import { expect, test } from "bun:test";

import { matches, summary, words } from "./filter";

test("every word of the query is in the name, case aside, in any order", () => {
  expect(matches("get widget", "GetWidget")).toBe(true);
  expect(matches("widget GET", "fixture.v1.WidgetService/GetWidget")).toBe(true);
  expect(matches("gadget", "GetWidget")).toBe(false);
  expect(matches("", "anything")).toBe(true);
  expect(matches("   ", "anything")).toBe(true);
  expect(words("  a  b ")).toEqual(["a", "b"]);
});

test("the line under the filter: nothing, a count, or no match", () => {
  expect(summary("", 10, 10)).toBe("");
  expect(summary("wid", 3, 40)).toBe("3 of 40");
  expect(summary(" zzz ", 0, 40)).toBe("Nothing in the menu matches “zzz”.");
});
