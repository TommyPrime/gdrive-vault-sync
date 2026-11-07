import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { md5OfBuffer } from "../src/local/md5";
import { type VaultAdapter, VaultPort } from "../src/local/vaultPort";

function fakeAdapter() {
  const files = new Map<string, ArrayBuffer>();
  const folders = new Set<string>();
  const adapter = {
    list: async () => ({ files: [], folders: [] }),
    stat: async (path: string) => {
      const file = files.get(path);
      return file ? { size: file.byteLength, mtime: 5 } : null;
    },
    readBinary: async (path: string) => files.get(path)!,
    exists: async (path: string) => files.has(path) || folders.has(path),
    mkdir: vi.fn(async (path: string) => void folders.add(path)),
    writeBinary: async (path: string, data: ArrayBuffer) => void files.set(path, data),
    trashLocal: vi.fn(async (path: string) => void files.delete(path)),
  } satisfies VaultAdapter;
  return { adapter, files };
}

describe("md5OfBuffer", () => {
  it("Drive の md5Checksum と同じ形式", () => {
    const data = new TextEncoder().encode("日本語");
    const expected = createHash("md5").update(data).digest("hex");
    expect(md5OfBuffer(data.buffer as ArrayBuffer)).toBe(expected);
    expect(md5OfBuffer(new ArrayBuffer(0))).toBe("d41d8cd98f00b204e9800998ecf8427e");
  });
});

describe("VaultPort", () => {
  it("親フォルダを順に作って書く", async () => {
    const { adapter } = fakeAdapter();
    const entry = await new VaultPort(adapter, md5OfBuffer).write("a/b/c.md", new Uint8Array([1]));

    expect(adapter.mkdir.mock.calls.map(([path]) => path)).toEqual(["a", "a/b"]);
    expect(entry).toMatchObject({ size: 1, mtime: 5 });
  });

  it("配列の一部だけを渡されても、その範囲だけを書く", async () => {
    const { adapter, files } = fakeAdapter();
    const whole = new Uint8Array([1, 2, 3, 4]);
    await new VaultPort(adapter, md5OfBuffer).write("a.md", whole.subarray(1, 3));
    expect(files.get("a.md")?.byteLength).toBe(2);
  });

  it("無いファイルの MD5 は null", async () => {
    const { adapter } = fakeAdapter();
    await expect(new VaultPort(adapter, md5OfBuffer).md5("a.md")).resolves.toBeNull();
  });

  it("削除は .trash/ への移動だけ", async () => {
    const { adapter } = fakeAdapter();
    await new VaultPort(adapter, md5OfBuffer).trash("a.md");
    expect(adapter.trashLocal).toHaveBeenCalledWith("a.md");
  });
});
