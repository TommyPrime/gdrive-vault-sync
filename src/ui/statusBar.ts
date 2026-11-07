export type SyncStatus =
  | { kind: "idle"; conflicts: number }
  | { kind: "syncing" }
  | { kind: "error" };

export function statusText(status: SyncStatus): string {
  switch (status.kind) {
    case "syncing":
      return "Drive: 同期中";
    case "error":
      return "Drive: エラー";
    case "idle":
      return status.conflicts > 0 ? `Drive: 競合 ${status.conflicts} 件` : "Drive: 待機中";
  }
}
