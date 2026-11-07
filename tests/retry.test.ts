import { describe, expect, it, vi } from "vitest";
import { withRetry } from "../src/drive/retry";

const options = () => ({
  isRetryable: (error: unknown) => error === "retry",
  sleep: vi.fn<(ms: number) => Promise<void>>(async () => undefined),
  random: () => 0,
});

describe("withRetry", () => {
  it("成功するまで間隔を延ばす", async () => {
    const opts = options();
    let calls = 0;
    const result = await withRetry(async () => {
      calls += 1;
      if (calls < 4) throw "retry";
      return "ok";
    }, opts);

    expect(result).toBe("ok");
    expect(opts.sleep.mock.calls.map(([ms]) => ms)).toEqual([1000, 2000, 4000]);
  });

  it("再試行は最大 5 回", async () => {
    const opts = options();
    const run = vi.fn(async () => {
      throw "retry";
    });
    await expect(withRetry(run, opts)).rejects.toBe("retry");
    expect(run).toHaveBeenCalledTimes(6);
  });

  it("再試行しない失敗はすぐに投げる", async () => {
    const opts = options();
    const run = vi.fn(async () => {
      throw "fatal";
    });
    await expect(withRetry(run, opts)).rejects.toBe("fatal");
    expect(run).toHaveBeenCalledTimes(1);
  });
});
