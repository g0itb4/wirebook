// What the page keeps between visits, in the browser's own IndexedDB: the
// environments someone added, the history of calls, and a secret only when
// they asked for it to be remembered. There is no server to keep it.

export const STORES = ["environments", "history", "secrets", "settings"] as const;
export type StoreName = (typeof STORES)[number];

export interface Row {
  id: string;
}

/** A row whose other fields the caller did not name. */
export type AnyRow = Row & Record<string, unknown>;

export interface Store {
  all<T extends Row = AnyRow>(store: StoreName): Promise<T[]>;
  put<T extends Row>(store: StoreName, row: T): Promise<void>;
  remove(store: StoreName, id: string): Promise<void>;
  clear(store: StoreName): Promise<void>;
}

/** The store of a page whose browser has no IndexedDB, and of the tests. */
export class MemoryStore implements Store {
  private readonly rows = new Map<StoreName, Map<string, Row>>();

  private of(store: StoreName): Map<string, Row> {
    let rows = this.rows.get(store);
    if (!rows) {
      rows = new Map();
      this.rows.set(store, rows);
    }
    return rows;
  }

  async all<T extends Row = AnyRow>(store: StoreName): Promise<T[]> {
    return [...this.of(store).values()].map((row) => structuredClone(row) as T);
  }

  async put<T extends Row>(store: StoreName, row: T): Promise<void> {
    this.of(store).set(row.id, structuredClone(row));
  }

  async remove(store: StoreName, id: string): Promise<void> {
    this.of(store).delete(id);
  }

  async clear(store: StoreName): Promise<void> {
    this.of(store).clear();
  }
}

function done<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

export class IndexedStore implements Store {
  private constructor(private readonly db: IDBDatabase) {}

  static async open(factory: IDBFactory, name: string): Promise<IndexedStore> {
    const request = factory.open(name, 1);
    request.onupgradeneeded = () => {
      for (const store of STORES) request.result.createObjectStore(store, { keyPath: "id" });
    };
    return new IndexedStore(await done(request));
  }

  private store(store: StoreName, mode: IDBTransactionMode): IDBObjectStore {
    return this.db.transaction(store, mode).objectStore(store);
  }

  all<T extends Row = AnyRow>(store: StoreName): Promise<T[]> {
    return done(this.store(store, "readonly").getAll()) as Promise<T[]>;
  }

  async put<T extends Row>(store: StoreName, row: T): Promise<void> {
    await done(this.store(store, "readwrite").put(row));
  }

  async remove(store: StoreName, id: string): Promise<void> {
    await done(this.store(store, "readwrite").delete(id));
  }

  async clear(store: StoreName): Promise<void> {
    await done(this.store(store, "readwrite").clear());
  }
}

/**
 * IndexedDB when the browser has it and allows it; otherwise memory, and the
 * page works for the length of the visit.
 */
export async function openStore(factory: IDBFactory | undefined, name: string): Promise<Store> {
  if (factory) {
    try {
      return await IndexedStore.open(factory, name);
    } catch {
      // Private browsing in some browsers, or storage turned off.
    }
  }
  return new MemoryStore();
}
