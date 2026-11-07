import { describe, expect, it, vi } from "vitest";
import {
  DEFAULT_EXCLUDES,
  type ScanAdapter,
  compileExcludes,
  scanVault,
} from "../src/local/scanner";
import type { BaseEntry } from "../src/sync/planner";

function fakeAdapter(files: Record<string, { size: number; mtime: number }>) {
  const paths = Object.keys(files);
  const adapter = {
    list: vi.fn(async (folder: string) => {
      const prefix = folder === "/" ? "" : `${folder}/`;
      const below = paths.filter((path) => path.startsWith(prefix));
      const names = below.map((path) => path.slice(prefix.length));
      return {
        files: below.filter((_, i) => !names[i]!.includes("/")),
        folders: [...new Set(names.filter((n) => n.includes("/")).map((n) => n.split("/")[0]!))].map(
          (name) => `${prefix}${name}`,
        ),
      };
    }),
    stat: vi.fn(async (path: string) => files[path] ?? null),
    readBinary: vi.fn<(path: string) => Promise<ArrayBuffer>>(async () => new ArrayBuffer(0)),
  } satisfies ScanAdapter;
  return adapter;
}

describe("除外パターン", () => {
  const isExcluded = compileExcludes(DEFAULT_EXCLUDES);

  it.each([
    ".git/config",
    ".git/objects/ab/cd",
    ".trash/a.md",
    ".DS_Store",
    "日記/.DS_Store",
    ".obsidian/workspace.json",
    ".obsidian/workspace-mobile.json",
    ".obsidian/cache/x",
    "node_modules/a/index.js",
    "tools/node_modules/a/index.js",
  ])("%s を除く", (path) => {
    expect(isExcluded(path)).toBe(true);
  });

  it.each([
    "a.md",
    ".gitignore",
    ".obsidian/app.json",
    ".obsidian/plugins/x/data.json",
    ".obsidian/workspace/x.json",
    "my.git/a.md",
    "node_modules.md",
  ])("%s は除かない", (path) => {
    expect(isExcluded(path)).toBe(false);
  });
});

describe("scanVault", () => {
  const hash = () => "hashed";
  const isExcluded = compileExcludes(DEFAULT_EXCLUDES);

  it("隠しフォルダも含めて全階層を走査し、除外を外す", async () => {
    const adapter = fakeAdapter({
      "a.md": { size: 1, mtime: 1 },
      "日記/深い/b.md": { size: 2, mtime: 2 },
      ".obsidian/app.json": { size: 3, mtime: 3 },
      ".git/config": { size: 4, mtime: 4 },
    });
    const result = await scanVault(adapter, { isExcluded, base: new Map(), hash });

    expect([...result.keys()].sort()).toEqual([".obsidian/app.json", "a.md", "日記/深い/b.md"]);
    expect(adapter.list).not.toHaveBeenCalledWith(".git");
  });

  it("フォルダの中の除外ファイルも外す", async () => {
    const adapter = fakeAdapter({
      "日記/.DS_Store": { size: 1, mtime: 1 },
      ".obsidian/workspace.json": { size: 1, mtime: 1 },
      "日記/a.md": { size: 1, mtime: 1 },
    });
    const result = await scanVault(adapter, { isExcluded, base: new Map(), hash });
    expect([...result.keys()]).toEqual(["日記/a.md"]);
  });

  it("mtime と size が同じならハッシュを計算し直さない", async () => {
    const adapter = fakeAdapter({ "a.md": { size: 1, mtime: 1 } });
    const known: BaseEntry = { md5: "cached", size: 1, mtime: 1, remoteId: "r", remoteMd5: "m" };
    const result = await scanVault(adapter, {
      isExcluded,
      base: new Map([["a.md", known]]),
      hash,
    });

    expect(result.get("a.md")?.md5).toBe("cached");
    expect(adapter.readBinary).not.toHaveBeenCalled();
  });

  it.each([
    ["mtime", { size: 1, mtime: 2 }],
    ["size", { size: 2, mtime: 1 }],
  ])("%s が違えば計算し直す", async (_, stat) => {
    const adapter = fakeAdapter({ "a.md": stat });
    const known: BaseEntry = { md5: "cached", size: 1, mtime: 1, remoteId: "r", remoteMd5: "m" };
    const result = await scanVault(adapter, {
      isExcluded,
      base: new Map([["a.md", known]]),
      hash,
    });
    expect(result.get("a.md")?.md5).toBe("hashed");
  });

  it("走査中に消えたファイルは飛ばす", async () => {
    const adapter = fakeAdapter({ "a.md": { size: 1, mtime: 1 } });
    adapter.stat.mockResolvedValueOnce(null as never);
    const result = await scanVault(adapter, { isExcluded, base: new Map(), hash });
    expect(result.size).toBe(0);
  });
});
