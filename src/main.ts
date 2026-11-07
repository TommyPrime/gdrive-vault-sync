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
import { decodeMobileToken, encodeMobileToken, toStoredTokens } from "./auth/mobileToken";
import { GoogleDriveBackend } from "./drive/backend";
import { DriveClient, isQuotaError } from "./drive/client";
import type { HttpFn } from "./http";
import { md5OfBuffer } from "./local/md5";
import { DEFAULT_EXCLUDES, compileExcludes, mobileMaxBytes, scanVault } from "./local/scanner";
import { type VaultAdapter, VaultPort } from "./local/vaultPort";
import {
  DEFAULT_SETTINGS,
  type GDriveVaultSyncSettings,
  GDriveVaultSyncSettingTab,
  LocalKeys,
} from "./settings";
import { IndexedDbStateStore } from "./state/store";
import { type EngineDeps, SyncEngine, type SyncOutcome } from "./sync/engine";
import { AutoSync, intervalMs } from "./sync/scheduler";
import { SyncLog } from "./ui/logView";
import { MobileTokenModal } from "./ui/mobileTokenModal";
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

type SyncMode = "manual" | "dry-run" | "auto";

export default class GDriveVaultSyncPlugin extends Plugin {
  override settings: GDriveVaultSyncSettings = DEFAULT_SETTINGS;
  private readonly log = new SyncLog();
  private readonly engine = new SyncEngine(() => this.engineDeps());
  private readonly autoSync = new AutoSync({
    run: () => void this.sync("auto"),
    intervalMs: () => intervalMs(this.settings.syncIntervalSec),
  });
  private statusEl: HTMLElement | null = null;
  /** モバイルにはステータスバーが無いので、設定画面に出すために覚える。 */
  private status: SyncStatus = { kind: "idle", conflicts: 0 };
  private store: IndexedDbStateStore | null = null;
  /** 自動実行が同じ内容を毎回ログと通知に出さないよう、直前のものを覚える。 */
  private lastPlanLog = "";
  private lastAlert: string | null = null;

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
      callback: () => void this.sync("manual"),
    });
    this.addCommand({
      id: "dry-run",
      name: "試行（計画を見るだけで、何も書き込まない）",
      callback: () => void this.sync("dry-run"),
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
    this.addRibbonIcon("refresh-cw", "Drive と同期", () => void this.sync("manual"));

    // 読み込み中の create を変更と数えないよう、画面の準備ができてから登録する。
    this.app.workspace.onLayoutReady(() => {
      // 同期が書いたファイルの通知で、もう一度同期しない。同期中の編集は次の定期実行が拾う。
      const changed = () => {
        if (!this.engine.isRunning) this.autoSync.changed();
      };
      this.registerEvent(this.app.vault.on("create", changed));
      this.registerEvent(this.app.vault.on("modify", changed));
      this.registerEvent(this.app.vault.on("delete", changed));
      this.registerEvent(this.app.vault.on("rename", changed));
      if (Platform.isMobile) {
        this.registerDomEvent(document, "visibilitychange", () => {
          if (document.visibilityState === "visible") this.autoSync.resumed();
        });
      }
      this.autoSync.start();
    });
  }

  override onunload(): void {
    this.autoSync.stop();
    this.store?.close();
  }

  restartAutoSync(): void {
    this.autoSync.restart();
  }

  trialMode(): boolean {
    return this.app.loadLocalStorage(LocalKeys.trialMode) === true;
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
    this.status = status;
    this.statusEl?.setText(statusText(status));
  }

  statusLabel(): string {
    return statusText(this.status);
  }

  /** 設定は端末ごと。モバイルでなければ上限は無い。 */
  private maxFileSize(): number | undefined {
    if (!Platform.isMobile) return undefined;
    return mobileMaxBytes(this.app.loadLocalStorage(LocalKeys.mobileMaxMb));
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
    const maxFileSize = this.maxFileSize();
    return {
      store: this.stateStore(),
      drive: new GoogleDriveBackend(
        this.driveClient(client),
        this.settings.driveRootFolder,
        this.app.vault.getName(),
      ),
      local: new VaultPort(adapter, md5OfBuffer),
      scan: (base) => scanVault(adapter, { isExcluded, base, hash: md5OfBuffer, maxFileSize }),
      now: () => Date.now(),
      deviceName: this.deviceName(),
      isExcluded,
      maxFileSize,
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

  private canSync(): boolean {
    return this.oauthClient() !== null && this.isLoggedIn();
  }

  private async sync(mode: SyncMode): Promise<void> {
    const auto = mode === "auto";
    // ログイン前の端末では、自動実行は何も言わずに待つ。
    if (auto && !this.canSync()) return;
    const dryRun = mode === "dry-run" || this.trialMode();

    this.setStatus({ kind: "syncing" });
    if (!auto) this.log.add(dryRun ? "試行を開始" : "同期を開始");
    try {
      const outcome = await this.engine.run({ dryRun, interactive: !auto });
      await this.report(outcome, auto);
    } catch (error) {
      this.setStatus({ kind: "error" });
      // 自動実行の失敗は通信断が多い。次の実行で直るので、画面に残さない。
      this.alert(`失敗: ${messageOf(error)}`, auto, !auto);
    }
  }

  /** 自動実行では、同じ内容を繰り返さない。手動なら毎回出す。 */
  private alert(text: string, auto: boolean, sticky: boolean): void {
    if (auto && this.lastAlert === text) return;
    this.lastAlert = text;
    this.log.add(text);
    new Notice(text, sticky ? 0 : undefined);
  }

  private logPlan(outcome: SyncOutcome, auto: boolean): void {
    const lines = [
      ...(outcome.duplicates ?? []).map((path) => `Drive に同じパスのファイルが複数あります: ${path}`),
      ...(outcome.plan?.actions ?? []).map((action) => `計画 ${action.type} ${action.path}`),
      ...(outcome.plan?.skipped ?? []).map((path) => `大きいので飛ばした ${path}`),
    ];
    const text = lines.join("\n");
    if (auto && text === this.lastPlanLog) return;
    this.lastPlanLog = text;
    for (const line of lines) this.log.add(line);
  }

  private setIdle(conflicts: number): void {
    this.setStatus({ kind: this.trialMode() ? "trial" : "idle", conflicts });
  }

  private async report(outcome: SyncOutcome, auto: boolean): Promise<void> {
    const { plan, safety, result, conflictCopies = 0 } = outcome;
    if (outcome.status === "busy") {
      if (!auto) new Notice("同期はすでに実行中です");
      return;
    }
    this.logPlan(outcome, auto);

    switch (outcome.status) {
      case "halted": {
        this.setStatus({ kind: "error" });
        const text = (safety?.reasons ?? []).map(reasonText).join("\n");
        this.alert(`同期を止めました。\n${text}`, auto, true);
        return;
      }
      case "needs-confirm": {
        this.setStatus({ kind: "waiting" });
        const text = (safety?.reasons ?? []).map(reasonText).join("\n");
        this.alert(`自動同期を止めました。\n${text}\n「同期を実行」で内容を確認してください。`, auto, true);
        return;
      }
      case "dry-run":
        this.lastAlert = null;
        this.setIdle(conflictCopies);
        if (auto) return;
        await showPreview(this.app, {
          title: "試行の結果（何も書き込んでいません）",
          plan: plan!,
          reasons: safety?.reasons ?? [],
          canRun: false,
        });
        return;
      case "cancelled":
        this.setIdle(conflictCopies);
        new Notice("同期を中止しました");
        return;
      case "done": {
        const failed = result?.failed ?? [];
        for (const { action, error } of failed) {
          this.log.add(`失敗 ${action.type} ${action.path}: ${messageOf(error)}`);
        }
        for (const action of result?.skipped ?? []) this.log.add(`飛ばした ${action.path}`);
        if (failed.length > 0) {
          this.setStatus({ kind: "error" });
          this.alert(`同期しました: ${summarize(plan!)}\n${failed.length} 件失敗しました`, auto, true);
          return;
        }
        this.lastAlert = null;
        this.setIdle(conflictCopies);
        // 自動実行は成功のたびに通知しない。競合だけは本人の作業が要るので知らせる。
        const hasConflict = plan!.actions.some((action) => action.type === "conflict");
        if (!auto || hasConflict) new Notice(`同期しました: ${summarize(plan!)}`);
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
      new Notice("モバイルでは、デスクトップで表示したトークンを貼り付けてください");
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

  /** デスクトップのログインを、モバイルへ渡す文字列にして見せる。 */
  showMobileToken(): void {
    const client = this.oauthClient();
    const tokens = this.tokenStore.load();
    if (!client || !tokens) {
      new Notice("先に Google にログインしてください");
      return;
    }
    new MobileTokenModal(
      this.app,
      encodeMobileToken({ ...client, refreshToken: tokens.refreshToken }),
    ).open();
  }

  /** 成功したら true。途中までの値を残さないよう、読み終えてから保存する。 */
  importMobileToken(text: string): boolean {
    try {
      const token = decodeMobileToken(text);
      this.app.saveLocalStorage(LocalKeys.clientId, token.clientId);
      this.app.saveLocalStorage(LocalKeys.clientSecret, token.clientSecret ?? null);
      this.tokenStore.save(toStoredTokens(token));
      new Notice("接続しました");
      return true;
    } catch (error) {
      new Notice(messageOf(error), 0);
      return false;
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
