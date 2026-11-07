import type { RemoteFile, StateStore, SyncState } from "../sync/engine";
import type { BaseEntry } from "../sync/planner";

const BASE = "base";
const REMOTE = "remote";
const META = "meta";

function done(request: IDBRequest): Promise<void> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
  });
}

function value<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function committed(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error);
  });
}

/** 前回状態を端末の IndexedDB に置く。Vault には書かない。 */
export class IndexedDbStateStore implements StateStore {
  private database: Promise<IDBDatabase> | null = null;

  constructor(private readonly name: string) {}

  private open(): Promise<IDBDatabase> {
    this.database ??= new Promise((resolve, reject) => {
      const request = indexedDB.open(this.name, 1);
      request.onupgradeneeded = () => {
        for (const store of [BASE, REMOTE, META]) request.result.createObjectStore(store);
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    return this.database;
  }

  async load(): Promise<SyncState> {
    const db = await this.open();
    const transaction = db.transaction([BASE, REMOTE, META], "readonly");
    const read = async <T>(storeName: string) => {
      const store = transaction.objectStore(storeName);
      const keys = value(store.getAllKeys());
      const values = value(store.getAll() as IDBRequest<T[]>);
      const [k, v] = await Promise.all([keys, values]);
      return new Map(k.map((key, index) => [String(key), v[index]!]));
    };
    const [base, remote, meta] = await Promise.all([
      read<BaseEntry>(BASE),
      read<RemoteFile>(REMOTE),
      read<string>(META),
    ]);
    return {
      base,
      remote,
      vaultId: meta.get("vaultId") ?? null,
      pageToken: meta.get("pageToken") ?? null,
    };
  }

  async set(path: string, entry: BaseEntry): Promise<void> {
    const db = await this.open();
    await done(db.transaction(BASE, "readwrite").objectStore(BASE).put(entry, path));
  }

  async delete(path: string): Promise<void> {
    const db = await this.open();
    await done(db.transaction(BASE, "readwrite").objectStore(BASE).delete(path));
  }

  /** 一覧と pageToken は片方だけ進むと差分を取りこぼすので、1 つのトランザクションで書く。 */
  async saveRemote(
    remote: ReadonlyMap<string, RemoteFile>,
    pageToken: string | null,
  ): Promise<void> {
    const db = await this.open();
    const transaction = db.transaction([REMOTE, META], "readwrite");
    const store = transaction.objectStore(REMOTE);
    store.clear();
    for (const [id, file] of remote) store.put(file, id);
    transaction.objectStore(META).put(pageToken, "pageToken");
    await committed(transaction);
  }

  async saveVaultId(vaultId: string): Promise<void> {
    const db = await this.open();
    await done(db.transaction(META, "readwrite").objectStore(META).put(vaultId, "vaultId"));
  }

  close(): void {
    void this.database?.then((db) => db.close());
    this.database = null;
  }
}
