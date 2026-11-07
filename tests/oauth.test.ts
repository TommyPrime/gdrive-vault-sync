import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  AUTH_ENDPOINT,
  AuthSession,
  DRIVE_SCOPE,
  InvalidGrantError,
  NotLoggedInError,
  OAuthError,
  type StoredTokens,
  type TokenStore,
  TOKEN_ENDPOINT,
  buildAuthUrl,
  exchangeCode,
  pkceChallenge,
  randomUrlSafe,
} from "../src/auth/oauth";
import type { HttpFn, HttpRequest } from "../src/http";

const json = (status: number, body: unknown) => ({ status, text: JSON.stringify(body) });

function memoryStore(initial: StoredTokens | null): TokenStore & { current: StoredTokens | null } {
  return {
    current: initial,
    load() {
      return this.current;
    },
    save(tokens) {
      this.current = tokens;
    },
  };
}

const bodyOf = (request: HttpRequest) => new URLSearchParams(request.body as string);

describe("PKCE", () => {
  it("S256 の challenge は RFC 7636 の付録 B の値と一致する", async () => {
    await expect(pkceChallenge("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk")).resolves.toBe(
      "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
    );
  });

  it("challenge は verifier の SHA-256 を base64url にしたもの", async () => {
    const verifier = randomUrlSafe();
    const expected = createHash("sha256").update(verifier).digest("base64url");
    await expect(pkceChallenge(verifier)).resolves.toBe(expected);
  });

  it("乱数は URL に安全な文字だけで、毎回変わる", () => {
    expect(randomUrlSafe()).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(randomUrlSafe()).not.toBe(randomUrlSafe());
  });
});

describe("buildAuthUrl", () => {
  const url = new URL(
    buildAuthUrl({
      clientId: "id",
      redirectUri: "http://127.0.0.1:1234",
      codeChallenge: "challenge",
      state: "state",
    }),
  );

  it("権限は drive.file だけを求める", () => {
    expect(url.origin + url.pathname).toBe(AUTH_ENDPOINT);
    expect(url.searchParams.get("scope")).toBe(DRIVE_SCOPE);
    expect(DRIVE_SCOPE).toBe("https://www.googleapis.com/auth/drive.file");
  });

  it("PKCE と refresh_token の取得を指定する", () => {
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("access_type")).toBe("offline");
    expect(url.searchParams.get("prompt")).toBe("consent");
  });
});

describe("exchangeCode", () => {
  const params = { code: "c", codeVerifier: "v", redirectUri: "http://127.0.0.1:1" };

  it("認可コードをトークンに換える", async () => {
    const http = vi.fn<HttpFn>(async () =>
      json(200, { access_token: "a", refresh_token: "r", expires_in: 3600 }),
    );
    const tokens = await exchangeCode(http, { clientId: "id" }, params, 1000);

    expect(tokens).toEqual({ accessToken: "a", refreshToken: "r", expiresAt: 3_601_000 });
    const request = http.mock.calls[0]![0];
    expect(request.url).toBe(TOKEN_ENDPOINT);
    expect(bodyOf(request).get("code_verifier")).toBe("v");
    expect(bodyOf(request).has("client_secret")).toBe(false);
  });

  it("client secret があれば送る", async () => {
    const http = vi.fn<HttpFn>(async () =>
      json(200, { access_token: "a", refresh_token: "r", expires_in: 1 }),
    );
    await exchangeCode(http, { clientId: "id", clientSecret: "s" }, params);
    expect(bodyOf(http.mock.calls[0]![0]).get("client_secret")).toBe("s");
  });

  it("refresh_token が返らなければ失敗にする", async () => {
    const http: HttpFn = async () => json(200, { access_token: "a", expires_in: 1 });
    await expect(exchangeCode(http, { clientId: "id" }, params)).rejects.toThrow(OAuthError);
  });

  it("Google の error_description を文言に含める", async () => {
    const http: HttpFn = async () =>
      json(400, { error: "invalid_request", error_description: "client_secret is missing." });
    await expect(exchangeCode(http, { clientId: "id" }, params)).rejects.toThrow(
      /client_secret is missing/,
    );
  });

  it("エラーの本文に秘密が含まれていても、例外の文言には出さない", async () => {
    const http: HttpFn = async () => json(400, { error: "invalid_request", detail: "secret-x" });
    await expect(exchangeCode(http, { clientId: "id" }, params)).rejects.not.toThrow(/secret-x/);
  });
});

describe("AuthSession", () => {
  const valid: StoredTokens = { accessToken: "old", refreshToken: "r", expiresAt: 1_000_000 };
  const renewed = () => json(200, { access_token: "new", expires_in: 3600 });

  it("ログインしていなければ止める", async () => {
    const session = new AuthSession(vi.fn<HttpFn>(), { clientId: "id" }, memoryStore(null));
    await expect(session.getAccessToken()).rejects.toThrow(NotLoggedInError);
  });

  it("期限内なら通信しない", async () => {
    const http = vi.fn<HttpFn>();
    const session = new AuthSession(http, { clientId: "id" }, memoryStore(valid), () => 0);
    await expect(session.getAccessToken()).resolves.toBe("old");
    expect(http).not.toHaveBeenCalled();
  });

  it("期限切れなら更新し、refresh_token は引き継いで保存する", async () => {
    const store = memoryStore(valid);
    const http = vi.fn<HttpFn>(async () => renewed());
    const session = new AuthSession(http, { clientId: "id" }, store, () => 2_000_000);

    await expect(session.getAccessToken()).resolves.toBe("new");
    expect(bodyOf(http.mock.calls[0]![0]).get("grant_type")).toBe("refresh_token");
    expect(store.current).toEqual({
      accessToken: "new",
      refreshToken: "r",
      expiresAt: 2_000_000 + 3_600_000,
    });
  });

  it("forceRefresh は期限内でも更新する", async () => {
    const http = vi.fn<HttpFn>(async () => renewed());
    const session = new AuthSession(http, { clientId: "id" }, memoryStore(valid), () => 0);
    await expect(session.getAccessToken({ forceRefresh: true })).resolves.toBe("new");
  });

  it("並列で呼ばれても更新の通信は 1 回にまとめる", async () => {
    const http = vi.fn<HttpFn>(async () => renewed());
    const session = new AuthSession(http, { clientId: "id" }, memoryStore(valid), () => 2_000_000);
    await Promise.all([1, 2, 3].map(() => session.getAccessToken()));
    expect(http).toHaveBeenCalledTimes(1);
  });

  it("invalid_grant は専用の例外にする", async () => {
    const http: HttpFn = async () => json(400, { error: "invalid_grant" });
    const session = new AuthSession(http, { clientId: "id" }, memoryStore(valid), () => 2_000_000);
    await expect(session.getAccessToken()).rejects.toThrow(InvalidGrantError);
  });
});
