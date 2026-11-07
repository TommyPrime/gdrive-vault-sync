import "fake-indexeddb/auto";
import { describe, expect, it } from "vitest";
import { IndexedDbStateStore } from "../src/state/store";
import type { RemoteFile } from "../src/sync/engine";
import type { BaseEntry } from "../src/sync/planner";

const entry: BaseEntry = { md5: "a", size: 1, mtime: 2, remoteId: "r", remoteMd5: "b" };
const file: RemoteFile = { id: "r", path: "日本語.md", md5: "b", size: 1 };

let n = 0;
const fresh = () => new IndexedDbStateStore(`test-${(n += 1)}`);

describe("IndexedDbStateStore", () => {
  it("最初は空", async () => {
    const store = fresh();
    await expect(store.load()).resolves.toEqual({
      base: new Map(),
      remote: new Map(),
      vaultId: null,
      pageToken: null,
    });
  });

  it("開き直しても残る", async () => {
    const name = `test-${(n += 1)}`;
    const first = new IndexedDbStateStore(name);
    await first.set("日本語.md", entry);
    await first.saveVaultId("v1");
    await first.saveRemote(new Map([["r", file]]), "t1");
    first.close();

    const state = await new IndexedDbStateStore(name).load();
    expect(state.base.get("日本語.md")).toEqual(entry);
    expect(state.remote.get("r")).toEqual(file);
    expect(state.vaultId).toBe("v1");
    expect(state.pageToken).toBe("t1");
  });

  it("delete で前回状態から消える", async () => {
    const store = fresh();
    await store.set("a.md", entry);
    await store.delete("a.md");
    expect((await store.load()).base.size).toBe(0);
  });

  it("saveRemote は一覧を置き換える", async () => {
    const store = fresh();
    await store.saveRemote(new Map([["old", file]]), "t1");
    await store.saveRemote(new Map([["new", file]]), "t2");
    const state = await store.load();
    expect([...state.remote.keys()]).toEqual(["new"]);
    expect(state.pageToken).toBe("t2");
  });

  it("__proto__ というパスでも壊れない", async () => {
    const store = fresh();
    await store.set("__proto__", entry);
    expect((await store.load()).base.get("__proto__")).toEqual(entry);
  });
});
