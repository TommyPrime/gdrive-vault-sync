import { isConflictCopy } from "./conflict";
import { type ExecutionResult, type LocalPort, type RemotePort, execute } from "./executor";
import {
  type BaseEntry,
  type LocalEntry,
  type RemoteEntry,
  type SyncPlan,
  exceedsLimit,
  plan,
} from "./planner";
import { type DeleteThresholds, type SafetyResult, evaluateSafety } from "./safety";

export interface RemoteFile extends RemoteEntry {
  path: string;
}

/** file が null なら、ごみ箱へ移ったか、見えなくなった。 */
export interface RemoteChange {
  id: string;
  file: RemoteFile | null;
}

export interface DriveBackend extends RemotePort {
  /** rootFound はこの Vault の Drive フォルダの有無。vault.json が読めなければ vaultId は null。 */
  readVault(): Promise<{ rootFound: boolean; vaultId: string | null }>;
  /** フォルダと vault.json を用意する。承認の後にしか呼ばない。 */
  initVault(vaultId: string): Promise<void>;
  startPageToken(): Promise<string>;
  listAll(vaultId: string): Promise<RemoteFile[]>;
  /** pageToken が失効していれば null。全件の取り直しになる。 */
  listChanges(
    pageToken: string,
    vaultId: string,
  ): Promise<{ changes: RemoteChange[]; pageToken: string } | null>;
}

export interface SyncState {
  base: Map<string, BaseEntry>;
  remote: Map<string, RemoteFile>;
  vaultId: string | null;
  pageToken: string | null;
}

export interface StateStore {
  load(): Promise<SyncState>;
  set(path: string, entry: BaseEntry): Promise<void>;
  delete(path: string): Promise<void>;
  saveRemote(remote: ReadonlyMap<string, RemoteFile>, pageToken: string | null): Promise<void>;
  saveVaultId(vaultId: string): Promise<void>;
}

export interface EngineDeps {
  store: StateStore;
  drive: DriveBackend;
  local: LocalPort;
  scan(base: ReadonlyMap<string, BaseEntry>): Promise<Map<string, LocalEntry>>;
  now(): number;
  deviceName: string;
  isExcluded?: (path: string) => boolean;
  /** これを超えるファイルは同期しない。モバイルだけが渡す。 */
  maxFileSize?: number;
  thresholds?: DeleteThresholds;
  newVaultId(): string;
  /** プレビューで承認されたら true。 */
  confirm(plan: SyncPlan, safety: SafetyResult): Promise<boolean>;
  isFatal?: (error: unknown) => boolean;
}

export interface SyncOutcome {
  /** needs-confirm は自動実行で確認が必要になった状態。何も書かずに止まる。 */
  status: "busy" | "halted" | "needs-confirm" | "cancelled" | "dry-run" | "done";
  plan?: SyncPlan;
  safety?: SafetyResult;
  result?: ExecutionResult;
  /** 同じパスの Drive ファイルが複数あったパス。 */
  duplicates?: string[];
  /** 端末に残っている競合コピーの数。今回の計画で増える分を含む。 */
  conflictCopies?: number;
}

export interface VerifyReport {
  matched: number;
  /** 端末にだけあるパス。 */
  localOnly: string[];
  /** Drive にだけあるパス。 */
  remoteOnly: string[];
  /** 内容が違うパス。 */
  different: string[];
}

function toPathMap(remote: ReadonlyMap<string, RemoteFile>) {
  const byPath = new Map<string, RemoteEntry>();
  const duplicates = new Map<string, RemoteEntry[]>();
  // どの端末でも同じものを選ぶ。
  for (const id of [...remote.keys()].sort()) {
    const file = remote.get(id)!;
    const entry = { id: file.id, md5: file.md5, size: file.size };
    if (!byPath.has(file.path)) byPath.set(file.path, entry);
    else duplicates.set(file.path, [...(duplicates.get(file.path) ?? []), entry]);
  }
  return { byPath, duplicates };
}

async function fetchRemote(deps: EngineDeps, state: SyncState, vaultId: string) {
  if (state.pageToken !== null) {
    const delta = await deps.drive.listChanges(state.pageToken, vaultId);
    if (delta) {
      const remote = new Map(state.remote);
      for (const change of delta.changes) {
        if (change.file) remote.set(change.id, change.file);
        else remote.delete(change.id);
      }
      return { remote, pageToken: delta.pageToken };
    }
  }
  // 一覧の間の変更を取りこぼさないよう、一覧より先に token を取る。
  const pageToken = await deps.drive.startPageToken();
  const files = await deps.drive.listAll(vaultId);
  return { remote: new Map(files.map((file) => [file.id, file])), pageToken };
}

