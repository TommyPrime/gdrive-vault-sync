/**
 * 127.0.0.1 の空きポートで OAuth のリダイレクトを受ける（設計書 4.2）。
 * Node.js の API を使ってよい唯一のファイル。main.ts が Platform.isDesktopApp を
 * 確認してから動的 import する。モバイルでは読み込まれない。
 */
import type { AddressInfo } from "net";

const DONE_PAGE =
  "<!doctype html><meta charset=utf-8><title>GDrive Vault Sync</title>" +
  "<p>ログインが完了しました。このタブを閉じて Obsidian に戻ってください。</p>";
const FAILED_PAGE =
  "<!doctype html><meta charset=utf-8><title>GDrive Vault Sync</title>" +
  "<p>ログインできませんでした。Obsidian に戻ってやり直してください。</p>";

const LOGIN_TIMEOUT_MS = 5 * 60_000;

export interface LoopbackSession {
  redirectUri: string;
  /** 認可コード。拒否・タイムアウト・中止では reject する。 */
  code: Promise<string>;
  close(): void;
}

export async function startLoopback(
  expectedState: string,
  options: { timeoutMs?: number } = {},
): Promise<LoopbackSession> {
  const http = await import("http");

  let resolveCode!: (code: string) => void;
  let rejectCode!: (reason: Error) => void;
  const code = new Promise<string>((resolve, reject) => {
    resolveCode = resolve;
    rejectCode = reject;
  });
  // 呼び出し側が await する前に reject されても未処理にしない。
  code.catch(() => undefined);

  const server = http.createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    const reply = (status: number, html: string) => {
      response.writeHead(status, { "Content-Type": "text/html; charset=utf-8" });
      response.end(html);
    };

    if (url.pathname !== "/") return reply(404, "");

    // state が違う要求は別のプロセスから届いたものとして無視し、本物を待ち続ける。
    if (url.searchParams.get("state") !== expectedState) return reply(400, FAILED_PAGE);

    const error = url.searchParams.get("error");
    if (error) {
      reply(400, FAILED_PAGE);
      return rejectCode(new Error(`Google のログインが拒否されました（${error}）`));
    }

    const received = url.searchParams.get("code");
    if (!received) return reply(400, FAILED_PAGE);
    reply(200, DONE_PAGE);
    resolveCode(received);
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    // ポート 0 で空きポートを取る。0.0.0.0 では待ち受けない。
    server.listen(0, "127.0.0.1", resolve);
  });

  const timer = setTimeout(() => {
    rejectCode(new Error("ログインがタイムアウトしました"));
    server.close();
  }, options.timeoutMs ?? LOGIN_TIMEOUT_MS);

  const close = () => {
    clearTimeout(timer);
    rejectCode(new Error("ログインを中止しました"));
    server.close();
    server.closeAllConnections();
  };
  void code.finally(close).catch(() => undefined);

  const { port } = server.address() as AddressInfo;
  return { redirectUri: `http://127.0.0.1:${port}`, code, close };
}
