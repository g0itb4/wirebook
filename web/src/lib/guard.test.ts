import { expect, test } from "bun:test";

import { framedByAnotherSite } from "./guard";

const own = { origin: "https://docs.example" };

test("a page in a tab of its own is not framed", () => {
  const page = { location: own } as { top: unknown; self: unknown; location: { origin: string } };
  page.top = page;
  page.self = page;
  expect(framedByAnotherSite(page)).toBe(false);
});

test("a frame of the same site is allowed", () => {
  const page = { top: { location: { origin: "https://docs.example" } }, self: {}, location: own };
  expect(framedByAnotherSite(page)).toBe(false);
});

test("a frame of another site is not, whether its origin can be read or not", () => {
  const readable = { top: { location: { origin: "https://evil.example" } }, self: {}, location: own };
  expect(framedByAnotherSite(readable)).toBe(true);
  // A browser throws when a page reads into a frame of another origin.
  const opaque = {
    top: {
      get location(): never {
        throw new DOMException("Blocked a frame with origin", "SecurityError");
      },
    },
    self: {},
    location: own,
  };
  expect(framedByAnotherSite(opaque)).toBe(true);
});
