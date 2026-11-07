import { Notice, Platform, Plugin, requestUrl } from "obsidian";
import {
  AuthSession,
  InvalidGrantError,
  type OAuthClient,
  type StoredTokens,
  type TokenStore,
  buildAuthUrl,
  exchangeCode,
  pkceChallenge,
  randomUrlSafe,
} from "./auth/oauth";
import type { LoopbackSession } from "./auth/desktopLoopback";
import { GoogleDriveBackend } from "./drive/backend";
import { DriveClient, isQuotaError } from "./drive/client";
import type { HttpFn } from "./http";
import { md5OfBuffer } from "./local/md5";
import { DEFAULT_EXCLUDES, compileExcludes, scanVault } from "./local/scanner";
import { type VaultAdapter, VaultPort } from "./local/vaultPort";
import {
  DEFAULT_SETTINGS,
  type GDriveVaultSyncSettings,
  GDriveVaultSyncSettingTab,
  LocalKeys,
} from "./settings";
import { IndexedDbStateStore } from "./state/store";
import { type EngineDeps, SyncEngine, type SyncOutcome } from "./sync/engine";
import { SyncLog } from "./ui/logView";
import { reasonText, showPreview, summarize } from "./ui/previewModal";
import { type SyncStatus, statusText } from "./ui/statusBar";

const http: HttpFn = async (request) => {
  // throw: false でないと 401 や 404 が例外になり、状態コードで判断できない。
  const response = await requestUrl({ ...request, throw: false });
  return {
    status: response.status,
    // バイナリの本文では不要な変換を避ける。
    get text() {
      return response.text;
    },
    arrayBuffer: response.arrayBuffer,
    headers: response.headers,
  };
};

export default class GDriveVaultSyncPlugin extends Plugin {
  override settings: GDriveVaultSyncSettings = DEFAULT_SETTINGS;
  private readonly log = new SyncLog();
  private readonly engine = new SyncEngine(() => this.engineDeps());
  private statusEl: HTMLElement | null = null;
  private store: IndexedDbStateStore | null = null;

  override async onload(): Promise<void> {
    this.settings = { ...DEFAULT_SETTINGS, ...((await this.loadData()) as object | null) };
    this.addSettingTab(new GDriveVaultSyncSettingTab(this.app, this));
    this.statusEl = this.addStatusBarItem();
    this.setStatus({ kind: "idle", conflicts: 0 });

    this.addCommand({
      id: "login",
      name: "Google にログイン",
      callback: () => void this.login(),
    });
    this.addCommand({
      id: "check-connection",
      name: "Drive への接続を確認",
      callback: () => void this.checkConnection(),
    });
    this.addCommand({
      id: "sync",
      name: "同期を実行",
      callback: () => void this.sync(false),
    });
    this.addCommand({
      id: "dry-run",
      name: "試行（計画を見るだけで、何も書き込まない）",
      callback: () => void this.sync(true),
    });
    this.addCommand({
      id: "verify",
      name: "端末と Drive を照合",
      callback: () => void this.verify(),
    });
    this.addCommand({
      id: "copy-log",
      name: "ログをコピー",
      callback: () => void this.copyLog(),
    });
  }

  override onunload(): void {
    this.store?.close();
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
  }

  private readonly tokenStore: TokenStore = {
    load: () => this.app.loadLocalStorage(LocalKeys.tokens) as StoredTokens | null,
    save: (tokens) => this.app.saveLocalStorage(LocalKeys.tokens, tokens),
  };

  deviceName(): string {
    const saved = this.app.loadLocalStorage(LocalKeys.deviceName) as string | null;
    if (saved) return saved;
    if (Platform.isMacOS) return "Mac";
    if (Platform.isWin) return "Windows";
    if (Platform.isIosApp) return "iPad";
    return Platform.isAndroidApp ? "Android" : "device";
  }

  private setStatus(status: SyncStatus): void {
    this.statusEl?.setText(statusText(status));
  }

