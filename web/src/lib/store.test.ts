import "fake-indexeddb/auto";

import { describe, expect, test } from "bun:test";

import { IndexedStore, MemoryStore, type Store, openStore } from "./store";

let databases = 0;
const stores: [string, () => Promise<Store>][] = [
  ["MemoryStore", async () => new MemoryStore()],
  ["IndexedStore", () => IndexedStore.open(indexedDB, `test-${databases++}`)],
];

describe.each(stores)("%s", (_name, open) => {
  test("keeps rows by id, per store", async () => {
    const store = await open();
    expect(await store.all("history")).toEqual([]);
    await store.put("history", { id: "a", n: 1 });
    await store.put("history", { id: "b", n: 2 });
    await store.put("history", { id: "a", n: 3 });
    await store.put("settings", { id: "a", other: true });
    const rows = await store.all<{ id: string; n: number }>("history");
    expect(rows.sort((x, y) => x.id.localeCompare(y.id))).toEqual([
      { id: "a", n: 3 },
      { id: "b", n: 2 },
    ]);

    await store.remove("history", "a");
    await store.remove("history", "never there");
    expect(await store.all("history")).toEqual([{ id: "b", n: 2 }]);
    await store.clear("history");
    expect(await store.all("history")).toEqual([]);
    expect(await store.all("settings")).toEqual([{ id: "a", other: true }]);
  });

  test("hands out copies, not the rows it holds", async () => {
    const store = await open();
    const row = { id: "a", list: [1] };
    await store.put("environments", row);
    row.list.push(2);
    const [read] = await store.all<typeof row>("environments");
    expect(read!.list).toEqual([1]);
    read!.list.push(3);
    expect((await store.all<typeof row>("environments"))[0]!.list).toEqual([1]);
  });
});

describe("openStore", () => {
  test("uses IndexedDB when there is one", async () => {
    expect(await openStore(indexedDB, `test-${databases++}`)).toBeInstanceOf(IndexedStore);
  });

  test("falls back to memory without one, or when it refuses", async () => {
    expect(await openStore(undefined, "x")).toBeInstanceOf(MemoryStore);
    const refusing = {
      open() {
        throw new DOMException("denied", "SecurityError");
      },
    } as unknown as IDBFactory;
    expect(await openStore(refusing, "x")).toBeInstanceOf(MemoryStore);
  });

  test("a request that fails rejects", async () => {
    const failing = {
      open() {
        const request = { error: new Error("blocked") } as unknown as IDBOpenDBRequest;
        queueMicrotask(() => request.onerror?.(new Event("error")));
        return request;
      },
    } as unknown as IDBFactory;
    expect(IndexedStore.open(failing, "x")).rejects.toThrow("blocked");
  });
});
