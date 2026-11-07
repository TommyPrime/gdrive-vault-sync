import { describe, expect, it, vi } from "vitest";
import {
  DriveApiError,
  DriveClient,
  RESUMABLE_CHUNK,
  RESUMABLE_THRESHOLD,
  escapeQueryValue,
  isQuotaError,
} from "../src/drive/client";
import type { HttpFn, HttpRequest, HttpResponse } from "../src/http";

const json = (status: number, body: unknown): HttpResponse => ({
  status,
  text: JSON.stringify(body),
});

const queryOf = (request: HttpRequest) => new URL(request.url).searchParams.get("q");
const token = async () => "token";

describe("escapeQueryValue", () => {
  it("引用符とバックスラッシュをエスケープする", () => {
    expect(escapeQueryValue(`Bob's \\ vault`)).toBe(`Bob\\'s \\\\ vault`);
  });
});

describe("findFolder", () => {
  it("親・名前・ごみ箱以外で検索し、トークンを付ける", async () => {
    const http = vi.fn<HttpFn>(async () => json(200, { files: [{ id: "1", name: "日本語" }] }));
    const folder = await new DriveClient(http, token).findFolder("日本語", "root");

    expect(folder).toEqual({ id: "1", name: "日本語" });
    const request = http.mock.calls[0]![0];
    expect(queryOf(request)).toContain("name = '日本語'");
    expect(queryOf(request)).toContain("'root' in parents");
    expect(queryOf(request)).toContain("trashed = false");
    expect(request.headers?.Authorization).toBe("Bearer token");
  });

  it("無ければ null", async () => {
    const http: HttpFn = async () => json(200, { files: [] });
    await expect(new DriveClient(http, token).findFolder("x", "root")).resolves.toBeNull();
  });
});

describe("ensureVaultFolder", () => {
  /** 名前 → フォルダの偽 Drive。 */
  function fakeDrive(existing: Record<string, string>) {
    const created: unknown[] = [];
    const http: HttpFn = async (request) => {
      if (request.method === "POST") {
        const body = JSON.parse((request.body as string | undefined) ?? "{}") as { name: string };
        created.push(body);
        return json(200, { id: `new-${body.name}`, name: body.name });
      }
      const name = /name = '([^']*)'/.exec(queryOf(request) ?? "")?.[1] ?? "";
      const id = existing[name];
      return json(200, { files: id ? [{ id, name }] : [] });
    };
    return { http, created };
  }

  it("どちらも無ければ親から順に作る", async () => {
    const { http, created } = fakeDrive({});
    const folder = await new DriveClient(http, token).ensureVaultFolder("Obsidian", "_test-vault");

    expect(folder.name).toBe("_test-vault");
    expect(created).toEqual([
      {
        name: "Obsidian",
        mimeType: "application/vnd.google-apps.folder",
        parents: ["root"],
      },
      {
        name: "_test-vault",
        mimeType: "application/vnd.google-apps.folder",
        parents: ["new-Obsidian"],
      },
    ]);
  });

  it("既にあれば作らない", async () => {
    const { http, created } = fakeDrive({ Obsidian: "a", "_test-vault": "b" });
    const folder = await new DriveClient(http, token).ensureVaultFolder("Obsidian", "_test-vault");
    expect(folder.id).toBe("b");
    expect(created).toEqual([]);
  });
});

