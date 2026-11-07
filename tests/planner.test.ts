import { describe, expect, it } from "vitest";
import { conflictPath, isConflictCopy } from "../src/sync/conflict";
import {
  type BaseEntry,
  type LocalEntry,
  type PlanInput,
  type RemoteEntry,
  type SyncAction,
  plan,
} from "../src/sync/planner";

const NOW = new Date(2026, 10, 7, 16, 30).getTime();
const OLD = NOW - 60_000;
const PATH = "note.md";

const local = (md5: string, mtime = OLD): LocalEntry => ({ md5, size: 1, mtime });
const remote = (md5: string, id = "r1"): RemoteEntry => ({ id, md5, size: 1 });
const base = (md5: string): BaseEntry => ({
  md5,
  size: 1,
  mtime: OLD,
  remoteId: "r1",
  remoteMd5: md5,
});

function planOne(l?: LocalEntry, r?: RemoteEntry, b?: BaseEntry, extra: Partial<PlanInput> = {}) {
  return plan({
    local: new Map(l ? [[PATH, l]] : []),
    remote: new Map(r ? [[PATH, r]] : []),
    base: new Map(b ? [[PATH, b]] : []),
    now: NOW,
    deviceName: "Mac",
    ...extra,
  }).actions;
}

const conflictName = "note (conflict 2026-11-07 1630 Mac).md";

describe("判定表（設計書 4.5）", () => {
  const rows: {
    name: string;
    l?: LocalEntry;
    r?: RemoteEntry;
    b?: BaseEntry;
    expected: SyncAction[];
  }[] = [
    {
      name: "変更なし / 変更なし → 何もしない",
      l: local("a"),
      r: remote("a"),
      b: base("a"),
      expected: [],
    },
    {
      name: "変更あり / 変更なし → upload",
      l: local("b"),
      r: remote("a"),
      b: base("a"),
      expected: [{ type: "upload", path: PATH, local: local("b"), remoteId: "r1" }],
    },
    {
      name: "変更なし / 変更あり → download",
      l: local("a"),
      r: remote("b"),
      b: base("a"),
      expected: [{ type: "download", path: PATH, remote: remote("b"), local: local("a") }],
    },
    {
      name: "変更あり / 変更あり（同じ MD5）→ 前回状態の更新のみ",
      l: local("b"),
      r: remote("b"),
      b: base("a"),
      expected: [{ type: "record", path: PATH, local: local("b"), remote: remote("b") }],
    },
    {
      name: "変更あり / 変更あり（違う MD5）→ 競合",
      l: local("b"),
      r: remote("c"),
      b: base("a"),
      expected: [
        {
          type: "conflict",
          path: PATH,
          local: local("b"),
          remote: remote("c"),
          conflictPath: conflictName,
        },
      ],
    },
    {
      name: "新規 / なし → upload",
      l: local("a"),
      expected: [{ type: "upload", path: PATH, local: local("a") }],
    },
    {
      name: "なし / 新規 → download",
      r: remote("a"),
      expected: [{ type: "download", path: PATH, remote: remote("a") }],
    },
    {
      name: "新規 / 新規（同じ MD5）→ 前回状態に登録",
      l: local("a"),
      r: remote("a"),
      expected: [{ type: "record", path: PATH, local: local("a"), remote: remote("a") }],
    },
    {
      name: "新規 / 新規（違う MD5）→ 競合",
      l: local("a"),
      r: remote("b"),
      expected: [
        {
          type: "conflict",
          path: PATH,
          local: local("a"),
          remote: remote("b"),
          conflictPath: conflictName,
        },
      ],
    },
    {
      name: "削除 / 変更なし → Drive 側を trash",
      r: remote("a"),
      b: base("a"),
      expected: [{ type: "trashRemote", path: PATH, remoteId: "r1" }],
    },
    {
      name: "削除 / 変更あり → download で復活",
      r: remote("b"),
      b: base("a"),
      expected: [{ type: "download", path: PATH, remote: remote("b") }],
    },
    {
      name: "変更なし / 削除 → 端末側を .trash/ へ",
      l: local("a"),
      b: base("a"),
      expected: [{ type: "trashLocal", path: PATH, local: local("a") }],
    },
    {
      name: "変更あり / 削除 → upload で復活（新しいファイルとして作る）",
      l: local("b"),
      b: base("a"),
      expected: [{ type: "upload", path: PATH, local: local("b") }],
    },
    {
      name: "削除 / 削除 → 前回状態から消す",
      b: base("a"),
      expected: [{ type: "forget", path: PATH }],
    },
  ];

  it.each(rows)("$name", ({ l, r, b, expected }) => {
    expect(planOne(l, r, b)).toEqual(expected);
  });
});

