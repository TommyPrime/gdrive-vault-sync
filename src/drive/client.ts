import type { HttpFn, HttpRequest, HttpResponse } from "../http";
import { withRetry } from "./retry";

const API_BASE = "https://www.googleapis.com/drive/v3";
const UPLOAD_BASE = "https://www.googleapis.com/upload/drive/v3";
const FOLDER_MIME = "application/vnd.google-apps.folder";
const BINARY_MIME = "application/octet-stream";
const FILE_FIELDS = "id,md5Checksum,size,trashed,appProperties";
const PAGE_SIZE = "1000";

/** これを超えるファイルは分割アップロードにする（設計書 4.7）。 */
export const RESUMABLE_THRESHOLD = 5 * 1024 * 1024;
/** 分割の単位。256KiB の倍数でなければならない。 */
export const RESUMABLE_CHUNK = 8 * 1024 * 1024;

export type GetAccessToken = (options?: { forceRefresh?: boolean }) => Promise<string>;

export class DriveApiError extends Error {
  constructor(
    readonly status: number,
    detail: string,
    readonly reason?: string,
  ) {
    super(`Google Drive API エラー（${status}）: ${detail}`);
    this.name = "DriveApiError";
  }
}

const RATE_LIMIT_REASONS = new Set(["rateLimitExceeded", "userRateLimitExceeded"]);

function isRetryable(error: unknown): boolean {
  if (!(error instanceof DriveApiError)) return false;
  if (error.status === 429 || error.status >= 500) return true;
  return error.status === 403 && RATE_LIMIT_REASONS.has(error.reason ?? "");
}

export function isQuotaError(error: unknown): boolean {
  return error instanceof DriveApiError && error.reason === "storageQuotaExceeded";
}

export interface DriveFile {
  id: string;
  md5Checksum?: string;
  size?: string;
  trashed?: boolean;
  appProperties?: Record<string, string>;
}

export interface DriveChange {
  fileId: string;
  removed?: boolean;
  file?: DriveFile;
}

export interface DriveFolder {
  id: string;
  name: string;
}

/** Drive の検索式の文字列リテラルをエスケープする。 */
export function escapeQueryValue(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
}

/**
 * Drive API v3 のラッパー。
 * files.delete は実装しない（CLAUDE.md「してはいけないこと」）。
 */
export class DriveClient {
  constructor(
    private readonly http: HttpFn,
    private readonly getAccessToken: GetAccessToken,
    private readonly sleep: (ms: number) => Promise<void> = (ms) =>
      new Promise((resolve) => setTimeout(resolve, ms)),
  ) {}

  private request(request: HttpRequest): Promise<HttpResponse> {
    return withRetry(() => this.send(request), { isRetryable, sleep: this.sleep });
  }

  /** 401 はトークンを更新して 1 回だけ再試行する（設計書 4.9）。 */
  private async send(request: HttpRequest): Promise<HttpResponse> {
    const send = async (forceRefresh: boolean) => {
      const token = await this.getAccessToken({ forceRefresh });
      return this.http({
        ...request,
        headers: { ...request.headers, Authorization: `Bearer ${token}` },
      });
    };

    let response = await send(false);
    if (response.status === 401) response = await send(true);
    if (response.status >= 400) {
      const { message, reason } = errorDetail(response.text);
      throw new DriveApiError(response.status, message, reason);
    }
    return response;
  }

  async findFolder(name: string, parentId: string): Promise<DriveFolder | null> {
    const query = new URLSearchParams({
      q: [
        `name = '${escapeQueryValue(name)}'`,
        `mimeType = '${FOLDER_MIME}'`,
        `'${escapeQueryValue(parentId)}' in parents`,
        "trashed = false",
      ].join(" and "),
      fields: "files(id,name)",
      // 同名が複数あっても、どの端末でも同じものを選ぶ。
      orderBy: "createdTime",
      pageSize: "1",
    });
    const response = await this.request({
      url: `${API_BASE}/files?${query.toString()}`,
      method: "GET",
    });
    const { files } = JSON.parse(response.text) as { files?: DriveFolder[] };
    return files?.[0] ?? null;
  }