describe("エラー処理", () => {
  it("401 はトークンを更新して 1 回だけ再試行する", async () => {
    const http = vi
      .fn<HttpFn>()
      .mockResolvedValueOnce(json(401, {}))
      .mockResolvedValueOnce(json(200, { files: [] }));
    const getToken = vi.fn(async (options?: { forceRefresh?: boolean }) =>
      options?.forceRefresh ? "new" : "old",
    );

    await new DriveClient(http, getToken).findFolder("x", "root");

    expect(http).toHaveBeenCalledTimes(2);
    expect(http.mock.calls[1]![0].headers?.Authorization).toBe("Bearer new");
  });

  it("再試行でも 401 なら失敗にする", async () => {
    const http = vi.fn<HttpFn>(async () => json(401, {}));
    await expect(new DriveClient(http, token).findFolder("x", "root")).rejects.toThrow(
      DriveApiError,
    );
    expect(http).toHaveBeenCalledTimes(2);
  });

  it("Drive のエラー文言を例外に載せる", async () => {
    const http: HttpFn = async () => json(403, { error: { message: "denied" } });
    await expect(new DriveClient(http, token).createFolder("x", "root")).rejects.toThrow("denied");
  });
});

describe("再試行", () => {
  const rateLimited = json(403, {
    error: { message: "slow down", errors: [{ reason: "rateLimitExceeded" }] },
  });
  const instant = async () => undefined;

  it.each([
    ["403 のレート制限", rateLimited],
    ["429", json(429, {})],
    ["503", json(503, {})],
  ])("%s は再試行する", async (_, failure) => {
    let calls = 0;
    const http: HttpFn = async () => {
      calls += 1;
      return calls === 1 ? failure : json(200, { files: [] });
    };
    await new DriveClient(http, token, instant).findFolder("x", "root");
    expect(calls).toBe(2);
  });

  it("権限のない 403 は再試行しない", async () => {
    const http = vi.fn<HttpFn>(async () =>
      json(403, { error: { message: "no", errors: [{ reason: "insufficientFilePermissions" }] } }),
    );
    await expect(new DriveClient(http, token, instant).findFolder("x", "root")).rejects.toThrow(
      DriveApiError,
    );
    expect(http).toHaveBeenCalledTimes(1);
  });

  it("容量不足を見分ける", async () => {
    const http: HttpFn = async () =>
      json(403, { error: { message: "full", errors: [{ reason: "storageQuotaExceeded" }] } });
    const error = await new DriveClient(http, token, instant)
      .findFolder("x", "root")
      .catch((e: unknown) => e);
    expect(isQuotaError(error)).toBe(true);
  });
});

describe("一覧", () => {
  it("vaultId で検索し、全ページを読む", async () => {
    const http = vi.fn<HttpFn>(async (request) =>
      new URL(request.url).searchParams.get("pageToken")
        ? json(200, { files: [{ id: "2" }] })
        : json(200, { files: [{ id: "1" }], nextPageToken: "next" }),
    );
    const files = await new DriveClient(http, token).listByVaultId("v'1");

    expect(files.map((file) => file.id)).toEqual(["1", "2"]);
    expect(queryOf(http.mock.calls[0]![0])).toBe(
      "appProperties has { key='vaultId' and value='v\\'1' } and trashed = false",
    );
  });

  it("changes を最後のページまで読み、次の token を返す", async () => {
    const http: HttpFn = async (request) =>
      new URL(request.url).searchParams.get("pageToken") === "1"
        ? json(200, { changes: [{ fileId: "a" }], nextPageToken: "2" })
        : json(200, { changes: [{ fileId: "b" }], newStartPageToken: "3" });

    const delta = await new DriveClient(http, token).listChanges("1");

    expect(delta?.changes.map((change) => change.fileId)).toEqual(["a", "b"]);
    expect(delta?.pageToken).toBe("3");
  });

  it("失効した pageToken は null を返す", async () => {
    const http: HttpFn = async () => json(410, { error: { message: "gone" } });
    await expect(new DriveClient(http, token).listChanges("old")).resolves.toBeNull();
  });
});