/** 同期の 1 回分（設計書 4.4）。同時に実行できるのは 1 つだけ。 */
export class SyncEngine {
  private running = false;

  constructor(private readonly createDeps: () => Promise<EngineDeps> | EngineDeps) {}

  get isRunning(): boolean {
    return this.running;
  }

  /** interactive が false なら確認画面を開かず、needs-confirm で止まる。既定は true。 */
  async run(options: { dryRun?: boolean; interactive?: boolean } = {}): Promise<SyncOutcome> {
    if (this.running) return { status: "busy" };
    this.running = true;
    try {
      return await this.runLocked(
        await this.createDeps(),
        options.dryRun ?? false,
        options.interactive ?? true,
      );
    } finally {
      this.running = false;
    }
  }

  private async runLocked(
    deps: EngineDeps,
    dryRun: boolean,
    interactive: boolean,
  ): Promise<SyncOutcome> {
    const state = await deps.store.load();
    const local = await deps.scan(state.base);
    const vault = await deps.drive.readVault();

    // 未接続の端末は、承認の後にフォルダを作るので「見つからない」にしない。
    const driveRootFound = vault.rootFound || state.vaultId === null;
    const sameVault = state.vaultId === null || state.vaultId === vault.vaultId;

    let remote = state.remote;
    let pageToken = state.pageToken;
    if (vault.vaultId !== null && sameVault) {
      ({ remote, pageToken } = await fetchRemote(deps, state, vault.vaultId));
      if (!dryRun) await deps.store.saveRemote(remote, pageToken);
    }

    const { byPath, duplicates } = toPathMap(remote);
    const syncPlan = plan({
      local,
      remote: byPath,
      base: state.base,
      now: deps.now(),
      deviceName: deps.deviceName,
      isExcluded: deps.isExcluded,
      duplicates,
      maxFileSize: deps.maxFileSize,
    });
    const safety = evaluateSafety({
      plan: syncPlan,
      local,
      base: state.base,
      driveRootFound,
      deviceVaultId: state.vaultId,
      driveVaultId: vault.vaultId,
      thresholds: deps.thresholds,
    });

    const conflictCopies =
      [...local.keys()].filter(isConflictCopy).length +
      syncPlan.actions.filter((action) => action.type === "conflict").length;
    const summary = { plan: syncPlan, safety, duplicates: [...duplicates.keys()], conflictCopies };
    if (safety.decision === "halt") return { status: "halted", ...summary };
    if (dryRun) return { status: "dry-run", ...summary };
    if (safety.decision === "confirm") {
      if (!interactive) return { status: "needs-confirm", ...summary };
      if (!(await deps.confirm(syncPlan, safety))) return { status: "cancelled", ...summary };
    }

    const vaultId = vault.vaultId ?? deps.newVaultId();
    if (vault.vaultId === null) await deps.drive.initVault(vaultId);
    if (state.vaultId === null) await deps.store.saveVaultId(vaultId);

    const result = await execute(
      syncPlan,
      { local: deps.local, remote: deps.drive, state: deps.store },
      { isFatal: deps.isFatal },
    );
    return { status: "done", ...summary, result };
  }

  /** 端末と Drive の中身を MD5 で照らし合わせる。何も書かない。 */
  async verify(): Promise<VerifyReport> {
    const deps = await this.createDeps();
    const state = await deps.store.load();
    const local = await deps.scan(state.base);
    const vault = await deps.drive.readVault();
    const files = vault.vaultId ? await deps.drive.listAll(vault.vaultId) : [];
    const { byPath } = toPathMap(new Map(files.map((file) => [file.id, file])));
    const isExcluded = deps.isExcluded ?? (() => false);

    const skipped = (path: string) =>
      exceedsLimit(local.get(path)?.size, deps.maxFileSize) ||
      exceedsLimit(byPath.get(path)?.size, deps.maxFileSize);

    const report: VerifyReport = { matched: 0, localOnly: [], remoteOnly: [], different: [] };
    for (const [path, entry] of local) {
      if (isExcluded(path) || skipped(path)) continue;
      const remote = byPath.get(path);
      if (!remote) report.localOnly.push(path);
      else if (remote.md5 === entry.md5) report.matched += 1;
      else report.different.push(path);
    }
    for (const path of byPath.keys()) {
      if (!local.has(path) && !isExcluded(path) && !skipped(path)) report.remoteOnly.push(path);
    }
    return report;
  }
}
