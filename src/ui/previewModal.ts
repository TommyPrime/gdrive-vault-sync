import { type App, Modal, Setting } from "obsidian";
import type { SyncAction, SyncPlan } from "../sync/planner";
import type { SafetyReason } from "../sync/safety";

const LIST_LIMIT = 200;

const REASONS: Record<SafetyReason, string> = {
  "first-sync": "初回の同期です。内容を確認してください。",
  "too-many-deletes": "削除の予定が多いので止めました。",
  "drive-root-missing": "Drive の同期先フォルダが見つかりません。",
  "vault-id-mismatch": "Drive の Vault がこの端末の Vault と一致しません。",
  "local-empty": "前回はノートがあったのに、端末側が空です。",
};

const LABELS: { type: SyncAction["type"]; label: string }[] = [
  { type: "upload", label: "アップロード" },
  { type: "download", label: "ダウンロード" },
  { type: "conflict", label: "競合" },
  { type: "trashRemote", label: "Drive のごみ箱へ" },
  { type: "trashLocal", label: "端末の .trash/ へ" },
  { type: "deferred", label: "編集中のため次回へ" },
  { type: "renameDuplicate", label: "Drive の重複を競合コピーへ" },
  { type: "trashDuplicate", label: "同じ内容の重複を Drive のごみ箱へ" },
];

export function reasonText(reason: SafetyReason): string {
  return REASONS[reason];
}

export function summarize(plan: SyncPlan): string {
  const parts = LABELS.map(({ type, label }) => {
    const count = plan.actions.filter((action) => action.type === type).length;
    return count > 0 ? `${label} ${count} 件` : null;
  }).filter((part) => part !== null);
  return parts.length > 0 ? parts.join(" / ") : "変更はありません";
}

/** 処理予定を見せる。canRun が false なら閉じるだけ。実行を選んだときだけ true で解決する。 */
export function showPreview(
  app: App,
  options: { title: string; plan: SyncPlan; reasons: SafetyReason[]; canRun: boolean },
): Promise<boolean> {
  return new Promise((resolve) => {
    new PreviewModal(app, options, resolve).open();
  });
}

class PreviewModal extends Modal {
  private run = false;

  constructor(
    app: App,
    private readonly options: {
      title: string;
      plan: SyncPlan;
      reasons: SafetyReason[];
      canRun: boolean;
    },
    private readonly done: (run: boolean) => void,
  ) {
    super(app);
  }

  override onOpen(): void {
    const { title, plan, reasons, canRun } = this.options;
    this.setTitle(title);
    const { contentEl } = this;

    for (const reason of reasons) contentEl.createEl("p", { text: reasonText(reason) });
    contentEl.createEl("p", { text: summarize(plan) });

    for (const { type, label } of LABELS) {
      const paths = plan.actions.filter((action) => action.type === type);
      if (paths.length === 0) continue;
      const details = contentEl.createEl("details");
      details.createEl("summary", { text: `${label}（${paths.length} 件）` });
      const list = details.createEl("ul");
      for (const action of paths.slice(0, LIST_LIMIT)) list.createEl("li", { text: action.path });
      if (paths.length > LIST_LIMIT) {
        details.createEl("p", { text: `ほか ${paths.length - LIST_LIMIT} 件` });
      }
    }

    const buttons = new Setting(contentEl).addButton((button) =>
      button.setButtonText(canRun ? "中止" : "閉じる").onClick(() => this.close()),
    );
    if (canRun) {
      buttons.addButton((button) =>
        button
          .setButtonText("実行")
          .setCta()
          .onClick(() => {
            this.run = true;
            this.close();
          }),
      );
    }
  }

  override onClose(): void {
    this.contentEl.empty();
    this.done(this.run);
  }
}
