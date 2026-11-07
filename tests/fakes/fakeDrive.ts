import { createHash } from "node:crypto";
import type { DriveBackend, RemoteChange, RemoteFile } from "../../src/sync/engine";
import type { RemoteEntry } from "../../src/sync/planner";

export const md5 = (data: Uint8Array) => createHash("md5").update(data).digest("hex");

interface DriveFile {
  id: string;
  path: string;
  data: Uint8Array;
  trashed: boolean;
}

/** メモリ上の Drive。完全削除の操作は持たない。 */
export class FakeDrive implements DriveBackend {
  vaultId: string | null = null;
  rootFound = true;
  /** 次の n 回の upload を失敗させる。通信断を再現する。 */
  failUploads = 0;
  /** upload で投げる例外。既定は通信断。 */
  uploadError: Error = new Error("network down");
  listAllCalls = 0;
  /** true なら pageToken を失効させる。 */
  expireTokens = false;
  private readonly log: string[] = [];
  private readonly files = new Map<string, DriveFile>();
  private nextId = 1;

  /** `appProperties has vaultId and trashed=false` の一覧にあたる。 */
  list(): Map<string, RemoteEntry> {
    const result = new Map<string, RemoteEntry>();
    for (const file of this.files.values()) {
      if (!file.trashed) result.set(file.path, this.entryOf(file));
    }
    return result;
  }

  trashedPaths(): string[] {
    return [...this.files.values()].filter((file) => file.trashed).map((file) => file.path);
  }

  async download(id: string): Promise<Uint8Array> {
    return this.mustGet(id).data;
  }

  async upload(path: string, data: Uint8Array, id?: string): Promise<RemoteEntry> {
    if (this.failUploads > 0) {
      this.failUploads -= 1;
      throw this.uploadError;
    }
    if (id) {
      const file = this.mustGet(id);
      file.data = data;
      this.log.push(id);
      return this.entryOf(file);
    }
    const file = { id: `f${this.nextId++}`, path, data, trashed: false };
    this.files.set(file.id, file);
    this.log.push(file.id);
    return this.entryOf(file);
  }

  async trash(id: string): Promise<void> {
    this.mustGet(id).trashed = true;
    this.log.push(id);
  }

  async readVault() {
    return { rootFound: this.rootFound, vaultId: this.rootFound ? this.vaultId : null };
  }

  async initVault(vaultId: string): Promise<void> {
    this.rootFound = true;
    this.vaultId = vaultId;
  }

  async startPageToken(): Promise<string> {
    return String(this.log.length);
  }

  async listAll(): Promise<RemoteFile[]> {
    this.listAllCalls += 1;
    return [...this.files.values()].filter((file) => !file.trashed).map((f) => this.fileOf(f));
  }

  async listChanges(pageToken: string) {
    if (this.expireTokens) return null;
    const ids = new Set(this.log.slice(Number(pageToken)));
    const changes: RemoteChange[] = [...ids].map((id) => {
      const file = this.mustGet(id);
      return { id, file: file.trashed ? null : this.fileOf(file) };
    });
    return { changes, pageToken: String(this.log.length) };
  }

  private mustGet(id: string): DriveFile {
    const file = this.files.get(id);
    if (!file) throw new Error(`no such file: ${id}`);
    return file;
  }

  private fileOf(file: DriveFile): RemoteFile {
    return { ...this.entryOf(file), path: file.path };
  }

  private entryOf(file: DriveFile): RemoteEntry {
    return { id: file.id, md5: md5(file.data), size: file.data.byteLength };
  }
}
