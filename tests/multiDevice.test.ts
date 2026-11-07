import { beforeEach, describe, expect, it } from "vitest";
import { type RemoteFile, type StateStore, SyncEngine, type SyncState } from "../src/sync/engine";
import { type BaseEntry, plan } from "../src/sync/planner";
import { FakeDrive } from "./fakes/fakeDrive";
import { type Clock, FakeVault } from "./fakes/fakeVault";

class FatalError extends Error {}

class MemoryStore implements StateStore {
  readonly base = new Map<string, BaseEntry>();
  remote = new Map<string, RemoteFile>();
  vaultId: string | null = null;
  pageToken: string | null = null;

  async load(): Promise<SyncState> {
    return {
      base: new Map(this.base),
      remote: new Map(this.remote),
      vaultId: this.vaultId,
      pageToken: this.pageToken,
    };
  }

  async set(path: string, entry: BaseEntry) {
    this.base.set(path, entry);
  }

  async delete(path: string) {
    this.base.delete(path);
  }

  async saveRemote(remote: ReadonlyMap<string, RemoteFile>, pageToken: string | null) {
    this.remote = new Map(remote);
    this.pageToken = pageToken;
  }

  async saveVaultId(vaultId: string) {
    this.vaultId = vaultId;
  }
}

class Device {
  readonly vault: FakeVault;
  readonly store = new MemoryStore();
  confirmCalls = 0;
  private approve = false;
  private readonly engine: SyncEngine;

  constructor(
    private readonly name: string,
    private readonly drive: FakeDrive,
    private readonly clock: Clock,
  ) {
    this.vault = new FakeVault(clock);
    this.engine = new SyncEngine(() => ({
      store: this.store,
      drive: this.drive,
      local: this.vault,
      scan: async () => this.vault.scan(),
      now: () => this.clock.now,
      deviceName: this.name,
      newVaultId: () => "vault-1",
      confirm: async () => {
        this.confirmCalls += 1;
        return this.approve;
      },
      isFatal: (error) => error instanceof FatalError,
    }));
  }

  get base() {
    return this.store.base;
  }

  /** approve はプレビューでの承認にあたる。halt は承認しても実行しない。 */
  async sync(options: { approve?: boolean; dryRun?: boolean; auto?: boolean } = {}) {
    // 同期の前に時間を進め、直前の編集が「3 秒以内」に当たらないようにする。
    this.clock.now += 10_000;
    this.approve = options.approve ?? false;
    return this.engine.run({ dryRun: options.dryRun, interactive: !options.auto });
  }

  verify() {
    return this.engine.verify();
  }

  concurrentRuns() {
    return Promise.all([this.engine.run(), this.engine.run()]);
  }
}

