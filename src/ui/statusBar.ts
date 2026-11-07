export type SyncStatus =
  | { kind: "idle"; conflicts: number }
  | { kind: "trial"; conflicts: number }
  | { kind: "syncing" }
  | { kind: "waiting" }
  | { kind: "error" };

export function statusText(status: SyncStatus): string {
  switch (status.kind) {
    case "syncing":
      return "Drive: 同期中";
    case "waiting":
      return "Drive: 確認待ち";
    case "error":
      return "Drive: エラー";
    case "trial":
      return status.conflicts > 0 ? `Drive: 試行中 競合 ${status.conflicts} 件` : "Drive: 試行中";
    case "idle":
      return status.conflicts > 0 ? `Drive: 競合 ${status.conflicts} 件` : "Drive: 待機中";
  }
}
