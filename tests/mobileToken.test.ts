import { describe, expect, it } from "vitest";
import { qrMatrix } from "../src/ui/qr";
import {
  AuthSession,
  type OAuthClient,
  type StoredTokens,
  TOKEN_ENDPOINT,
} from "../src/auth/oauth";
import {
  type MobileToken,
  decodeMobileToken,
  encodeMobileToken,
  toStoredTokens,
} from "../src/auth/mobileToken";

const token: MobileToken = {
  clientId: "id.apps.example",
  clientSecret: "secret-value",
  refreshToken: "1//refresh-value_with-symbols",
};

const encodeRaw = (value: unknown) =>
  `gvs1:${btoa(JSON.stringify(value)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")}`;

describe("モバイル用トークン", () => {
  it("書き出したものを読み戻せる", () => {
    expect(decodeMobileToken(encodeMobileToken(token))).toEqual(token);
  });

  it("シークレットが無いクライアントも扱う", () => {
    const { clientId, refreshToken } = token;
    expect(decodeMobileToken(encodeMobileToken({ clientId, refreshToken }))).toEqual({
      clientId,
      refreshToken,
    });
  });

  it("貼り付けで混ざった空白と改行を無視する", () => {
    const text = encodeMobileToken(token);
    const pasted = `  ${text.slice(0, 20)}\n${text.slice(20, 40)} ${text.slice(40)}\n`;
    expect(decodeMobileToken(pasted)).toEqual(token);
  });

  it("URL やクエリに使えない文字を含まない", () => {
    expect(encodeMobileToken(token)).toMatch(/^gvs1:[A-Za-z0-9_-]+$/);
  });

  it.each([
    ["空", ""],
    ["関係のない文字列", "hello"],
    ["接頭辞が違う", encodeRaw(token).replace("gvs1", "gvs2")],
    ["本文が無い", "gvs1:"],
    ["base64 でない", "gvs1:***"],
    ["JSON でない", `gvs1:${btoa("not json")}`],
    ["JSON の配列", encodeRaw([token])],
    ["null", encodeRaw(null)],
    ["client ID が無い", encodeRaw({ refreshToken: "r" })],
    ["refresh token が無い", encodeRaw({ clientId: "c" })],
    ["client ID が空", encodeRaw({ clientId: "", refreshToken: "r" })],
    ["refresh token が文字列でない", encodeRaw({ clientId: "c", refreshToken: 1 })],
    ["シークレットが文字列でない", encodeRaw({ clientId: "c", refreshToken: "r", clientSecret: 1 })],
  ])("%s なら拒否する", (_, text) => {
    expect(() => decodeMobileToken(text)).toThrow("トークンの形式");
  });

  it("エラーに貼り付けた内容を載せない", () => {
    const text = encodeRaw({ clientId: "c", refreshToken: 1, clientSecret: "do-not-show" });
    try {
      decodeMobileToken(`${text}`);
      expect.unreachable();
    } catch (error) {
      expect(String(error)).not.toContain(text);
      expect(String(error)).not.toContain("do-not-show");
    }
  });

  it("アクセストークンは持たず、最初の通信で更新する", async () => {
    const stored = toStoredTokens(token);
    expect(stored).toEqual({ accessToken: "", refreshToken: token.refreshToken, expiresAt: 0 });

    let saved: StoredTokens = stored;
    const client: OAuthClient = { clientId: token.clientId, clientSecret: token.clientSecret };
    const urls: string[] = [];
    const session = new AuthSession(
      async (request) => {
        urls.push(request.url);
        return { status: 200, text: JSON.stringify({ access_token: "fresh", expires_in: 3600 }) };
      },
      client,
      { load: () => saved, save: (tokens) => void (saved = tokens) },
    );

    await expect(session.getAccessToken()).resolves.toBe("fresh");
    expect(urls).toEqual([TOKEN_ENDPOINT]);
    expect(saved.refreshToken).toBe(token.refreshToken);
  });
});

describe("QR コード", () => {
  it("正方形の行列を作り、白黒の両方を含む", () => {
    const matrix = qrMatrix(encodeMobileToken(token));
    expect(matrix.length).toBeGreaterThan(20);
    expect(matrix.every((row) => row.length === matrix.length)).toBe(true);
    expect(matrix.flat()).toContain(true);
    expect(matrix.flat()).toContain(false);
  });

  it("実際の長さのトークンも収まる", () => {
    const long = encodeMobileToken({
      clientId: `${"1".repeat(12)}-${"a".repeat(32)}.apps.googleusercontent.com`,
      clientSecret: `GOCSPX-${"b".repeat(28)}`,
      refreshToken: `1//${"c".repeat(100)}`,
    });
    expect(qrMatrix(long).length).toBeLessThan(100);
  });
});
