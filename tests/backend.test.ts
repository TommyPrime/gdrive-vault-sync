import { describe, expect, it, vi } from "vitest";
import { GoogleDriveBackend } from "../src/drive/backend";
import type { DriveClient, DriveFile } from "../src/drive/client";
import { encodePathProps } from "../src/drive/pathProps";

function fakeClient(overrides: Partial<DriveClient> = {}) {
  let n = 0;
  const client = {
    findFolder: vi.fn(async (name: string) => ({ id: `id-${name}`, name })),
    findFile: vi.fn(async () => null),
    ensureVaultFolder: vi.fn(async () => ({ id: "vault-folder", name: "v" })),
    ensureFolder: vi.fn(async (name: string, parent: string) => ({
      id: `${parent}/${name}`,
      name,
    })),
    createFile: vi.fn(async () => ({ id: `f${++n}`, md5Checksum: "m", size: "1" })),
    updateFile: vi.fn(async () => ({ id: "f", md5Checksum: "m", size: "1" })),
    ...overrides,
  };
  return client as unknown as DriveClient & typeof client;
}

const fileIn = (vaultId: string, path: string, extra: Partial<DriveFile> = {}): DriveFile => ({
  id: path,
  md5Checksum: "m",
  size: "3",
  appProperties: { vaultId, ...encodePathProps(path) },
  ...extra,
});

describe("readVault", () => {
  it("フォルダが無ければ rootFound が false", async () => {
    const client = fakeClient({ findFolder: vi.fn(async () => null) });
    await expect(new GoogleDriveBackend(client, "O", "V").readVault()).resolves.toEqual({
      rootFound: false,
      vaultId: null,
    });
  });

  it("vault.json が無ければ vaultId は null", async () => {
    await expect(new GoogleDriveBackend(fakeClient(), "O", "V").readVault()).resolves.toEqual({
      rootFound: true,
      vaultId: null,
    });
  });

  it("vault.json を読む", async () => {
    const client = fakeClient({
      findFile: vi.fn(async () => ({ id: "j" })),
      download: vi.fn(async () => new TextEncoder().encode('{"vaultId":"v1"}')),
    });
    await expect(new GoogleDriveBackend(client, "O", "V").readVault()).resolves.toEqual({
      rootFound: true,
      vaultId: "v1",
    });
  });
});

describe("upload", () => {
  async function connected(client: ReturnType<typeof fakeClient>) {
    const backend = new GoogleDriveBackend(client, "O", "V");
    await backend.initVault("v1");
    vi.mocked(client.createFile).mockClear();
    return backend;
  }

  it("Vault と同じ階層に、vaultId とパスを付けて置く", async () => {
    const client = fakeClient();
    const backend = await connected(client);
    await backend.upload("日記/2026/a.md", new Uint8Array([1]));

    expect(client.createFile).toHaveBeenCalledWith({
      name: "a.md",
      parentId: "vault-folder/日記/2026",
      appProperties: { vaultId: "v1", p0: "日記/2026/a.md" },
      data: new Uint8Array([1]),
    });
  });

  it("並列でも同じフォルダを 1 度しか用意しない", async () => {
    const client = fakeClient();
    const backend = await connected(client);
    await Promise.all(
      ["d/a.md", "d/b.md", "d/c.md"].map((path) => backend.upload(path, new Uint8Array())),
    );
    expect(client.ensureFolder).toHaveBeenCalledTimes(1);
  });

  it("id があれば更新する", async () => {
    const client = fakeClient();
    const backend = await connected(client);
    await backend.upload("a.md", new Uint8Array(), "f9");
    expect(client.updateFile).toHaveBeenCalledWith("f9", new Uint8Array());
    expect(client.createFile).not.toHaveBeenCalled();
  });
});

describe("一覧の変換", () => {
  it("他の Vault のファイルと、パスの読めないファイルを外す", async () => {
    const client = fakeClient({
      listByVaultId: vi.fn(async () => [
        fileIn("v1", "日記/a.md"),
        fileIn("v2", "b.md"),
        { id: "x", md5Checksum: "m", appProperties: { vaultId: "v1" } },
      ]),
    });
    const files = await new GoogleDriveBackend(client, "O", "V").listAll("v1");
    expect(files).toEqual([{ id: "日記/a.md", path: "日記/a.md", md5: "m", size: 3 }]);
  });

  it("ごみ箱へ移ったものと消えたものは、消えたものとして返す", async () => {
    const client = fakeClient({
      listChanges: vi.fn(async () => ({
        changes: [
          { fileId: "a.md", file: fileIn("v1", "a.md") },
          { fileId: "b", file: fileIn("v1", "b.md", { trashed: true }) },
          { fileId: "c", removed: true },
        ],
        pageToken: "2",
      })),
    });
    const delta = await new GoogleDriveBackend(client, "O", "V").listChanges("1", "v1");
    expect(delta).toEqual({
      changes: [
        { id: "a.md", file: { id: "a.md", path: "a.md", md5: "m", size: 3 } },
        { id: "b", file: null },
        { id: "c", file: null },
      ],
      pageToken: "2",
    });
  });
});