describe("最後の変更から 3 秒以内", () => {
  const recent = NOW - 2_999;

  it("download で上書きせず、次回へ回す", () => {
    expect(planOne(local("a", recent), remote("b"), base("a"))).toEqual([
      { type: "deferred", path: PATH },
    ]);
  });

  it("競合も次回へ回す（Q7）", () => {
    expect(planOne(local("b", recent), remote("c"), base("a"))).toEqual([
      { type: "deferred", path: PATH },
    ]);
  });

  it("ちょうど 3 秒経っていれば実行する", () => {
    expect(planOne(local("a", NOW - 3_000), remote("b"), base("a"))[0]?.type).toBe("download");
  });

  it("端末にファイルが無ければ上書きにならないので回さない", () => {
    expect(planOne(undefined, remote("b"), base("a"))[0]?.type).toBe("download");
  });

  it("upload は回さない", () => {
    expect(planOne(local("b", recent), remote("a"), base("a"))[0]?.type).toBe("upload");
  });
});

describe("除外", () => {
  const isExcluded = (path: string) => path === PATH;

  it("除外したパスは、端末に無くても削除として扱わない", () => {
    expect(planOne(undefined, remote("a"), base("a"), { isExcluded })).toEqual([]);
  });

  it("除外したパスは、Drive に無くても端末から動かさない", () => {
    expect(planOne(local("a"), undefined, base("a"), { isExcluded })).toEqual([]);
  });
});

describe("計画全体", () => {
  it("全体の件数は除外を除いたパスの和集合", () => {
    const result = plan({
      local: new Map([
        ["a.md", local("1")],
        ["skip.md", local("1")],
      ]),
      remote: new Map([["b.md", remote("1")]]),
      base: new Map([["c.md", base("1")]]),
      now: NOW,
      deviceName: "Mac",
      isExcluded: (path) => path === "skip.md",
    });
    expect(result.totalPaths).toBe(3);
  });

  it("同じ名前の競合コピーがすでにあれば、上書きしない名前にする", () => {
    const result = plan({
      local: new Map([
        ["note.md", local("b")],
        [conflictName, local("x")],
      ]),
      remote: new Map([["note.md", remote("c")]]),
      base: new Map([["note.md", base("a")]]),
      now: NOW,
      deviceName: "Mac",
    });
    const conflict = result.actions.find((action) => action.type === "conflict");
    expect(conflict).toMatchObject({ conflictPath: "note (conflict 2026-11-07 1630 Mac 2).md" });
  });

  it("入力を書き換えない", () => {
    const input = {
      local: new Map([[PATH, local("b")]]),
      remote: new Map([[PATH, remote("c")]]),
      base: new Map([[PATH, base("a")]]),
      now: NOW,
      deviceName: "Mac",
    };
    const before = JSON.stringify([...input.local, ...input.remote, ...input.base]);
    plan(input);
    expect(JSON.stringify([...input.local, ...input.remote, ...input.base])).toBe(before);
  });
});

