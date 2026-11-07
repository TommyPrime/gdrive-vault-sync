/** 自動同期の契機（設計書 4.8）。手動の実行はここを通らない。 */
export type SyncTrigger = "startup" | "interval" | "change" | "resume";

export const DEFAULT_INTERVAL_SEC = 60;
/** 保存が続く間は待ち、最後の変更からこの時間で実行する。 */
export const QUIET_MS = 10_000;
const MIN_INTERVAL_MS = 10_000;

/** 0 は自動同期を止める。壊れた値で Drive を叩き続けないよう、短すぎる値は切り上げる。 */
export function intervalMs(seconds: number): number {
  if (!Number.isFinite(seconds) || seconds < 0) return DEFAULT_INTERVAL_SEC * 1000;
  return seconds === 0 ? 0 : Math.max(seconds * 1000, MIN_INTERVAL_MS);
}

export interface AutoSyncOptions {
  run(trigger: SyncTrigger): void;
  /** 0 なら自動同期を止める。 */
  intervalMs(): number;
}

/** いつ同期するかだけを決める。重なった実行は SyncEngine のロックが止める。 */
export class AutoSync {
  private started = false;
  private ticking: ReturnType<typeof setInterval> | undefined;
  private quiet: ReturnType<typeof setTimeout> | undefined;

  constructor(private readonly options: AutoSyncOptions) {}

  private get active(): boolean {
    return this.started && this.options.intervalMs() > 0;
  }

  start(): void {
    this.started = true;
    if (this.active) this.options.run("startup");
    this.arm();
  }

  /** 間隔の設定を変えたときに呼ぶ。 */
  restart(): void {
    this.clear();
    this.arm();
  }

  stop(): void {
    this.started = false;
    this.clear();
  }

  changed(): void {
    if (!this.active) return;
    clearTimeout(this.quiet);
    this.quiet = setTimeout(() => this.options.run("change"), QUIET_MS);
  }

  resumed(): void {
    if (this.active) this.options.run("resume");
  }

  private arm(): void {
    if (!this.active) return;
    this.ticking = setInterval(() => this.options.run("interval"), this.options.intervalMs());
  }

  private clear(): void {
    clearInterval(this.ticking);
    clearTimeout(this.quiet);
  }
}
