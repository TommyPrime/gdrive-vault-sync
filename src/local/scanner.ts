import { type BaseEntry, type LocalEntry, exceedsLimit } from "../sync/planner";

export const DEFAULT_EXCLUDES = [
  ".git/**",
  ".trash/**",
  "**/.DS_Store",
  ".obsidian/workspace*.json",
  ".obsidian/cache/**",
  "**/node_modules/**",
];

export const DEFAULT_MOBILE_MAX_MB = 50;

/** 壊れた値で上限が外れないよう、既定値に戻す。 */
export function mobileMaxBytes(megabytes: unknown): number {
  const valid = typeof megabytes === "number" && Number.isFinite(megabytes) && megabytes > 0;
  return (valid ? megabytes : DEFAULT_MOBILE_MAX_MB) * 1024 * 1024;
}

/** Obsidian の DataAdapter のうち、走査に使う部分。 */
export interface ScanAdapter {
  list(path: string): Promise<{ files: string[]; folders: string[] }>;
  stat(path: string): Promise<{ size: number; mtime: number } | null>;
  readBinary(path: string): Promise<ArrayBuffer>;
}

function globToRegExp(pattern: string): RegExp {
  let source = "";
  for (let i = 0; i < pattern.length; i += 1) {
    const char = pattern[i]!;
    if (pattern.startsWith("**/", i)) {
      source += "(?:.*/)?";
      i += 2;
    } else if (pattern.startsWith("**", i)) {
      source += ".*";
      i += 1;
    } else if (char === "*") {
      source += "[^/]*";
    } else {
      source += char.replace(/[.+?^${}()|[\]\\]/g, "\\$&");
    }
  }
  return new RegExp(`^${source}$`);
}

export function compileExcludes(patterns: readonly string[]): (path: string) => boolean {
  const compiled = patterns.map(globToRegExp);
  return (path) => compiled.some((pattern) => pattern.test(path));
}

const strip = (path: string) => path.replace(/^\/+/, "");

/**
 * Vault を走査する。隠しフォルダも扱うので adapter を使う。
 * mtime と size が前回と同じなら、ハッシュを計算し直さない（設計書 4.3）。
 */
export async function scanVault(
  adapter: ScanAdapter,
  options: {
    isExcluded: (path: string) => boolean;
    base: ReadonlyMap<string, BaseEntry>;
    hash: (data: ArrayBuffer) => string;
    /** 超えるファイルは読まない。消えたと読まれないよう、結果には残す。planner が判定から外す。 */
    maxFileSize?: number;
  },
): Promise<Map<string, LocalEntry>> {
  const result = new Map<string, LocalEntry>();
  const pending = ["/"];

  while (pending.length > 0) {
    const listing = await adapter.list(pending.pop()!);
    for (const folder of listing.folders.map(strip)) {
      // `.git/**` のような「フォルダ以下」の除外は、中へ入らずに済ませる。
      if (!options.isExcluded(`${folder}/_`)) pending.push(folder);
    }
    for (const path of listing.files.map(strip)) {
      if (options.isExcluded(path)) continue;
      const stat = await adapter.stat(path);
      if (!stat) continue;
      const known = options.base.get(path);
      if (exceedsLimit(stat.size, options.maxFileSize)) {
        result.set(path, { md5: known?.md5 ?? "", size: stat.size, mtime: stat.mtime });
        continue;
      }
      const md5 =
        known && known.size === stat.size && known.mtime === stat.mtime
          ? known.md5
          : options.hash(await adapter.readBinary(path));
      result.set(path, { md5, size: stat.size, mtime: stat.mtime });
    }
  }
  return result;
}
