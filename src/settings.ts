import { App, Platform, PluginSettingTab, Setting } from "obsidian";
import type GDriveVaultSyncPlugin from "./main";
import { DEFAULT_MOBILE_MAX_MB } from "./local/scanner";
import { DEFAULT_THRESHOLDS } from "./sync/safety";
import { DEFAULT_INTERVAL_SEC } from "./sync/scheduler";

/**
 * data.json に入る設定。data.json は Vault の .obsidian/ 内にあり、同期で他の端末へ渡る。
 * 認証情報をここへ入れない。端末ごとの値は下の LocalKeys へ。
 */
export interface GDriveVaultSyncSettings {
  driveRootFolder: string;
  /** 削除が全体のこの割合を超えたら確認する。 */
  deleteRatio: number;
  /** 削除がこの件数を超えたら確認する。 */
  deleteCount: number;
  /** 自動同期の間隔。0 で自動同期を止める。 */
  syncIntervalSec: number;
}

export const DEFAULT_SETTINGS: GDriveVaultSyncSettings = {
  driveRootFolder: "Obsidian",
  deleteRatio: DEFAULT_THRESHOLDS.deleteRatio,
  deleteCount: DEFAULT_THRESHOLDS.deleteCount,
  syncIntervalSec: DEFAULT_INTERVAL_SEC,
};

/** app.saveLocalStorage のキー。端末ごとに保存し、Vault には書かない。 */
export const LocalKeys = {
  clientId: "gdrive-vault-sync:client-id",
  clientSecret: "gdrive-vault-sync:client-secret",
  tokens: "gdrive-vault-sync:tokens",
  deviceName: "gdrive-vault-sync:device-name",
  stateDbId: "gdrive-vault-sync:state-db-id",
  /** data.json に置くと、試行中は同期されず、他の端末へ切り替えが届かない。 */
  trialMode: "gdrive-vault-sync:trial-mode",
  mobileMaxMb: "gdrive-vault-sync:mobile-max-mb",
} as const;

export class GDriveVaultSyncSettingTab extends PluginSettingTab {
  constructor(
    app: App,
    private readonly plugin: GDriveVaultSyncPlugin,
  ) {
    super(app, plugin);
  }

