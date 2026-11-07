import { describe, expect, it } from "vitest";
import type { BaseEntry, LocalEntry, SyncAction, SyncPlan } from "../src/sync/planner";
import { type SafetyInput, evaluateSafety } from "../src/sync/safety";

const localEntry: LocalEntry = { md5: "a", size: 1, mtime: 1 };
const baseEntry: BaseEntry = { md5: "a", size: 1, mtime: 1, remoteId: "r", remoteMd5: "a" };

const paths = (...names: string[]) => new Map(names.map((name) => [name, localEntry]));
const bases = (...names: string[]) => new Map(names.map((name) => [name, baseEntry]));

const deletes = (count: number): SyncAction[] =>
  Array.from({ length: count }, (_, i) =>
    i % 2 === 0
      ? { type: "trashRemote", path: `${i}.md`, remoteId: "r" }
      : { type: "trashLocal", path: `${i}.md`, local: localEntry },
  );

const planOf = (actions: SyncAction[], totalPaths: number): SyncPlan => ({ actions, totalPaths });

function input(overrides: Partial<SafetyInput> = {}): SafetyInput {
  return {
    plan: planOf([], 100),
    local: paths("a.md"),
    base: bases("a.md"),
    driveRootFound: true,
    deviceVaultId: "v1",
    driveVaultId: "v1",
    ...overrides,
  };
}

describe("通常", () => {
  it("異常がなければ進める", () => {
    expect(evaluateSafety(input())).toEqual({ decision: "proceed", reasons: [] });
  });
});

describe("初回同期", () => {
  it("前回状態が無ければ承認を求める", () => {
    const result = evaluateSafety(input({ base: new Map(), deviceVaultId: null }));
    expect(result).toEqual({ decision: "confirm", reasons: ["first-sync"] });
  });
});

describe("削除が多いとき", () => {
  it("ちょうど 10% なら止めない", () => {
    expect(evaluateSafety(input({ plan: planOf(deletes(10), 100) })).decision).toBe("proceed");
  });

  it("10% を超えたら確認する", () => {
    const result = evaluateSafety(input({ plan: planOf(deletes(11), 100) }));
    expect(result).toEqual({ decision: "confirm", reasons: ["too-many-deletes"] });
  });

  it("ちょうど 50 件なら止めない", () => {
    expect(evaluateSafety(input({ plan: planOf(deletes(50), 1000) })).decision).toBe("proceed");
  });

  it("割合が小さくても 50 件を超えたら確認する", () => {
    const result = evaluateSafety(input({ plan: planOf(deletes(51), 100_000) }));
    expect(result.reasons).toContain("too-many-deletes");
  });

  it("端末側の削除も Drive 側の削除も数える", () => {
    const local: SyncAction[] = deletes(22).filter((action) => action.type === "trashLocal");
    const remote: SyncAction[] = deletes(22).filter((action) => action.type === "trashRemote");
    expect(evaluateSafety(input({ plan: planOf(local, 100) })).decision).toBe("confirm");
    expect(evaluateSafety(input({ plan: planOf(remote, 100) })).decision).toBe("confirm");
  });

  it("しきい値は変更できる", () => {
    const thresholds = { deleteRatio: 0.5, deleteCount: 1000 };
    expect(evaluateSafety(input({ plan: planOf(deletes(40), 100), thresholds })).decision).toBe(
      "proceed",
    );
  });

  it("不正なしきい値では安全装置を外さず、既定値を使う", () => {
    for (const thresholds of [
      { deleteRatio: Number.NaN, deleteCount: Number.NaN },
      { deleteRatio: -1, deleteCount: -1 },
      { deleteRatio: Number.POSITIVE_INFINITY, deleteCount: Number.POSITIVE_INFINITY },
    ]) {
      const result = evaluateSafety(input({ plan: planOf(deletes(11), 100), thresholds }));
      expect(result.decision).toBe("confirm");
    }
  });
});

describe("異常な状態（Q4）", () => {
  it("前回状態があるのに端末側が空なら止める", () => {
    const result = evaluateSafety(input({ local: new Map() }));
    expect(result).toEqual({ decision: "halt", reasons: ["local-empty"] });
  });

  it("空の判定から .obsidian/ を除く", () => {
    const result = evaluateSafety(input({ local: paths(".obsidian/app.json") }));
    expect(result.reasons).toContain("local-empty");
  });

  it("前回状態が無ければ、空の端末は初回のプレビューに任せる", () => {
    const result = evaluateSafety(
      input({ local: new Map(), base: new Map(), deviceVaultId: null }),
    );
    expect(result).toEqual({ decision: "confirm", reasons: ["first-sync"] });
  });

  it("前回状態が .obsidian/ だけなら、ノートの無い Vault を異常としない", () => {
    const result = evaluateSafety(
      input({ local: paths(".obsidian/app.json"), base: bases(".obsidian/app.json") }),
    );
    expect(result.decision).toBe("proceed");
  });

  it("`.obsidian-notes/` は .obsidian/ として扱わない", () => {
    const result = evaluateSafety(input({ local: paths(".obsidian-notes/a.md") }));
    expect(result.decision).toBe("proceed");
  });

  it("Drive のルートが見つからなければ止める", () => {
    const result = evaluateSafety(input({ driveRootFound: false }));
    expect(result.decision).toBe("halt");
    expect(result.reasons).toContain("drive-root-missing");
  });

  it("vaultId が違えば止める", () => {
    const result = evaluateSafety(input({ driveVaultId: "v2" }));
    expect(result).toEqual({ decision: "halt", reasons: ["vault-id-mismatch"] });
  });

  it("接続済みの端末で Drive の vaultId が読めなければ止める", () => {
    expect(evaluateSafety(input({ driveVaultId: null })).reasons).toContain("vault-id-mismatch");
  });

  it("未接続の端末は vaultId を比べない", () => {
    const result = evaluateSafety(input({ base: new Map(), deviceVaultId: null, driveVaultId: "v9" }));
    expect(result.reasons).not.toContain("vault-id-mismatch");
  });

  it("確認より停止を優先する", () => {
    const result = evaluateSafety(input({ plan: planOf(deletes(60), 100), driveVaultId: "v2" }));
    expect(result.decision).toBe("halt");
    expect(result.reasons).toEqual(["vault-id-mismatch", "too-many-deletes"]);
  });
});

describe("重複の整理", () => {
  it("ごみ箱へ移す重複も削除の件数に数える", () => {
    const actions: SyncAction[] = Array.from({ length: 51 }, (_, i) => ({
      type: "trashDuplicate",
      path: `${i}.md`,
      remoteId: `r${i}`,
    }));
    const result = evaluateSafety(input({ plan: planOf(actions, 100_000) }));
    expect(result).toEqual({ decision: "confirm", reasons: ["too-many-deletes"] });
  });

  it("名前を変えるだけの重複は削除に数えない", () => {
    const actions: SyncAction[] = Array.from({ length: 51 }, (_, i) => ({
      type: "renameDuplicate",
      path: `${i}.md`,
      remoteId: `r${i}`,
      conflictPath: `${i} (conflict).md`,
    }));
    expect(evaluateSafety(input({ plan: planOf(actions, 100) })).decision).toBe("proceed");
  });
});