  private driveClient(client: OAuthClient): DriveClient {
    const session = new AuthSession(http, client, this.tokenStore);
    return new DriveClient(http, (options) => session.getAccessToken(options));
  }

  /** 前回状態の置き場。Vault の名前に依存しないよう、端末ごとの乱数で分ける。 */
  private stateStore(): IndexedDbStateStore {
    if (this.store) return this.store;
    let id = this.app.loadLocalStorage(LocalKeys.stateDbId) as string | null;
    if (!id) {
      id = crypto.randomUUID();
      this.app.saveLocalStorage(LocalKeys.stateDbId, id);
    }
    this.store = new IndexedDbStateStore(`gdrive-vault-sync-${id}`);
    return this.store;
  }

  private engineDeps(): EngineDeps {
    const client = this.oauthClient();
    if (!client) throw new Error("先に設定画面で OAuth client ID を入力してください");
    if (!this.isLoggedIn()) throw new Error("先に Google にログインしてください");

    const adapter = this.app.vault.adapter as unknown as VaultAdapter;
    const isExcluded = compileExcludes(DEFAULT_EXCLUDES);
    return {
      store: this.stateStore(),
      drive: new GoogleDriveBackend(
        this.driveClient(client),
        this.settings.driveRootFolder,
        this.app.vault.getName(),
      ),
      local: new VaultPort(adapter, md5OfBuffer),
      scan: (base) => scanVault(adapter, { isExcluded, base, hash: md5OfBuffer }),
      now: () => Date.now(),
      deviceName: this.deviceName(),
      isExcluded,
      thresholds: {
        deleteRatio: this.settings.deleteRatio,
        deleteCount: this.settings.deleteCount,
      },
      newVaultId: () => crypto.randomUUID(),
      confirm: (plan, safety) =>
        showPreview(this.app, {
          title: "同期の確認",
          plan,
          reasons: safety.reasons,
          canRun: true,
        }),
      isFatal: (error) => isQuotaError(error) || error instanceof InvalidGrantError,
    };
  }

  private async sync(dryRun: boolean): Promise<void> {
    this.setStatus({ kind: "syncing" });
    this.log.add(dryRun ? "試行を開始" : "同期を開始");
    try {
      const outcome = await this.engine.run({ dryRun });
      await this.report(outcome);
    } catch (error) {
      this.setStatus({ kind: "error" });
      this.log.add(`失敗: ${messageOf(error)}`);
      new Notice(messageOf(error), 0);
    }
  }

  private async report(outcome: SyncOutcome): Promise<void> {
    const { plan, safety, result, duplicates } = outcome;
    for (const path of duplicates ?? []) {
      this.log.add(`Drive に同じパスのファイルが複数あります: ${path}`);
    }
    if (plan) {
      for (const action of plan.actions) this.log.add(`計画 ${action.type} ${action.path}`);
    }

    switch (outcome.status) {
      case "busy":
        new Notice("同期はすでに実行中です");
        return;
      case "halted": {
        this.setStatus({ kind: "error" });
        const text = (safety?.reasons ?? []).map(reasonText).join("\n");
        this.log.add(`停止: ${text}`);
        new Notice(`同期を止めました。\n${text}`, 0);
        return;
      }
      case "dry-run":
        this.setStatus({ kind: "idle", conflicts: 0 });
        await showPreview(this.app, {
          title: "試行の結果（何も書き込んでいません）",
          plan: plan!,
          reasons: safety?.reasons ?? [],
          canRun: false,
        });
        return;
      case "cancelled":
        this.setStatus({ kind: "idle", conflicts: 0 });
        new Notice("同期を中止しました");
        return;
      case "done": {
        const failed = result?.failed ?? [];
        for (const { action, error } of failed) {
          this.log.add(`失敗 ${action.type} ${action.path}: ${messageOf(error)}`);
        }
        for (const action of result?.skipped ?? []) this.log.add(`飛ばした ${action.path}`);
        const conflicts = plan!.actions.filter((action) => action.type === "conflict").length;
        this.setStatus(failed.length > 0 ? { kind: "error" } : { kind: "idle", conflicts });
        const tail = failed.length > 0 ? `\n${failed.length} 件失敗しました` : "";
        new Notice(`同期しました: ${summarize(plan!)}${tail}`, failed.length > 0 ? 0 : undefined);
        return;
      }
    }
  }