  override display(): void {
    const { containerEl, app } = this;
    containerEl.empty();

    if (Platform.isMobile) {
      // モバイルにはステータスバーが無い。
      new Setting(containerEl).setName("同期の状態").setDesc(this.plugin.statusLabel());
    }
    if (Platform.isDesktopApp) this.displayClient();

    new Setting(containerEl)
      .setName("Drive のフォルダ名")
      .setDesc("マイドライブ直下のフォルダ。その下に Vault 名のフォルダを作ります。")
      .addText((text) =>
        text.setValue(this.plugin.settings.driveRootFolder).onChange(async (value) => {
          this.plugin.settings.driveRootFolder = value.trim() || DEFAULT_SETTINGS.driveRootFolder;
          await this.plugin.saveSettings();
        }),
      );

    new Setting(containerEl)
      .setName("端末名")
      .setDesc("競合コピーの名前に入ります。この端末にだけ保存します。")
      .addText((text) =>
        text.setValue(this.plugin.deviceName()).onChange((value) => {
          app.saveLocalStorage(LocalKeys.deviceName, value.trim() || null);
        }),
      );

    new Setting(containerEl)
      .setName("同期の間隔（秒）")
      .setDesc("起動時、保存の 10 秒後、この間隔ごとに自動で同期します。0 で自動同期を止めます。")
      .addText((text) =>
        text.setValue(String(this.plugin.settings.syncIntervalSec)).onChange(async (value) => {
          this.plugin.settings.syncIntervalSec = Number(value);
          await this.plugin.saveSettings();
          this.plugin.restartAutoSync();
        }),
      );

    new Setting(containerEl)
      .setName("試行モード")
      .setDesc("計画をログに出すだけで、何も書き込みません。この端末にだけ保存します。")
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.trialMode()).onChange((value) => {
          app.saveLocalStorage(LocalKeys.trialMode, value || null);
        }),
      );

    new Setting(containerEl)
      .setName("削除の確認（割合）")
      .setDesc("削除予定が全体のこの割合を超えたら、止めて確認します。0.1 は 10% です。")
      .addText((text) =>
        text.setValue(String(this.plugin.settings.deleteRatio)).onChange(async (value) => {
          this.plugin.settings.deleteRatio = Number(value);
          await this.plugin.saveSettings();
        }),
      );

    new Setting(containerEl)
      .setName("削除の確認（件数）")
      .setDesc("削除予定がこの件数を超えたら、止めて確認します。")
      .addText((text) =>
        text.setValue(String(this.plugin.settings.deleteCount)).onChange(async (value) => {
          this.plugin.settings.deleteCount = Number(value);
          await this.plugin.saveSettings();
        }),
      );

    const loggedIn = this.plugin.isLoggedIn();
    if (Platform.isMobile) this.displayMobile();

    // モバイルはログインできない。接続は上のトークンの貼り付けで行う。
    if (Platform.isDesktopApp || loggedIn) {
      new Setting(containerEl)
        .setName("Google アカウント")
        .setDesc(loggedIn ? "ログイン済みです。" : "ログインしていません。")
        .addButton((button) =>
          button.setButtonText(loggedIn ? "ログアウト" : "ログイン").onClick(async () => {
            if (loggedIn) this.plugin.logout();
            else await this.plugin.login();
            this.display();
          }),
        );
    }

    if (Platform.isDesktopApp) {
      new Setting(containerEl)
        .setName("モバイル用トークン")
        .setDesc("モバイルの接続に使う QR と文字列を表示します。見た人は Drive に接続できます。")
        .addButton((button) =>
          button.setButtonText("表示").onClick(() => this.plugin.showMobileToken()),
        );
    }

    new Setting(containerEl)
      .setName("接続の確認")
      .setDesc("Drive に同期先のフォルダを用意します。ファイルは同期しません。")
      .addButton((button) =>
        button.setButtonText("確認").onClick(async () => {
          await this.plugin.checkConnection();
        }),
      );
  }

  private displayMobile(): void {
    const { containerEl, app } = this;
    let pasted = "";
    new Setting(containerEl)
      .setName("モバイル用トークン")
      .setDesc("デスクトップの設定画面に表示した文字列を貼り付けます。")
      .addText((text) => {
        text.inputEl.type = "password";
        text.onChange((value) => (pasted = value));
      })
      .addButton((button) =>
        button.setButtonText("接続").onClick(() => {
          if (this.plugin.importMobileToken(pasted)) this.display();
        }),
      );

    new Setting(containerEl)
      .setName("同期しないサイズ（MB）")
      .setDesc("これより大きいファイルは、このモバイルでは同期しません。この端末にだけ保存します。")
      .addText((text) => {
        const saved = app.loadLocalStorage(LocalKeys.mobileMaxMb) as number | null;
        text.setValue(String(saved ?? DEFAULT_MOBILE_MAX_MB)).onChange((value) => {
          app.saveLocalStorage(LocalKeys.mobileMaxMb, Number(value));
        });
      });
  }

  private displayClient(): void {
    const { containerEl, app } = this;
    new Setting(containerEl)
      .setName("OAuth client ID")
      .setDesc("Google Cloud で作った「デスクトップ アプリ」のクライアント ID。この端末にだけ保存します。")
      .addText((text) =>
        text.setValue(app.loadLocalStorage(LocalKeys.clientId) ?? "").onChange((value) => {
          app.saveLocalStorage(LocalKeys.clientId, value.trim() || null);
        }),
      );

    new Setting(containerEl)
      .setName("OAuth client secret")
      .setDesc("デスクトップ アプリのクライアントのログインに必要です。この端末にだけ保存します。")
      .addText((text) => {
        text.inputEl.type = "password";
        text.setValue(app.loadLocalStorage(LocalKeys.clientSecret) ?? "").onChange((value) => {
          app.saveLocalStorage(LocalKeys.clientSecret, value.trim() || null);
        });
      });
  }
}
