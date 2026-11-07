import type { LocalPort } from "../sync/executor";
import type { LocalEntry } from "../sync/planner";
import type { ScanAdapter } from "./scanner";

/** Obsidian の DataAdapter のうち、同期の実行に使う部分。完全削除は使わない。 */
export interface VaultAdapter extends ScanAdapter {
  exists(path: string): Promise<boolean>;
  mkdir(path: string): Promise<void>;
  writeBinary(path: string, data: ArrayBuffer): Promise<void>;
  trashLocal(path: string): Promise<void>;
}

/**
 * パスは Drive からも届く。Vault の外を指すものは、走査や判定ではなく、ここで止める。
 * 判定で無視すると「Drive から消えた」と読まれ、端末のファイルが移動される経路ができる。
 * Windows の区切りも見るので、macOS で書けるパスにも `\` を区切りとして適用する。
 */
function assertInsideVault(path: string): void {
  const absolute = /^[/\\]/.test(path) || /^[A-Za-z]:[/\\]/.test(path);
  if (absolute || path.split(/[/\\]/).includes("..")) {
    throw new Error(`Vault の外を指すパスです: ${path}`);
  }
}

function toArrayBuffer(data: Uint8Array): ArrayBuffer {
  return data.slice().buffer as ArrayBuffer;
}

export class VaultPort implements LocalPort {
  constructor(
    private readonly adapter: VaultAdapter,
    private readonly hash: (data: ArrayBuffer) => string,
  ) {}

  async read(path: string): Promise<Uint8Array> {
    assertInsideVault(path);
    return new Uint8Array(await this.adapter.readBinary(path));
  }

  async write(path: string, data: Uint8Array): Promise<LocalEntry> {
    assertInsideVault(path);
    await this.ensureParents(path);
    const buffer = toArrayBuffer(data);
    await this.adapter.writeBinary(path, buffer);
    const stat = await this.adapter.stat(path);
    if (!stat) throw new Error(`書き込んだファイルが見つかりません: ${path}`);
    return { md5: this.hash(buffer), size: stat.size, mtime: stat.mtime };
  }

  async md5(path: string): Promise<string | null> {
    assertInsideVault(path);
    if (!(await this.adapter.exists(path))) return null;
    return this.hash(await this.adapter.readBinary(path));
  }

  async trash(path: string): Promise<void> {
    assertInsideVault(path);
    return this.adapter.trashLocal(path);
  }

  private async ensureParents(path: string): Promise<void> {
    const parts = path.split("/").slice(0, -1);
    for (let i = 1; i <= parts.length; i += 1) {
      const directory = parts.slice(0, i).join("/");
      if (!(await this.adapter.exists(directory))) await this.adapter.mkdir(directory);
    }
  }
}
