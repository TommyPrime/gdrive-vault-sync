import { describe, expect, it, vi } from "vitest";
import { type ScanAdapter, mobileMaxBytes, scanVault } from "../src/local/scanner";
import { type BaseEntry, type LocalEntry, type RemoteEntry, plan } from "../src/sync/planner";

const LIMIT = 100;
const local = (size: number, md5 = "l"): LocalEntry => ({ md5, size, mtime: 0 });
const remote = (size: number, md5 = "r"): RemoteEntry => ({ id: "id", md5, size });
const base = (size: number, md5 = "b"): BaseEntry => ({
  md5,
  size,
  mtime: 0,
  remoteId: "id",
  remoteMd5: md5,
});

function planOf(
  l: LocalEntry | undefined,
  r: RemoteEntry | undefined,
  b: BaseEntry | undefined,
  maxFileSize: number | null = LIMIT,
) {
  return plan({
    local: new Map(l ? [["a.bin", l]] : []),
    remote: new Map(r ? [["a.bin", r]] : []),
    base: new Map(b ? [["a.bin", b]] : []),
    now: 1_000_000,
    deviceName: "iPad",
    maxFileSize: maxFileSize ?? undefined,
  });
}

describe("大きいファイルのスキップ", () => {
  it.each<[string, LocalEntry | undefined, RemoteEntry | undefined, BaseEntry | undefined]>([
    ["Drive の新規をダウンロードしない", undefined, remote(101), undefined],
    ["端末の新規をアップロードしない", local(101), undefined, undefined],
    ["Drive で大きくなったファイルを取り込まない", local(10, "b"), remote(101), base(10)],
    ["端末で大きくなったファイルを上げない", local(101), remote(10, "b"), base(10)],
    ["端末に無いからといって Drive をごみ箱へ移さない", undefined, remote(101, "b"), base(101)],
    ["Drive に無いからといって端末を .trash へ移さない", local(101, "b"), undefined, base(101)],
  ])("%s", (_, l, r, b) => {
    const result = planOf(l, r, b);
    expect(result.actions).toEqual([]);
    expect(result.skipped).toEqual(["a.bin"]);
    expect(result.totalPaths).toBe(0);
  });

  it("上限ちょうどは通常どおり扱う", () => {
    const result = planOf(undefined, remote(100), undefined);
    expect(result.actions.map((action) => action.type)).toEqual(["download"]);
    expect(result.skipped).toEqual([]);
  });

  it("上限が無ければスキップしない", () => {
    const result = planOf(undefined, remote(10 ** 12), undefined, null);
    expect(result.actions.map((action) => action.type)).toEqual(["download"]);
    expect(result.skipped).toEqual([]);
  });

  it("同じパスの重複も触らない", () => {
    const result = plan({
      local: new Map(),
      remote: new Map([["a.bin", remote(101)]]),
      base: new Map(),
      now: 0,
      deviceName: "iPad",
      maxFileSize: LIMIT,
      duplicates: new Map([["a.bin", [{ id: "dup", md5: "x", size: 101 }]]]),
    });
    expect(result.actions).toEqual([]);
  });
});

describe("走査での大きいファイル", () => {
  const adapter = (size: number) =>
    ({
      list: async () => ({ files: ["big.bin"], folders: [] }),
      stat: async () => ({ size, mtime: 5 }),
      readBinary: vi.fn(async () => new ArrayBuffer(0)),
    }) satisfies ScanAdapter;
  const options = { isExcluded: () => false, hash: () => "hashed", maxFileSize: LIMIT };

  it("上限を超えるファイルは読まず、走査の結果には残す", async () => {
    const files = adapter(101);
    const result = await scanVault(files, { ...options, base: new Map() });
    expect(files.readBinary).not.toHaveBeenCalled();
    expect(result.get("big.bin")).toMatchObject({ size: 101, mtime: 5 });
  });

  it("前回の MD5 があれば保つ", async () => {
    const result = await scanVault(adapter(101), {
      ...options,
      base: new Map([["big.bin", base(50, "known")]]),
    });
    expect(result.get("big.bin")?.md5).toBe("known");
  });

  it("上限以下はこれまでどおり読む", async () => {
    const files = adapter(100);
    const result = await scanVault(files, { ...options, base: new Map() });
    expect(files.readBinary).toHaveBeenCalledOnce();
    expect(result.get("big.bin")?.md5).toBe("hashed");
  });
});

describe("mobileMaxBytes", () => {
  it("MB をバイトにする", () => {
    expect(mobileMaxBytes(10)).toBe(10 * 1024 * 1024);
  });

  it.each([null, undefined, Number.NaN, 0, -1, Number.POSITIVE_INFINITY, "abc"])(
    "%s は既定の 50MB に戻す",
    (value) => {
      expect(mobileMaxBytes(value)).toBe(50 * 1024 * 1024);
    },
  );
});
