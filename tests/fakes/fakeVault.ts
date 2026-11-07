import type { LocalPort } from "../../src/sync/executor";
import type { LocalEntry } from "../../src/sync/planner";
import { md5 } from "./fakeDrive";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export interface Clock {
  now: number;
}

/** メモリ上の Vault。`.trash/` への移動だけができる。 */
export class FakeVault implements LocalPort {
  /** `.trash/` へ移したファイルの内容。 */
  readonly trashed: { path: string; text: string }[] = [];
  /** 次の n 回の write を失敗させる。 */
  failWrites = 0;
  /** read の直前に呼ぶ。同期中の編集を再現する。 */
  beforeRead: (() => void) | null = null;
  private readonly files = new Map<string, { data: Uint8Array; mtime: number }>();

  constructor(private readonly clock: Clock) {}

  /** ユーザーの編集。Obsidian の外からの編集も同じ扱いになる。 */
  edit(path: string, text: string): void {
    this.files.set(path, { data: encoder.encode(text), mtime: this.clock.now });
  }

  /** 大きさも mtime も変えずに内容だけを変える。mtime を保つ外部ツールを再現する。 */
  editKeepingMtime(path: string, text: string): void {
    const file = this.files.get(path);
    if (!file) throw new Error(`no such file: ${path}`);
    this.files.set(path, { data: encoder.encode(text), mtime: file.mtime });
  }

  remove(path: string): void {
    this.files.delete(path);
  }

  clear(): void {
    this.files.clear();
  }

  text(path: string): string | undefined {
    const file = this.files.get(path);
    return file && decoder.decode(file.data);
  }

  paths(): string[] {
    return [...this.files.keys()].sort();
  }

  snapshot(): Record<string, string> {
    return Object.fromEntries(this.paths().map((path) => [path, this.text(path)!]));
  }

  scan(): Map<string, LocalEntry> {
    const result = new Map<string, LocalEntry>();
    for (const [path, file] of this.files) result.set(path, this.entryOf(file));
    return result;
  }

  async read(path: string): Promise<Uint8Array> {
    this.beforeRead?.();
    const file = this.files.get(path);
    if (!file) throw new Error(`no such file: ${path}`);
    return file.data;
  }

  async write(path: string, data: Uint8Array): Promise<LocalEntry> {
    if (this.failWrites > 0) {
      this.failWrites -= 1;
      throw new Error("disk full");
    }
    const file = { data, mtime: this.clock.now };
    this.files.set(path, file);
    return this.entryOf(file);
  }

  async md5(path: string): Promise<string | null> {
    this.beforeRead?.();
    const file = this.files.get(path);
    return file ? md5(file.data) : null;
  }

  async trash(path: string): Promise<void> {
    const text = this.text(path);
    if (text === undefined) throw new Error(`no such file: ${path}`);
    this.trashed.push({ path, text });
    this.files.delete(path);
  }

  private entryOf(file: { data: Uint8Array; mtime: number }): LocalEntry {
    return { md5: md5(file.data), size: file.data.byteLength, mtime: file.mtime };
  }
}
