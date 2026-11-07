/**
 * デスクトップのログインをモバイルへ渡す（設計書 4.2）。モバイルは loopback で待ち受けられない。
 * base64 は暗号化ではない。文字列を見た人は Drive に接続できるので、Vault とログに書かない。
 */
import type { StoredTokens } from "./oauth";

const PREFIX = "gvs1:";

export interface MobileToken {
  clientId: string;
  clientSecret?: string;
  refreshToken: string;
}

export class MobileTokenError extends Error {
  constructor() {
    // 貼り付けた内容は秘密なので、メッセージに載せない。
    super("トークンの形式が正しくありません。もう一度コピーしてください。");
  }
}

function toBase64Url(text: string): string {
  const binary = String.fromCharCode(...new TextEncoder().encode(text));
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromBase64Url(text: string): string {
  const binary = atob(text.replace(/-/g, "+").replace(/_/g, "/"));
  return new TextDecoder().decode(Uint8Array.from(binary, (char) => char.charCodeAt(0)));
}

export function encodeMobileToken(token: MobileToken): string {
  return `${PREFIX}${toBase64Url(JSON.stringify(token))}`;
}

const nonEmpty = (value: unknown): value is string => typeof value === "string" && value !== "";

/** 途中までの値を保存しないよう、すべて揃っていなければ例外にする。 */
export function decodeMobileToken(text: string): MobileToken {
  const compact = text.replace(/\s+/g, "");
  if (!compact.startsWith(PREFIX)) throw new MobileTokenError();

  let parsed: unknown;
  try {
    parsed = JSON.parse(fromBase64Url(compact.slice(PREFIX.length)));
  } catch {
    throw new MobileTokenError();
  }
  if (typeof parsed !== "object" || parsed === null) throw new MobileTokenError();

  const { clientId, clientSecret, refreshToken } = parsed as Record<string, unknown>;
  if (!nonEmpty(clientId) || !nonEmpty(refreshToken)) throw new MobileTokenError();
  if (clientSecret === undefined) return { clientId, refreshToken };
  if (!nonEmpty(clientSecret)) throw new MobileTokenError();
  return { clientId, clientSecret, refreshToken };
}

/** アクセストークンは渡さない。期限切れとして保存し、最初の通信で更新する。 */
export function toStoredTokens(token: MobileToken): StoredTokens {
  return { accessToken: "", refreshToken: token.refreshToken, expiresAt: 0 };
}
