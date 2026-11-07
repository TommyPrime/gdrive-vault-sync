const MAX_ENTRIES = 500;

/** 直近のログをメモリにだけ持つ（設計書 4.8）。Vault には書かない。 */
export class SyncLog {
  private readonly entries: string[] = [];

  constructor(private readonly now: () => Date = () => new Date()) {}

  add(message: string): void {
    this.entries.push(`${this.now().toISOString()} ${message}`);
    if (this.entries.length > MAX_ENTRIES) this.entries.shift();
  }

  text(): string {
    return this.entries.join("\n");
  }
}
