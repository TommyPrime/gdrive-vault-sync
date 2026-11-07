import { type ExecutionResult, type LocalPort, type RemotePort, execute } from "./executor";
import { type BaseEntry, type LocalEntry, type RemoteEntry, type SyncPlan, plan } from "./planner";
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
  thresholds?: DeleteThresholds;
  newVaultId(): string;
  /** プレビューで承認されたら true。 */
  confirm(plan: SyncPlan, safety: SafetyResult): Promise<boolean>;
  isFatal?: (error: unknown) => boolean;
}

export interface SyncOutcome {
  status: "busy" | "halted" | "cancelled" | "dry-run" | "done";
  plan?: SyncPlan;
  safety?: SafetyResult;
  result?: ExecutionResult;
  /** 同じパスの Drive ファイルが複数あり、1 つだけを採用した件数。 */
  duplicates?: string[];
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
  const duplicates = new Set<string>();
  // どの端末でも同じものを選ぶ。
  for (const id of [...remote.keys()].sort()) {
    const file = remote.get(id)!;
    if (byPath.has(file.path)) duplicates.add(file.path);
    else byPath.set(file.path, { id: file.id, md5: file.md5, size: file.size });
  }
  return { byPath, duplicates: [...duplicates] };
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

  async run(options: { dryRun?: boolean } = {}): Promise<SyncOutcome> {
    if (this.running) return { status: "busy" };
    this.running = true;
    try {
      return await this.runLocked(await this.createDeps(), options.dryRun ?? false);
    } finally {
      this.running = false;
    }
  }

  private async runLocked(deps: EngineDeps, dryRun: boolean): Promise<SyncOutcome> {
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

    const summary = { plan: syncPlan, safety, duplicates };
    if (safety.decision === "halt") return { status: "halted", ...summary };
    if (dryRun) return { status: "dry-run", ...summary };
    if (safety.decision === "confirm" && !(await deps.confirm(syncPlan, safety))) {
      return { status: "cancelled", ...summary };
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

    const report: VerifyReport = { matched: 0, localOnly: [], remoteOnly: [], different: [] };
    for (const [path, entry] of local) {
      if (isExcluded(path)) continue;
      const remote = byPath.get(path);
      if (!remote) report.localOnly.push(path);
      else if (remote.md5 === entry.md5) report.matched += 1;
      else report.different.push(path);
    }
    for (const path of byPath.keys()) {
      if (!local.has(path) && !isExcluded(path)) report.remoteOnly.push(path);
    }
    return report;
  }
}