  async createFolder(name: string, parentId: string): Promise<DriveFolder> {
    const response = await this.request({
      url: `${API_BASE}/files?fields=id,name`,
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, mimeType: FOLDER_MIME, parents: [parentId] }),
    });
    return JSON.parse(response.text) as DriveFolder;
  }

  async ensureFolder(name: string, parentId: string): Promise<DriveFolder> {
    return (await this.findFolder(name, parentId)) ?? (await this.createFolder(name, parentId));
  }

  /** `マイドライブ/<rootName>/<vaultName>/` を用意して返す（設計書 4.3）。 */
  async ensureVaultFolder(rootName: string, vaultName: string): Promise<DriveFolder> {
    const root = await this.ensureFolder(rootName, "root");
    return this.ensureFolder(vaultName, root.id);
  }

  async findFile(name: string, parentId: string): Promise<DriveFile | null> {
    const query = new URLSearchParams({
      q: [
        `name = '${escapeQueryValue(name)}'`,
        `'${escapeQueryValue(parentId)}' in parents`,
        "trashed = false",
      ].join(" and "),
      fields: `files(${FILE_FIELDS})`,
      orderBy: "createdTime",
      pageSize: "1",
    });
    const response = await this.request({
      url: `${API_BASE}/files?${query.toString()}`,
      method: "GET",
    });
    return (JSON.parse(response.text) as { files?: DriveFile[] }).files?.[0] ?? null;
  }

  async listByVaultId(vaultId: string): Promise<DriveFile[]> {
    const files: DriveFile[] = [];
    let pageToken: string | undefined;
    do {
      const query = new URLSearchParams({
        q: `appProperties has { key='vaultId' and value='${escapeQueryValue(vaultId)}' } and trashed = false`,
        fields: `nextPageToken,files(${FILE_FIELDS})`,
        pageSize: PAGE_SIZE,
      });
      if (pageToken) query.set("pageToken", pageToken);
      const response = await this.request({
        url: `${API_BASE}/files?${query.toString()}`,
        method: "GET",
      });
      const page = JSON.parse(response.text) as { files?: DriveFile[]; nextPageToken?: string };
      files.push(...(page.files ?? []));
      pageToken = page.nextPageToken;
    } while (pageToken);
    return files;
  }

  async startPageToken(): Promise<string> {
    const response = await this.request({
      url: `${API_BASE}/changes/startPageToken?fields=startPageToken`,
      method: "GET",
    });
    return (JSON.parse(response.text) as { startPageToken: string }).startPageToken;
  }

  /** pageToken が失効していれば null。 */
  async listChanges(
    pageToken: string,
  ): Promise<{ changes: DriveChange[]; pageToken: string } | null> {
    const changes: DriveChange[] = [];
    let token = pageToken;
    for (;;) {
      const query = new URLSearchParams({
        pageToken: token,
        fields: `nextPageToken,newStartPageToken,changes(fileId,removed,file(${FILE_FIELDS}))`,
        includeRemoved: "true",
        spaces: "drive",
        pageSize: PAGE_SIZE,
      });
      let response: HttpResponse;
      try {
        response = await this.request({
          url: `${API_BASE}/changes?${query.toString()}`,
          method: "GET",
        });
      } catch (error) {
        if (error instanceof DriveApiError && [400, 404, 410].includes(error.status)) return null;
        throw error;
      }
      const page = JSON.parse(response.text) as {
        changes?: DriveChange[];
        nextPageToken?: string;
        newStartPageToken?: string;
      };
      changes.push(...(page.changes ?? []));
      if (page.newStartPageToken) return { changes, pageToken: page.newStartPageToken };
      if (!page.nextPageToken) throw new DriveApiError(200, "changes の続きがありません");
      token = page.nextPageToken;
    }
  }

  async createFile(params: {
    name: string;
    parentId: string;
    appProperties?: Record<string, string>;
    data: Uint8Array;
  }): Promise<DriveFile> {
    const metadata = {
      name: params.name,
      parents: [params.parentId],
      mimeType: BINARY_MIME,
      ...(params.appProperties ? { appProperties: params.appProperties } : {}),
    };
    return this.uploadBytes("POST", `${UPLOAD_BASE}/files`, metadata, params.data);
  }

  async updateFile(id: string, data: Uint8Array): Promise<DriveFile> {
    const url = `${UPLOAD_BASE}/files/${encodeURIComponent(id)}`;
    return this.uploadBytes("PATCH", url, {}, data);
  }

  private uploadBytes(
    method: "POST" | "PATCH",
    url: string,
    metadata: object,
    data: Uint8Array,
  ): Promise<DriveFile> {
    return data.byteLength > RESUMABLE_THRESHOLD
      ? this.uploadResumable(method, url, metadata, data)
      : this.uploadMultipart(method, url, metadata, data);
  }

  private async uploadMultipart(
    method: "POST" | "PATCH",
    url: string,
    metadata: object,
    data: Uint8Array,
  ): Promise<DriveFile> {
    const boundary = `gdrive-vault-sync-${crypto.randomUUID()}`;
    const encoder = new TextEncoder();
    const head = encoder.encode(
      `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n` +
        `${JSON.stringify(metadata)}\r\n--${boundary}\r\nContent-Type: ${BINARY_MIME}\r\n\r\n`,
    );
    const tail = encoder.encode(`\r\n--${boundary}--`);
    const body = new Uint8Array(head.byteLength + data.byteLength + tail.byteLength);
    body.set(head, 0);
    body.set(data, head.byteLength);
    body.set(tail, head.byteLength + data.byteLength);

    const response = await this.request({
      url: `${url}?uploadType=multipart&fields=${FILE_FIELDS}`,
      method,
      headers: { "Content-Type": `multipart/related; boundary=${boundary}` },
      body: body.buffer,
    });
    return JSON.parse(response.text) as DriveFile;
  }

  private async uploadResumable(
    method: "POST" | "PATCH",
    url: string,
    metadata: object,
    data: Uint8Array,
  ): Promise<DriveFile> {
    const total = data.byteLength;
    const start = await this.request({
      url: `${url}?uploadType=resumable&fields=${FILE_FIELDS}`,
      method,
      headers: {
        "Content-Type": "application/json; charset=UTF-8",
        "X-Upload-Content-Type": BINARY_MIME,
        "X-Upload-Content-Length": String(total),
      },
      body: JSON.stringify(metadata),
    });
    const location = headerOf(start, "location");
    if (!location) throw new DriveApiError(start.status, "アップロード先が返りませんでした");

    for (let offset = 0; ; ) {
      const end = Math.min(offset + RESUMABLE_CHUNK, total);
      const response = await this.request({
        url: location,
        method: "PUT",
        headers: {
          "Content-Type": BINARY_MIME,
          "Content-Range": `bytes ${offset}-${end - 1}/${total}`,
        },
        body: data.slice(offset, end).buffer,
      });
      if (response.status !== 308) return JSON.parse(response.text) as DriveFile;
      offset = end;
    }
  }

  async download(id: string): Promise<Uint8Array> {
    const response = await this.request({
      url: `${API_BASE}/files/${encodeURIComponent(id)}?alt=media`,
      method: "GET",
    });
    if (!response.arrayBuffer) throw new DriveApiError(response.status, "本文がありません");
    return new Uint8Array(response.arrayBuffer);
  }

  /** 内容を変えずに名前を変える。appProperties は渡したキーだけが更新される。 */
  async renameFile(
    id: string,
    name: string,
    appProperties: Record<string, string>,
  ): Promise<void> {
    await this.request({
      url: `${API_BASE}/files/${encodeURIComponent(id)}?fields=id`,
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, appProperties }),
    });
  }

  /** ごみ箱へ移す。完全削除はしない。 */
  async trash(id: string): Promise<void> {
    await this.request({
      url: `${API_BASE}/files/${encodeURIComponent(id)}?fields=id`,
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ trashed: true }),
    });
  }
}

function headerOf(response: HttpResponse, name: string): string | undefined {
  for (const [key, value] of Object.entries(response.headers ?? {})) {
    if (key.toLowerCase() === name) return value;
  }
  return undefined;
}

function errorDetail(text: string): { message: string; reason?: string } {
  try {
    const body = JSON.parse(text) as {
      error?: { message?: string; errors?: { reason?: string }[] };
    };
    if (body.error?.message) {
      return { message: body.error.message, reason: body.error.errors?.[0]?.reason };
    }
  } catch {
    // JSON でなければ下で固定文言にする。
  }
  return { message: "詳細なし" };
}