describe("アップロード", () => {
  const decode = (body: HttpRequest["body"]) => new TextDecoder().decode(body as ArrayBuffer);

  it("小さいファイルは multipart で作る", async () => {
    const http = vi.fn<HttpFn>(async () => json(200, { id: "1", md5Checksum: "m" }));
    await new DriveClient(http, token).createFile({
      name: "日本語.md",
      parentId: "p",
      appProperties: { vaultId: "v" },
      data: new TextEncoder().encode("本文"),
    });

    const request = http.mock.calls[0]![0];
    expect(request.url).toContain("/upload/drive/v3/files?uploadType=multipart");
    expect(request.method).toBe("POST");
    const body = decode(request.body);
    expect(body).toContain('"name":"日本語.md"');
    expect(body).toContain('"parents":["p"]');
    expect(body).toContain('"appProperties":{"vaultId":"v"}');
    expect(body).toContain("本文");
    const boundary = /boundary=(.+)$/.exec(request.headers!["Content-Type"]!)![1]!;
    expect(body.endsWith(`--${boundary}--`)).toBe(true);
  });

  it("更新は同じ id へ PATCH する", async () => {
    const http = vi.fn<HttpFn>(async () => json(200, { id: "1" }));
    await new DriveClient(http, token).updateFile("1", new Uint8Array([1]));
    const request = http.mock.calls[0]![0];
    expect(request.method).toBe("PATCH");
    expect(request.url).toContain("/upload/drive/v3/files/1?uploadType=multipart");
  });

  it("ちょうど 5MB は multipart のまま", async () => {
    const http = vi.fn<HttpFn>(async () => json(200, { id: "1" }));
    await new DriveClient(http, token).updateFile("1", new Uint8Array(RESUMABLE_THRESHOLD));
    expect(http.mock.calls[0]![0].url).toContain("uploadType=multipart");
  });

  it("5MB を超えたら分割して送る", async () => {
    const total = RESUMABLE_CHUNK + 100;
    const data = new Uint8Array(total).fill(7);
    const puts: HttpRequest[] = [];
    const http: HttpFn = async (request) => {
      if (request.method !== "PUT") {
        return { status: 200, text: "", headers: { Location: "https://upload/session" } };
      }
      puts.push(request);
      return puts.length === 1 ? { status: 308, text: "" } : json(200, { id: "1", md5Checksum: "m" });
    };

    const file = await new DriveClient(http, token).createFile({
      name: "large.bin",
      parentId: "p",
      data,
    });

    expect(file.id).toBe("1");
    expect(puts.map((put) => put.url)).toEqual(["https://upload/session", "https://upload/session"]);
    expect(puts.map((put) => put.headers?.["Content-Range"])).toEqual([
      `bytes 0-${RESUMABLE_CHUNK - 1}/${total}`,
      `bytes ${RESUMABLE_CHUNK}-${total - 1}/${total}`,
    ]);
    expect(puts.map((put) => (put.body as ArrayBuffer).byteLength)).toEqual([RESUMABLE_CHUNK, 100]);
  });

  it("分割の単位は 256KiB の倍数", () => {
    expect(RESUMABLE_CHUNK % (256 * 1024)).toBe(0);
  });
});

describe("ごみ箱", () => {
  it("名前の変更は名前と appProperties だけを送る", async () => {
    const http = vi.fn<HttpFn>(async () => json(200, { id: "1" }));
    await new DriveClient(http, token).renameFile("1", "新しい名前.md", { p0: "新しい名前.md" });

    const request = http.mock.calls[0]![0];
    expect(request.method).toBe("PATCH");
    expect(new URL(request.url).pathname).toBe("/drive/v3/files/1");
    expect(JSON.parse(request.body as string)).toEqual({
      name: "新しい名前.md",
      appProperties: { p0: "新しい名前.md" },
    });
  });

  it("trashed を立てるだけで、完全削除はしない", async () => {
    const http = vi.fn<HttpFn>(async () => json(200, { id: "1" }));
    await new DriveClient(http, token).trash("1");
    const request = http.mock.calls[0]![0];
    expect(request.method).toBe("PATCH");
    expect(JSON.parse(request.body as string)).toEqual({ trashed: true });
  });
});
