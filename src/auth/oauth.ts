import type { HttpFn } from "../http";

/** 設計書 4.2。これより広い権限は追加しない。 */
export const DRIVE_SCOPE = "https://www.googleapis.com/auth/drive.file";
export const AUTH_ENDPOINT = "https://accounts.google.com/o/oauth2/v2/auth";
export const TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";

/** 期限ぎりぎりのトークンを使わないための余裕。 */
const EXPIRY_MARGIN_MS = 60_000;

export interface OAuthClient {
  clientId: string;
  /** 省略可。docs/spec-questions.md Q2 を参照。 */
  clientSecret?: string;
}

export interface StoredTokens {
  accessToken: string;
  refreshToken: string;
  /** アクセストークンの失効時刻（epoch ミリ秒）。 */
  expiresAt: number;
}

/** 端末内の保存先。本番は app.saveLocalStorage。Vault には書かない。 */
export interface TokenStore {
  load(): StoredTokens | null;
  save(tokens: StoredTokens): void;
}

/** ログインしていない。 */
export class NotLoggedInError extends Error {
  constructor() {
    super("Google にログインしていません");
    this.name = "NotLoggedInError";
  }
}

/** refresh_token が失効した。同期を止めて再ログインを促す（設計書 4.9）。 */
export class InvalidGrantError extends Error {
  constructor() {
    super("Google のログインが失効しました。再ログインしてください");
    this.name = "InvalidGrantError";
  }
}

export class OAuthError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    description?: string,
  ) {
    super(`Google の認証に失敗しました（${status} ${code}${description ? `: ${description}` : ""}）`);
    this.name = "OAuthError";
  }
}

function base64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function randomUrlSafe(byteLength = 32): string {
  return base64Url(crypto.getRandomValues(new Uint8Array(byteLength)));
}

export async function pkceChallenge(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return base64Url(new Uint8Array(digest));
}

export function buildAuthUrl(params: {
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  state: string;
}): string {
  const query = new URLSearchParams({
    client_id: params.clientId,
    redirect_uri: params.redirectUri,
    response_type: "code",
    scope: DRIVE_SCOPE,
    code_challenge: params.codeChallenge,
    code_challenge_method: "S256",
    state: params.state,
    // refresh_token を確実に受け取る。
    access_type: "offline",
    prompt: "consent",
  });
  return `${AUTH_ENDPOINT}?${query.toString()}`;
}

interface TokenResponse {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  error?: string;
  error_description?: string;
}

async function postToken(
  http: HttpFn,
  client: OAuthClient,
  fields: Record<string, string>,
): Promise<TokenResponse> {
  const form = new URLSearchParams({ client_id: client.clientId, ...fields });
  if (client.clientSecret) form.set("client_secret", client.clientSecret);

  const response = await http({
    url: TOKEN_ENDPOINT,
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: form.toString(),
  });

  let parsed: TokenResponse = {};
  try {
    parsed = JSON.parse(response.text) as TokenResponse;
  } catch {
    // 本文が JSON でなければ status だけで判断する。
  }

  if (response.status >= 400 || parsed.error) {
    if (parsed.error === "invalid_grant") throw new InvalidGrantError();
    throw new OAuthError(response.status, parsed.error ?? "unknown", parsed.error_description);
  }
  return parsed;
}

export async function exchangeCode(
  http: HttpFn,
  client: OAuthClient,
  params: { code: string; codeVerifier: string; redirectUri: string },
  now: number = Date.now(),
): Promise<StoredTokens> {
  const body = await postToken(http, client, {
    grant_type: "authorization_code",
    code: params.code,
    code_verifier: params.codeVerifier,
    redirect_uri: params.redirectUri,
  });
  if (!body.access_token || !body.refresh_token) {
    throw new OAuthError(200, "missing_token");
  }
  return {
    accessToken: body.access_token,
    refreshToken: body.refresh_token,
    expiresAt: now + (body.expires_in ?? 0) * 1000,
  };
}

async function refreshTokens(
  http: HttpFn,
  client: OAuthClient,
  current: StoredTokens,
  now: number,
): Promise<StoredTokens> {
  const body = await postToken(http, client, {
    grant_type: "refresh_token",
    refresh_token: current.refreshToken,
  });
  if (!body.access_token) throw new OAuthError(200, "missing_token");
  return {
    accessToken: body.access_token,
    refreshToken: body.refresh_token ?? current.refreshToken,
    expiresAt: now + (body.expires_in ?? 0) * 1000,
  };
}

/** アクセストークンを配る。並列の同期でも更新の通信は 1 回にまとめる。 */
export class AuthSession {
  private refreshing: Promise<StoredTokens> | null = null;

  constructor(
    private readonly http: HttpFn,
    private readonly client: OAuthClient,
    private readonly store: TokenStore,
    private readonly now: () => number = Date.now,
  ) {}

  async getAccessToken(options: { forceRefresh?: boolean } = {}): Promise<string> {
    const tokens = this.store.load();
    if (!tokens) throw new NotLoggedInError();

    const fresh = tokens.expiresAt - EXPIRY_MARGIN_MS > this.now();
    if (fresh && !options.forceRefresh) return tokens.accessToken;

    this.refreshing ??= refreshTokens(this.http, this.client, tokens, this.now())
      .then((updated) => {
        this.store.save(updated);
        return updated;
      })
      .finally(() => {
        this.refreshing = null;
      });
    return (await this.refreshing).accessToken;
  }
}
