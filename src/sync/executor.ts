import type { BaseEntry, LocalEntry, RemoteEntry, SyncAction, SyncPlan } from "./planner";

/** 端末側の操作。完全削除の口は持たせない。 */
export interface LocalPort {
  read(path: string): Promise<Uint8Array>;
  write(path: string, data: Uint8Array): Promise<LocalEntry>;
  /** 今の MD5。ファイルが無ければ null。 */
  md5(path: string): Promise<string | null>;
  /** `.trash/` へ移す。 */
  trash(path: string): Promise<void>;
}

/** Drive 側の操作。完全削除の口は持たせない。 */
export interface RemotePort {
  download(id: string): Promise<Uint8Array>;
  /** id があれば更新し、無ければ作る。 */
  upload(path: string, data: Uint8Array, id?: string): Promise<RemoteEntry>;
  /** 内容を変えずに、名前と appProperties のパスを変える。 */
  rename(id: string, path: string): Promise<void>;
  /** `files.update({ trashed: true })` */
  trash(id: string): Promise<void>;
}

/** 前回状態。操作が 1 つ終わるたびに書く。 */
export interface StatePort {
  set(path: string, entry: BaseEntry): Promise<void>;
  delete(path: string): Promise<void>;
}

export interface ExecutorPorts {
  local: LocalPort;
  remote: RemotePort;
  state: StatePort;
}

export interface ExecutionResult {
  done: SyncAction[];
  /** 計画の後に端末のファイルが変わったので触らなかった。次回の同期で判定し直す。 */
  skipped: SyncAction[];
  failed: { action: SyncAction; error: unknown }[];
}

const CONCURRENCY = 3;

class ChangedDuringSync extends Error {}

function baseEntry(local: LocalEntry, remote: RemoteEntry): BaseEntry {
  return { ...local, remoteId: remote.id, remoteMd5: remote.md5 };
}

export async function execute(
  plan: SyncPlan,
  ports: ExecutorPorts,
  options: { isFatal?: (error: unknown) => boolean } = {},
): Promise<ExecutionResult> {
  const { local, remote, state } = ports;

  /** 走査から実行までの間に保存されたファイルを、計画どおりに上書き・移動しない。 */
  const assertUnchanged = async (path: string, entry: LocalEntry | undefined) => {
    if ((await local.md5(path)) !== (entry?.md5 ?? null)) throw new ChangedDuringSync();
  };

  const runAction = async (action: SyncAction): Promise<void> => {
    switch (action.type) {
      case "upload": {
        const data = await local.read(action.path);
        const uploaded = await remote.upload(action.path, data, action.remoteId);
        // 読んだ後に変わっていても、Drive の MD5 を残せば次回に変更として検出できる。
        await state.set(action.path, baseEntry({ ...action.local, md5: uploaded.md5 }, uploaded));
        return;
      }
      case "download": {
        await assertUnchanged(action.path, action.local);
        const data = await remote.download(action.remote.id);
        const written = await local.write(action.path, data);
        await state.set(action.path, baseEntry(written, action.remote));
        return;
      }
      case "conflict": {
        await assertUnchanged(action.path, action.local);
        // 端末版を先に別名で残す。途中で失敗しても、どちらの内容も失わない。
        const data = await local.read(action.path);
        const copy = await local.write(action.conflictPath, data);
        const uploaded = await remote.upload(action.conflictPath, data);
        await state.set(action.conflictPath, baseEntry(copy, uploaded));

        const theirs = await remote.download(action.remote.id);
        const written = await local.write(action.path, theirs);
        await state.set(action.path, baseEntry(written, action.remote));
        return;
      }
      case "record":
        await state.set(action.path, baseEntry(action.local, action.remote));
        return;
      case "trashRemote":
        await remote.trash(action.remoteId);
        await state.delete(action.path);
        return;
      case "trashLocal":
        await assertUnchanged(action.path, action.local);
        await local.trash(action.path);
        await state.delete(action.path);
        return;
      case "forget":
        await state.delete(action.path);
        return;
      case "renameDuplicate":
        await remote.rename(action.remoteId, action.conflictPath);
        return;
      case "trashDuplicate":
        await remote.trash(action.remoteId);
        return;
      case "deferred":
        return;
    }
  };

  const result: ExecutionResult = { done: [], skipped: [], failed: [] };
  const queue = plan.actions.filter((action) => action.type !== "deferred");
  let next = 0;
  let stopped = false;

  const worker = async () => {
    while (next < queue.length && !stopped) {
      const action = queue[next++]!;
      try {
        await runAction(action);
        result.done.push(action);
      } catch (error) {
        // 1 件の失敗では止めない。前回状態を更新しないので、次回に判定し直される。
        if (error instanceof ChangedDuringSync) result.skipped.push(action);
        else result.failed.push({ action, error });
        // 容量不足やログインの失効は、続けても同じ結果になる（設計書 4.9）。
        if (options.isFatal?.(error)) stopped = true;
      }
    }
  };

  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, queue.length) }, worker));
  return result;
}
