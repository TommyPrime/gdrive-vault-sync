import { conflictPath } from "./conflict";

/** 判定は副作用のない純粋関数に保つ。I/O はここへ持ち込まない。 */

export interface LocalEntry {
  md5: string;
  size: number;
  mtime: number;
}

export interface RemoteEntry {
  id: string;
  md5: string;
  size: number;
}

/** 前回状態。設計書 4.3 */
export interface BaseEntry extends LocalEntry {
  remoteId: string;
  remoteMd5: string;
}

export type SyncAction =
  /** remoteId が無ければ新しいファイルとして作る。 */
  | { type: "upload"; path: string; local: LocalEntry; remoteId?: string }
  /** local があれば上書きになる。 */
  | { type: "download"; path: string; remote: RemoteEntry; local?: LocalEntry }
  | {
      type: "conflict";
      path: string;
      local: LocalEntry;
      remote: RemoteEntry;
      conflictPath: string;
    }
  | { type: "record"; path: string; local: LocalEntry; remote: RemoteEntry }
  | { type: "trashRemote"; path: string; remoteId: string }
  | { type: "trashLocal"; path: string; local: LocalEntry }
  | { type: "forget"; path: string }
  /** 編集中なので今回は触らない。 */
  | { type: "deferred"; path: string }
  /** Drive に同じパスで別の内容がある。名前を変え、通常の新規として全端末へ届ける。 */
  | { type: "renameDuplicate"; path: string; remoteId: string; conflictPath: string }
  /** Drive に同じパスで同じ内容がある。 */
  | { type: "trashDuplicate"; path: string; remoteId: string };

export interface SyncPlan {
  actions: SyncAction[];
  /** 除外を除いたパスの数。削除の割合の分母になる。 */
  totalPaths: number;
  /** 大きいので判定しなかったパス。 */
  skipped: string[];
}

export interface PlanInput {
  local: ReadonlyMap<string, LocalEntry>;
  remote: ReadonlyMap<string, RemoteEntry>;
  base: ReadonlyMap<string, BaseEntry>;
  now: number;
  deviceName: string;
  /**
   * 除外したパスは走査の結果に現れない。ここで弾かないと、後から除外を足したときに
   * 「端末側で削除された」と判定され、Drive 側がごみ箱へ移される。
   */
  isExcluded?: (path: string) => boolean;
  recentEditMs?: number;
  /** remote で採用しなかった、同じパスの Drive ファイル（内容が違えば名前を変え、同じならごみ箱へ移す）。 */
  duplicates?: ReadonlyMap<string, readonly RemoteEntry[]>;
  /**
   * これを超えるファイルは判定しない（モバイルの 50MB）。片方にしか無いことを削除と読むと、
   * 他の端末のファイルをごみ箱へ移してしまうので、除外と同じ扱いにする。
   */
  maxFileSize?: number;
}

export const RECENT_EDIT_MS = 3_000;

export function exceedsLimit(size: number | undefined, limit: number | undefined): boolean {
  return size !== undefined && limit !== undefined && size > limit;
}

export function plan(input: PlanInput): SyncPlan {
  const { local, remote, base, now, deviceName } = input;
  const recentEditMs = input.recentEditMs ?? RECENT_EDIT_MS;
  const isExcluded = input.isExcluded ?? (() => false);

  const paths = [...new Set([...local.keys(), ...remote.keys(), ...base.keys()])].sort();
  const taken = new Set(paths);
  const when = new Date(now);

  const isEditing = (entry: LocalEntry) => now - entry.mtime < recentEditMs;

  const conflict = (path: string, l: LocalEntry, r: RemoteEntry): SyncAction => {
    if (isEditing(l)) return { type: "deferred", path };
    const copy = conflictPath(path, when, deviceName, (candidate) => taken.has(candidate));
    taken.add(copy);
    return { type: "conflict", path, local: l, remote: r, conflictPath: copy };
  };

  const decide = (path: string): SyncAction | null => {
    const l = local.get(path);
    const r = remote.get(path);
    const b = base.get(path);

    if (!b) {
      if (l && r) {
        return l.md5 === r.md5
          ? { type: "record", path, local: l, remote: r }
          : conflict(path, l, r);
      }
      if (l) return { type: "upload", path, local: l };
      return r ? { type: "download", path, remote: r } : null;
    }

    if (!l && !r) return { type: "forget", path };

    if (!l) {
      return r!.md5 !== b.remoteMd5
        ? { type: "download", path, remote: r! }
        : { type: "trashRemote", path, remoteId: r!.id };
    }

    const localChanged = l.md5 !== b.md5;

    if (!r) {
      return localChanged ? { type: "upload", path, local: l } : { type: "trashLocal", path, local: l };
    }

    const remoteChanged = r.md5 !== b.remoteMd5;

    if (!localChanged && !remoteChanged) return null;
    if (localChanged && !remoteChanged) return { type: "upload", path, local: l, remoteId: r.id };
    if (!localChanged) {
      return isEditing(l)
        ? { type: "deferred", path }
        : { type: "download", path, remote: r, local: l };
    }
    return l.md5 === r.md5 ? { type: "record", path, local: l, remote: r } : conflict(path, l, r);
  };

  const resolveDuplicates = (path: string): SyncAction[] => {
    const seen = new Set([remote.get(path)?.md5]);
    return (input.duplicates?.get(path) ?? []).map((entry) => {
      if (seen.has(entry.md5)) return { type: "trashDuplicate", path, remoteId: entry.id };
      seen.add(entry.md5);
      const copy = conflictPath(path, when, deviceName, (candidate) => taken.has(candidate));
      taken.add(copy);
      return { type: "renameDuplicate", path, remoteId: entry.id, conflictPath: copy };
    });
  };

  const isTooLarge = (path: string) =>
    exceedsLimit(local.get(path)?.size, input.maxFileSize) ||
    exceedsLimit(remote.get(path)?.size, input.maxFileSize);

  const actions: SyncAction[] = [];
  const skipped: string[] = [];
  let totalPaths = 0;
  for (const path of paths) {
    if (isExcluded(path)) continue;
    if (isTooLarge(path)) {
      skipped.push(path);
      continue;
    }
    totalPaths += 1;
    const action = decide(path);
    if (action) actions.push(action);
    actions.push(...resolveDuplicates(path));
  }
  return { actions, totalPaths, skipped };
}