  private async verify(): Promise<void> {
    try {
      const report = await this.engine.verify();
      const diffs = [...report.localOnly, ...report.remoteOnly, ...report.different];
      for (const path of report.localOnly) this.log.add(`照合 端末のみ ${path}`);
      for (const path of report.remoteOnly) this.log.add(`照合 Drive のみ ${path}`);
      for (const path of report.different) this.log.add(`照合 内容が違う ${path}`);
      new Notice(
        `照合: 一致 ${report.matched} 件 / 端末のみ ${report.localOnly.length} 件 / ` +
          `Drive のみ ${report.remoteOnly.length} 件 / 内容が違う ${report.different.length} 件`,
        diffs.length > 0 ? 0 : undefined,
      );
    } catch (error) {
      new Notice(messageOf(error), 0);
    }
  }

  private async copyLog(): Promise<void> {
    await navigator.clipboard.writeText(this.log.text());
    new Notice("ログをコピーしました");
  }

  private oauthClient(): OAuthClient | null {
    const clientId = this.app.loadLocalStorage(LocalKeys.clientId) as string | null;
    if (!clientId) return null;
    const clientSecret = this.app.loadLocalStorage(LocalKeys.clientSecret) as string | null;
    return { clientId, clientSecret: clientSecret ?? undefined };
  }

  isLoggedIn(): boolean {
    return this.tokenStore.load() !== null;
  }

  logout(): void {
    this.app.saveLocalStorage(LocalKeys.tokens, null);
    new Notice("ログアウトしました");
  }

  async login(): Promise<void> {
    if (!Platform.isDesktopApp) {
      new Notice("モバイルでのログインは今後の段階で対応します");
      return;
    }
    const client = this.oauthClient();
    if (!client) {
      new Notice("先に設定画面で OAuth client ID を入力してください");
      return;
    }

    let loopback: LoopbackSession | undefined;
    try {
      const { startLoopback } = await import("./auth/desktopLoopback");
      const state = randomUrlSafe();
      const codeVerifier = randomUrlSafe();
      loopback = await startLoopback(state);
      window.open(
        buildAuthUrl({
          clientId: client.clientId,
          redirectUri: loopback.redirectUri,
          codeChallenge: await pkceChallenge(codeVerifier),
          state,
        }),
      );
      const code = await loopback.code;
      const tokens = await exchangeCode(http, client, {
        code,
        codeVerifier,
        redirectUri: loopback.redirectUri,
      });
      this.tokenStore.save(tokens);
      new Notice("Google にログインしました");
    } catch (error) {
      // 利用者はブラウザから戻ってくるので、自動で消えると失敗に気づけない。
      new Notice(messageOf(error), 0);
    } finally {
      loopback?.close();
    }
  }

  /** 段階 0 の完了条件「Mac でログインし、Drive にフォルダを作れる」を確かめる。 */
  async checkConnection(): Promise<void> {
    const client = this.oauthClient();
    if (!client) {
      new Notice("先に設定画面で OAuth client ID を入力してください");
      return;
    }
    try {
      const folder = await this.driveClient(client).ensureVaultFolder(
        this.settings.driveRootFolder,
        this.app.vault.getName(),
      );
      new Notice(`Drive に接続しました: ${this.settings.driveRootFolder}/${folder.name}`);
    } catch (error) {
      new Notice(messageOf(error));
    }
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : "不明なエラーが起きました";
}