describe("conflictPath", () => {
  const when = new Date(2026, 0, 2, 3, 4);

  it.each([
    ["日記/今日.md", "日記/今日 (conflict 2026-01-02 0304 Mac).md"],
    ["a.tar.gz", "a.tar (conflict 2026-01-02 0304 Mac).gz"],
    ["拡張子なし", "拡張子なし (conflict 2026-01-02 0304 Mac)"],
    [".hidden", ".hidden (conflict 2026-01-02 0304 Mac)"],
    ["v1.0/README", "v1.0/README (conflict 2026-01-02 0304 Mac)"],
  ])("%s", (path, expected) => {
    expect(conflictPath(path, when, "Mac")).toBe(expected);
  });

  it("端末名のパスに使えない文字を置き換える", () => {
    expect(conflictPath("a.md", when, 'A/B:C*?"<>|')).toBe(
      "a (conflict 2026-01-02 0304 A-B-C------).md",
    );
  });

  it("端末名が空でも名前を作れる", () => {
    expect(conflictPath("a.md", when, "  ")).toBe("a (conflict 2026-01-02 0304 device).md");
  });

  it("使用済みの名前を避ける", () => {
    const taken = new Set([
      "a (conflict 2026-01-02 0304 Mac).md",
      "a (conflict 2026-01-02 0304 Mac 2).md",
    ]);
    expect(conflictPath("a.md", when, "Mac", (path) => taken.has(path))).toBe(
      "a (conflict 2026-01-02 0304 Mac 3).md",
    );
  });
});

describe("Drive の同じパスのファイル（Q9）", () => {
  const duplicates = (...entries: RemoteEntry[]) => new Map([[PATH, entries]]);
  const withDuplicates = (...entries: RemoteEntry[]) =>
    planOne(local("a"), remote("a"), base("a"), { duplicates: duplicates(...entries) });

  it("内容が違うものは競合コピーの名前に変えて残す", () => {
    expect(withDuplicates(remote("b", "r2"))).toEqual([
      { type: "renameDuplicate", path: PATH, remoteId: "r2", conflictPath: conflictName },
    ]);
  });

  it("採用した版と同じ内容なら、Drive のごみ箱へ移す", () => {
    expect(withDuplicates(remote("a", "r2"))).toEqual([
      { type: "trashDuplicate", path: PATH, remoteId: "r2" },
    ]);
  });

  it("重複どうしが同じ内容なら、コピーは 1 つだけ作る", () => {
    expect(withDuplicates(remote("b", "r2"), remote("b", "r3"))).toEqual([
      { type: "renameDuplicate", path: PATH, remoteId: "r2", conflictPath: conflictName },
      { type: "trashDuplicate", path: PATH, remoteId: "r3" },
    ]);
  });

  it("3 つとも違えば、別の名前の競合コピーにする", () => {
    const actions = withDuplicates(remote("b", "r2"), remote("c", "r3"));
    const names = actions.map((action) => action.type === "renameDuplicate" && action.conflictPath);
    expect(new Set(names).size).toBe(2);
    expect(names).toContain(conflictName);
    expect(names).toContain("note (conflict 2026-11-07 1630 Mac 2).md");
  });

  it("端末の判定は採用した版で別に行う", () => {
    const actions = planOne(local("a"), remote("z"), base("a"), {
      duplicates: duplicates(remote("b", "r2")),
    });
    expect(actions.map((action) => action.type)).toEqual(["download", "renameDuplicate"]);
  });

  it("除外したパスは触らない", () => {
    const actions = planOne(local("a"), remote("a"), base("a"), {
      duplicates: duplicates(remote("b", "r2")),
      isExcluded: () => true,
    });
    expect(actions).toEqual([]);
  });
});

describe("isConflictCopy", () => {
  it("競合コピーの名前を見分ける", () => {
    const when = new Date(2026, 10, 7, 16, 30);
    expect(isConflictCopy(conflictPath("日記/note.md", when, "Mac"))).toBe(true);
    expect(isConflictCopy(conflictPath("README", when, "Mac"))).toBe(true);
    expect(isConflictCopy(conflictPath("a.md", when, "Mac", () => false))).toBe(true);
    expect(isConflictCopy("note (conflict 2026-11-07 1630 Mac 2).md")).toBe(true);
  });

  it("普通の名前は競合コピーにしない", () => {
    expect(isConflictCopy("note.md")).toBe(false);
    expect(isConflictCopy("conflict の解消メモ.md")).toBe(false);
    expect(isConflictCopy("note (conflict).md")).toBe(false);
    expect(isConflictCopy("note (conflict 2026-11-07 1630 Mac)/a.md")).toBe(false);
  });
});
