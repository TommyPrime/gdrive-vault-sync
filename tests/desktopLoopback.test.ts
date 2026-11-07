import { get } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { type LoopbackSession, startLoopback } from "../src/auth/desktopLoopback";

function visit(url: string): Promise<number> {
  return new Promise((resolve, reject) => {
    get(url, { agent: false }, (response) => {
      response.resume();
      response.on("end", () => resolve(response.statusCode ?? 0));
    }).on("error", reject);
  });
}

describe("startLoopback", () => {
  let session: LoopbackSession | undefined;
  afterEach(() => session?.close());

  it("127.0.0.1 の空きポートで待ち受ける", async () => {
    session = await startLoopback("s");
    expect(session.redirectUri).toMatch(/^http:\/\/127\.0\.0\.1:[1-9]\d*$/);
  });

  it("state が合えば認可コードを返す", async () => {
    session = await startLoopback("s");
    expect(await visit(`${session.redirectUri}/?state=s&code=abc`)).toBe(200);
    await expect(session.code).resolves.toBe("abc");
  });

  it("state が違う要求は拒否し、本物を待ち続ける", async () => {
    session = await startLoopback("s");
    expect(await visit(`${session.redirectUri}/?state=evil&code=bad`)).toBe(400);
    expect(await visit(`${session.redirectUri}/?state=s&code=good`)).toBe(200);
    await expect(session.code).resolves.toBe("good");
  });

  it("本人が拒否したらログインを失敗にする", async () => {
    session = await startLoopback("s");
    await visit(`${session.redirectUri}/?state=s&error=access_denied`);
    await expect(session.code).rejects.toThrow("access_denied");
  });

  it("タイムアウトしたら失敗にする", async () => {
    session = await startLoopback("s", { timeoutMs: 10 });
    await expect(session.code).rejects.toThrow("タイムアウト");
  });

  it("中止したら失敗にする", async () => {
    session = await startLoopback("s");
    session.close();
    await expect(session.code).rejects.toThrow("中止");
  });
});