describe("複数端末", () => {
  let clock: Clock;
  let drive: FakeDrive;
  let a: Device;
  let b: Device;

  beforeEach(() => {
    clock = { now: new Date(2026, 10, 7, 12, 0).getTime() };
    drive = new FakeDrive();
    a = new Device("Mac", drive, clock);
    b = new Device("Windows", drive, clock);
  });

  /** A のノートを Drive 経由で B へ揃える。 */
  async function connectBoth(notes: Record<string, string>) {
    for (const [path, text] of Object.entries(notes)) a.vault.edit(path, text);
    await a.sync({ approve: true });
    await b.sync({ approve: true });
  }

  const driveHas = (path: string) => drive.list().has(path);

  it("初回は承認されるまで何も書かない", async () => {
    a.vault.edit("a.md", "1");
    const { safety, result } = await a.sync();

    expect(safety).toEqual({ decision: "confirm", reasons: ["first-sync"] });
    expect(result).toBeUndefined();
    expect(drive.list().size).toBe(0);
    expect(drive.vaultId).toBeNull();
    expect(a.store.vaultId).toBeNull();
  });

  it("空の Vault で 2 台目を接続すると、全件を受け取る", async () => {
    await connectBoth({ "a.md": "1", "日記/今日.md": "2" });
    expect(b.vault.snapshot()).toEqual({ "a.md": "1", "日記/今日.md": "2" });
  });

  it("A の編集が B に届く", async () => {
    await connectBoth({ "a.md": "1" });
    a.vault.edit("a.md", "2");
    await a.sync();
    await b.sync();
    expect(b.vault.text("a.md")).toBe("2");
  });

  it("Obsidian の外からの編集もハッシュの差分として拾う", async () => {
    await connectBoth({ "a.md": "12345" });
    const before = a.vault.scan().get("a.md")!;
    a.vault.editKeepingMtime("a.md", "54321");
    expect(a.vault.scan().get("a.md")).toMatchObject({ size: before.size, mtime: before.mtime });

    await a.sync();
    await b.sync();
    expect(b.vault.text("a.md")).toBe("54321");
  });

  it("同じファイルを 2 台で変えたら、両方の内容が全端末に残る", async () => {
    await connectBoth({ "a.md": "base" });
    a.vault.edit("a.md", "from A");
    b.vault.edit("a.md", "from B");

    await a.sync();
    await b.sync();
    await a.sync();

    const copy = b.vault.paths().find((path) => path.includes("(conflict "))!;
    expect(copy).toMatch(/^a \(conflict \d{4}-\d{2}-\d{2} \d{4} Windows\)\.md$/);
    expect(b.vault.text("a.md")).toBe("from A");
    expect(b.vault.text(copy)).toBe("from B");
    expect(a.vault.snapshot()).toEqual(b.vault.snapshot());
  });

  it("A の削除は、Drive でも B でもごみ箱へ移るだけ", async () => {
    const notes = Object.fromEntries(
      Array.from({ length: 10 }, (_, i) => [`${i}.md`, `note ${i}`]),
    );
    await connectBoth(notes);

    a.vault.remove("0.md");
    await a.sync();
    await b.sync();

    expect(driveHas("0.md")).toBe(false);
    expect(drive.trashedPaths()).toEqual(["0.md"]);
    expect(b.vault.text("0.md")).toBeUndefined();
    expect(b.vault.trashed).toEqual([{ path: "0.md", text: "note 0" }]);
  });

  it("A の削除と B の変更がぶつかったら、変更が残る", async () => {
    await connectBoth({ "a.md": "1", "b.md": "2" });
    a.vault.remove("a.md");
    b.vault.edit("a.md", "keep me");

    await b.sync();
    await a.sync();

    expect(a.vault.text("a.md")).toBe("keep me");
    expect(driveHas("a.md")).toBe(true);
  });

  it("A の変更と B の削除がぶつかったら、Drive に作り直して残す", async () => {
    await connectBoth({ "a.md": "1", "b.md": "2", "c.md": "3", "d.md": "4", "e.md": "5" });
    await connectBoth({ "f.md": "6", "g.md": "7", "h.md": "8", "i.md": "9", "j.md": "10" });
    b.vault.remove("a.md");
    a.vault.edit("a.md", "keep me");

    await b.sync();
    await a.sync();
    await b.sync();

    expect(driveHas("a.md")).toBe(true);
    expect(b.vault.text("a.md")).toBe("keep me");
  });

  it("名前の変更は削除＋新規として伝わる", async () => {
    await connectBoth({ "old.md": "text", "x.md": "x", "y.md": "y" });
    a.vault.remove("old.md");
    a.vault.edit("new.md", "text");

    await a.sync({ approve: true });
    await b.sync({ approve: true });

    expect(b.vault.paths()).toEqual(["new.md", "x.md", "y.md"]);
    expect(drive.trashedPaths()).toEqual(["old.md"]);
  });

  it("Vault が消えた端末は止まり、Drive に手を付けない", async () => {
    await connectBoth({ "a.md": "1", "b.md": "2" });
    a.vault.clear();

    const { safety, result } = await a.sync({ approve: true });

    expect(safety?.decision).toBe("halt");
    expect(safety?.reasons).toContain("local-empty");
    expect(result).toBeUndefined();
    expect(drive.trashedPaths()).toEqual([]);
  });

  it("Drive が空に見えても、確認なしに端末のノートを動かさない", async () => {
    await connectBoth({ "a.md": "1", "b.md": "2" });
    for (const entry of drive.list().values()) await drive.trash(entry.id);

    const { safety, result } = await a.sync();

    expect(safety?.reasons).toEqual(["too-many-deletes"]);
    expect(result).toBeUndefined();
    expect(a.vault.paths()).toEqual(["a.md", "b.md"]);
  });

  it("別の Vault の Drive には同期しない", async () => {
    await connectBoth({ "a.md": "1" });
    drive.vaultId = "vault-2";

    const { safety, result } = await a.sync({ approve: true });

    expect(safety?.decision).toBe("halt");
    expect(safety?.reasons).toContain("vault-id-mismatch");
    expect(result).toBeUndefined();
  });

  it("途中で通信が切れても、次回は続きから揃う", async () => {
    a.vault.edit("a.md", "1");
    a.vault.edit("b.md", "2");
    a.vault.edit("c.md", "3");
    drive.failUploads = 1;

    const first = await a.sync({ approve: true });
    expect(first.result?.failed).toHaveLength(1);
    expect(a.base.size).toBe(2);

    await a.sync();
    expect(drive.list().size).toBe(3);
  });

  it("端末への書き込みに失敗したファイルは飛ばし、前回状態を更新しない", async () => {
    await connectBoth({ "a.md": "1", "b.md": "2" });
    a.vault.edit("a.md", "new a");
    a.vault.edit("b.md", "new b");
    await a.sync();

    b.vault.failWrites = 1;
    const first = await b.sync();
    expect(first.result?.failed).toHaveLength(1);
    expect(first.result?.done).toHaveLength(1);

    await b.sync();
    expect(b.vault.snapshot()).toEqual({ "a.md": "new a", "b.md": "new b" });
  });

  it("競合の取り込みに失敗しても、端末版は失わない", async () => {
    await connectBoth({ "a.md": "base" });
    a.vault.edit("a.md", "from A");
    await a.sync();
    b.vault.edit("a.md", "from B");
    drive.failUploads = 1;

    await b.sync();

    expect(b.vault.text("a.md")).toBe("from B");

    await b.sync();
    await a.sync();
    expect(Object.values(a.vault.snapshot())).toEqual(
      expect.arrayContaining(["from A", "from B"]),
    );
  });

  it("同期の途中で保存されたファイルは、上書きしない", async () => {
    await connectBoth({ "a.md": "1" });
    a.vault.edit("a.md", "2");
    await a.sync();

    b.vault.beforeRead = () => {
      b.vault.beforeRead = null;
      b.vault.edit("a.md", "just typed");
    };
    const { result } = await b.sync();

    expect(result?.skipped).toHaveLength(1);
    expect(b.vault.text("a.md")).toBe("just typed");
  });

  it("3 秒以内に編集したファイルは、今回は上書きせず次回に判定する", async () => {
    await connectBoth({ "a.md": "1" });
    a.vault.edit("a.md", "2");
    await a.sync();

    clock.now += 100_000;
    b.vault.edit("a.md", "typing");
    const scanned = b.vault.scan();
    const deferred = plan({
      local: scanned,
      remote: drive.list(),
      base: b.base,
      now: clock.now + 1_000,
      deviceName: "Windows",
    });

    expect(deferred.actions).toEqual([{ type: "deferred", path: "a.md" }]);
    expect(b.vault.text("a.md")).toBe("typing");
  });

  it("試行モードは計画を返すだけで、Drive にも端末にも前回状態にも書かない", async () => {
    await connectBoth({ "a.md": "1", "b.md": "2", "c.md": "3", "d.md": "4", "e.md": "5" });
    await connectBoth({ "f.md": "6", "g.md": "7", "h.md": "8", "i.md": "9", "j.md": "10" });
    a.vault.edit("new.md", "x");
    a.vault.edit("a.md", "changed");
    a.vault.remove("b.md");
    await drive.upload("from-drive.md", new TextEncoder().encode("y"));
    const vaultBefore = a.vault.snapshot();
    const driveBefore = [...drive.list().keys()];
    const stateBefore = JSON.stringify([...a.base, a.store.pageToken]);
    const confirmsBefore = a.confirmCalls;

    const outcome = await a.sync({ dryRun: true, approve: true });

    expect(outcome.status).toBe("dry-run");
    expect(outcome.plan?.actions.map((action) => action.type).sort()).toEqual([
      "download",
      "trashRemote",
      "upload",
      "upload",
    ]);
    expect(a.confirmCalls).toBe(confirmsBefore);
    expect(a.vault.snapshot()).toEqual(vaultBefore);
    expect([...drive.list().keys()]).toEqual(driveBefore);
    expect(JSON.stringify([...a.base, a.store.pageToken])).toBe(stateBefore);
  });

  it("初回の試行モードは vault.json を作らない", async () => {
    a.vault.edit("a.md", "1");
    await a.sync({ dryRun: true });
    expect(drive.vaultId).toBeNull();
  });

  it("2 回目以降は全件を取らず、差分だけを取る", async () => {
    await connectBoth({ "a.md": "1" });
    await a.sync();
    const calls = drive.listAllCalls;

    a.vault.edit("a.md", "2");
    await a.sync();
    await b.sync();
    await a.sync();

    expect(drive.listAllCalls).toBe(calls);
    expect(b.vault.text("a.md")).toBe("2");
  });

  it("pageToken が失効したら、全件を取り直して続ける", async () => {
    await connectBoth({ "a.md": "1" });
    await b.sync();
    a.vault.edit("a.md", "2");
    await a.sync();
    drive.expireTokens = true;

    await b.sync();

    expect(b.vault.text("a.md")).toBe("2");
  });

  it("接続済みの端末で Drive のフォルダが見つからなければ止める", async () => {
    await connectBoth({ "a.md": "1" });
    drive.rootFound = false;

    const outcome = await a.sync({ approve: true });

    expect(outcome.status).toBe("halted");
    expect(outcome.safety?.reasons).toContain("drive-root-missing");
    expect(a.vault.paths()).toEqual(["a.md"]);
  });

  it("同時に 2 つ実行しようとしても、1 つしか走らない", async () => {
    await connectBoth({ "a.md": "1" });
    const outcomes = await a.concurrentRuns();
    expect(outcomes.map((outcome) => outcome.status).sort()).toEqual(["busy", "done"]);
  });

  it("容量不足のような失敗では、残りを始めない", async () => {
    await connectBoth({ "a.md": "1" });
    for (let i = 0; i < 20; i += 1) a.vault.edit(`n${i}.md`, `${i}`);
    drive.uploadError = new FatalError("quota");
    drive.failUploads = 1000;

    const outcome = await a.sync();

    expect(outcome.result?.failed.length).toBeLessThanOrEqual(3);
    expect(outcome.result?.done).toHaveLength(0);
  });

  it("照合で端末と Drive の差を見つける", async () => {
    await connectBoth({ "a.md": "1", "b.md": "2" });
    await expect(a.verify()).resolves.toEqual({
      matched: 2,
      localOnly: [],
      remoteOnly: [],
      different: [],
    });

    a.vault.edit("a.md", "changed");
    a.vault.edit("new.md", "x");
    a.vault.remove("b.md");
    await expect(a.verify()).resolves.toEqual({
      matched: 0,
      localOnly: ["new.md"],
      remoteOnly: ["b.md"],
      different: ["a.md"],
    });
  });

  it("無作為な編集を重ねても、全端末が揃い、最後の内容が失われない", async () => {
    // 再現できるよう固定の種で回す。
    let seed = 20261107;
    const random = (n: number) => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed % n;
    };
    const names = ["a.md", "b.md", "日記/c.md", "d.png"];
    await connectBoth(Object.fromEntries(names.map((name) => [name, `start ${name}`])));

    for (let round = 0; round < 200; round += 1) {
      const written: string[] = [];
      for (const device of [a, b]) {
        const name = names[random(names.length)]!;
        if (random(4) === 0) {
          device.vault.remove(name);
        } else {
          const text = `round ${round} ${written.length}`;
          device.vault.edit(name, text);
          written.push(text);
        }
      }

      for (const device of [a, b, a, b]) await device.sync({ approve: true });

      expect(a.vault.snapshot()).toEqual(b.vault.snapshot());
      expect(Object.keys(a.vault.snapshot()).sort()).toEqual([...drive.list().keys()].sort());
      for (const text of written) {
        expect(Object.values(a.vault.snapshot())).toContain(text);
      }
    }
  });

  describe("同じパスのファイルが Drive に 2 つできたとき（Q9）", () => {
    /** 2 台が互いの結果を見ないまま同じパスの新規ファイルを上げた状態を作る。 */
    async function raceNewFile(path: string, textA: string, textB: string) {
      // 1 件の削除が 10% を超えて確認に回らないよう、ノートを増やす。
      await connectBoth(Object.fromEntries(Array.from({ length: 20 }, (_, i) => [`${i}.md`, `${i}`])));
      a.vault.edit(path, textA);
      b.vault.edit(path, textB);
      clock.now += 10_000;
      await Promise.all([a.sync(), b.sync()]);
      expect((await drive.listAll()).filter((file) => file.path === path)).toHaveLength(2);
    }

    const settle = async () => {
      for (const device of [a, b, a, b]) await device.sync();
    };

    it("内容が違えば両方の内容が両方の端末に残り、Drive の重複は解消する", async () => {
      await raceNewFile("new.md", "from Mac", "from Windows");
      await settle();

      const texts = Object.values(a.vault.snapshot());
      expect(texts).toContain("from Mac");
      expect(texts).toContain("from Windows");
      expect(a.vault.snapshot()).toEqual(b.vault.snapshot());
      expect(a.vault.paths().filter((path) => path.startsWith("new"))).toHaveLength(2);

      const files = await drive.listAll();
      expect(new Set(files.map((file) => file.path)).size).toBe(files.length);
      expect(drive.trashedPaths()).toEqual([]);
    });

    it("内容が同じなら 1 つだけ残し、もう一方はごみ箱へ移す", async () => {
      await raceNewFile("new.md", "same", "same");
      await settle();

      expect(a.vault.paths().filter((path) => path.startsWith("new"))).toEqual(["new.md"]);
      expect(a.vault.snapshot()).toEqual(b.vault.snapshot());
      expect(drive.trashedPaths()).toEqual(["new.md"]);
    });

    it("試行では Drive を変えない", async () => {
      await raceNewFile("new.md", "from Mac", "from Windows");
      const { plan } = await a.sync({ dryRun: true });

      expect(plan?.actions.map((action) => action.type)).toContain("renameDuplicate");
      expect((await drive.listAll()).filter((file) => file.path === "new.md")).toHaveLength(2);
    });

    it("2 台が同時に整理しても内容を失わない", async () => {
      await raceNewFile("new.md", "from Mac", "from Windows");
      await a.sync({ dryRun: true });
      clock.now += 10_000;
      await Promise.all([a.sync(), b.sync()]);
      await settle();

      expect(Object.values(a.vault.snapshot())).toContain("from Mac");
      expect(Object.values(a.vault.snapshot())).toContain("from Windows");
      expect(a.vault.snapshot()).toEqual(b.vault.snapshot());
    });
  });

  describe("自動実行", () => {
    it("初回は確認画面を開かず、何も書かずに止まる", async () => {
      a.vault.edit("a.md", "1");
      const { status } = await a.sync({ auto: true });

      expect(status).toBe("needs-confirm");
      expect(a.confirmCalls).toBe(0);
      expect(drive.list().size).toBe(0);
      expect(drive.vaultId).toBeNull();
    });

    it("手動で承認した後は自動で動く", async () => {
      await connectBoth({ "a.md": "1", "b.md": "2", "c.md": "3" });
      a.vault.edit("a.md", "2");
      await a.sync({ auto: true });
      await b.sync({ auto: true });
      expect(b.vault.text("a.md")).toBe("2");
    });

    it("削除が多いときは確認画面を開かず、何も消さずに止まる", async () => {
      await connectBoth({ "a.md": "1", "b.md": "2", "c.md": "3" });
      a.vault.remove("a.md");
      a.vault.remove("b.md");
      const confirmed = a.confirmCalls;
      const { status, safety } = await a.sync({ auto: true });

      expect(status).toBe("needs-confirm");
      expect(safety?.reasons).toEqual(["too-many-deletes"]);
      expect(a.confirmCalls).toBe(confirmed);
      expect(driveHas("a.md")).toBe(true);
      expect(driveHas("b.md")).toBe(true);
    });
  });

  describe("競合コピーの数", () => {
    it("端末に残っている競合コピーを数える", async () => {
      await connectBoth({ "a.md": "1", "b.md": "2", "c.md": "3" });
      a.vault.edit("a.md", "mac");
      b.vault.edit("a.md", "win");
      await a.sync();
      expect((await b.sync()).conflictCopies).toBe(1);
      expect((await b.sync()).conflictCopies).toBe(1);

      const copy = b.vault.paths().find((path) => path.includes("(conflict"))!;
      b.vault.remove(copy);
      expect((await b.sync()).conflictCopies).toBe(0);
    });
  });
});
