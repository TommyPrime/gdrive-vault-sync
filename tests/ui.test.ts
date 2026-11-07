import { describe, expect, it } from "vitest";
import { SyncLog } from "../src/ui/logView";
import { statusText } from "../src/ui/statusBar";

describe("SyncLog", () => {
  it("直近の 500 件だけを残す", () => {
    const log = new SyncLog(() => new Date(0));
    for (let i = 0; i < 501; i += 1) log.add(`m${i}`);
    const lines = log.text().split("\n");
    expect(lines).toHaveLength(500);
    expect(lines[0]).toContain("m1");
    expect(lines[499]).toContain("m500");
  });
});

describe("statusText", () => {
  it("状態を短く示す", () => {
    expect(statusText({ kind: "idle", conflicts: 0 })).toBe("Drive: 待機中");
    expect(statusText({ kind: "idle", conflicts: 2 })).toBe("Drive: 競合 2 件");
    expect(statusText({ kind: "syncing" })).toBe("Drive: 同期中");
    expect(statusText({ kind: "error" })).toBe("Drive: エラー");
    expect(statusText({ kind: "waiting" })).toBe("Drive: 確認待ち");
    expect(statusText({ kind: "trial", conflicts: 0 })).toBe("Drive: 試行中");
    expect(statusText({ kind: "trial", conflicts: 1 })).toBe("Drive: 試行中 競合 1 件");
  });
});
