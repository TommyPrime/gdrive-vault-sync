import type { SyncPlan } from "./planner";

export type SafetyReason =
  | "drive-root-missing"
  | "vault-id-mismatch"
  | "local-empty"
  | "first-sync"
  | "too-many-deletes";

export interface SafetyResult {
  /** halt は承認しても実行しない。confirm はプレビューで承認されたら実行する。 */
  decision: "proceed" | "confirm" | "halt";
  reasons: SafetyReason[];
}

export interface DeleteThresholds {
  /** 全体に対する割合。これを超えたら確認する。 */
  deleteRatio: number;
  /** 件数。これを超えたら確認する。 */
  deleteCount: number;
}

export const DEFAULT_THRESHOLDS: DeleteThresholds = { deleteRatio: 0.1, deleteCount: 50 };

export interface SafetyInput {
  plan: SyncPlan;
  local: ReadonlyMap<string, unknown>;
  base: ReadonlyMap<string, unknown>;
  driveRootFound: boolean;
  /** この端末が覚えている vaultId。未接続の端末は null。 */
  deviceVaultId: string | null;
  /** Drive の vault.json の vaultId。読めなければ null。 */
  driveVaultId: string | null;
  thresholds?: DeleteThresholds;
}

const isConfig = (path: string) => path === ".obsidian" || path.startsWith(".obsidian/");

function hasNotes(paths: ReadonlyMap<string, unknown>): boolean {
  for (const path of paths.keys()) {
    if (!isConfig(path)) return true;
  }
  return false;
}

/** 壊れた値で安全装置が外れないよう、有限で 0 以上の値だけを受け入れる。 */
function usable(value: number, fallback: number): number {
  return Number.isFinite(value) && value >= 0 ? value : fallback;
}

export function evaluateSafety(input: SafetyInput): SafetyResult {
  const { plan, local, base, driveRootFound, deviceVaultId, driveVaultId } = input;
  const deleteRatio = usable(
    input.thresholds?.deleteRatio ?? DEFAULT_THRESHOLDS.deleteRatio,
    DEFAULT_THRESHOLDS.deleteRatio,
  );
  const deleteCount = usable(
    input.thresholds?.deleteCount ?? DEFAULT_THRESHOLDS.deleteCount,
    DEFAULT_THRESHOLDS.deleteCount,
  );

  const halts: SafetyReason[] = [];
  if (!driveRootFound) halts.push("drive-root-missing");
  if (deviceVaultId !== null && deviceVaultId !== driveVaultId) halts.push("vault-id-mismatch");
  // ノートがあったのに消えているなら、Vault の消失や未マウントを疑う（Q4）。
  if (hasNotes(base) && !hasNotes(local)) halts.push("local-empty");

  const confirms: SafetyReason[] = [];
  if (base.size === 0) confirms.push("first-sync");

  const deletes = plan.actions.filter(
    (action) => action.type === "trashRemote" || action.type === "trashLocal",
  ).length;
  const ratio = plan.totalPaths > 0 ? deletes / plan.totalPaths : 0;
  if (deletes > deleteCount || ratio > deleteRatio) confirms.push("too-many-deletes");

  const reasons = [...halts, ...confirms];
  if (halts.length > 0) return { decision: "halt", reasons };
  return { decision: confirms.length > 0 ? "confirm" : "proceed", reasons };
}
