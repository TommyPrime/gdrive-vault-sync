import type { DriveBackend, RemoteChange, RemoteFile } from "../sync/engine";
import type { RemoteEntry } from "../sync/planner";
import type { DriveClient, DriveFile } from "./client";
import { decodePathProps, encodePathProps } from "./pathProps";

const VAULT_FILE = "vault.json";

function toRemoteFile(file: DriveFile, vaultId: string): RemoteFile | null {
  const props = file.appProperties;
  if (props?.vaultId !== vaultId || !file.md5Checksum) return null;
  const path = decodePathProps(props);
  if (path === null) return null;
  return { id: file.id, path, md5: file.md5Checksum, size: Number(file.size ?? 0) };
}

/** Drive API を同期の言葉に翻訳する。1 回の同期ごとに作る。 */
export class GoogleDriveBackend implements DriveBackend {
  private vaultFolderId: string | null = null;
  private vaultId: string | null = null;
  /** 並列のアップロードが同じフォルダを 2 つ作らないよう、作成中の Promise も持つ。 */
  private readonly folders = new Map<string, Promise<string>>();

  constructor(
    private readonly client: DriveClient,
    private readonly rootName: string,
    private readonly vaultName: string,
  ) {}

  async readVault(): Promise<{ rootFound: boolean; vaultId: string | null }> {
    const root = await this.client.findFolder(this.rootName, "root");
    const folder = root && (await this.client.findFolder(this.vaultName, root.id));
    if (!folder) return { rootFound: false, vaultId: null };

    this.vaultFolderId = folder.id;
    const file = await this.client.findFile(VAULT_FILE, folder.id);
    if (!file) return { rootFound: true, vaultId: null };

    const data = await this.client.download(file.id);
    const { vaultId } = JSON.parse(new TextDecoder().decode(data)) as { vaultId?: string };
    this.vaultId = vaultId ?? null;
    return { rootFound: true, vaultId: this.vaultId };
  }

  async initVault(vaultId: string): Promise<void> {
    const folder = await this.client.ensureVaultFolder(this.rootName, this.vaultName);
    this.vaultFolderId = folder.id;
    this.vaultId = vaultId;
    await this.client.createFile({
      name: VAULT_FILE,
      parentId: folder.id,
      data: new TextEncoder().encode(JSON.stringify({ vaultId })),
    });
  }

  startPageToken(): Promise<string> {
    return this.client.startPageToken();
  }

  async listAll(vaultId: string): Promise<RemoteFile[]> {
    const files = await this.client.listByVaultId(vaultId);
    return files.flatMap((file) => toRemoteFile(file, vaultId) ?? []);
  }

  async listChanges(
    pageToken: string,
    vaultId: string,
  ): Promise<{ changes: RemoteChange[]; pageToken: string } | null> {
    const delta = await this.client.listChanges(pageToken);
    if (!delta) return null;
    const changes = delta.changes.map((change): RemoteChange => {
      const file = change.removed || change.file?.trashed ? null : change.file;
      return { id: change.fileId, file: file ? toRemoteFile(file, vaultId) : null };
    });
    return { changes, pageToken: delta.pageToken };
  }

  download(id: string): Promise<Uint8Array> {
    return this.client.download(id);
  }

  async upload(path: string, data: Uint8Array, id?: string): Promise<RemoteEntry> {
    if (id) return this.toEntry(await this.client.updateFile(id, data));

    if (!this.vaultId) throw new Error("Vault が初期化されていません");
    const slash = path.lastIndexOf("/");
    const parentId = await this.folderOf(path.slice(0, Math.max(slash, 0)));
    const file = await this.client.createFile({
      name: path.slice(slash + 1),
      parentId,
      appProperties: { vaultId: this.vaultId, ...encodePathProps(path) },
      data,
    });
    return this.toEntry(file);
  }

  rename(id: string, path: string): Promise<void> {
    const name = path.slice(path.lastIndexOf("/") + 1);
    return this.client.renameFile(id, name, encodePathProps(path));
  }

  trash(id: string): Promise<void> {
    return this.client.trash(id);
  }

  private toEntry(file: DriveFile): RemoteEntry {
    if (!file.md5Checksum) throw new Error(`Drive が MD5 を返しませんでした: ${file.id}`);
    return { id: file.id, md5: file.md5Checksum, size: Number(file.size ?? 0) };
  }

  /** Vault と同じ階層のフォルダを用意する（設計書 4.3）。 */
  private folderOf(directory: string): Promise<string> {
    if (directory === "") {
      if (!this.vaultFolderId) throw new Error("Vault が初期化されていません");
      return Promise.resolve(this.vaultFolderId);
    }
    const cached = this.folders.get(directory);
    if (cached) return cached;

    const slash = directory.lastIndexOf("/");
    const created = this.folderOf(directory.slice(0, Math.max(slash, 0))).then(
      async (parentId) => (await this.client.ensureFolder(directory.slice(slash + 1), parentId)).id,
    );
    this.folders.set(directory, created);
    return created;
  }
}
