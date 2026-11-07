import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AutoSync, intervalMs } from "../src/sync/scheduler";

describe("intervalMs", () => {
  it("秒をミリ秒にする", () => {
    expect(intervalMs(60)).toBe(60_000);
  });

  it("0 は自動同期を止める", () => {
    expect(intervalMs(0)).toBe(0);
  });

  it("短すぎる値は 10 秒に切り上げる", () => {
    expect(intervalMs(1)).toBe(10_000);
  });

  it.each([Number.NaN, -1, Number.POSITIVE_INFINITY])("壊れた値 %s は既定の 60 秒", (value) => {
    expect(intervalMs(value)).toBe(60_000);
  });
});

describe("AutoSync", () => {
  let run: ReturnType<typeof vi.fn<(trigger: string) => void>>;
  let period: number;
  let auto: AutoSync;

  beforeEach(() => {
    vi.useFakeTimers();
    run = vi.fn();
    period = 60_000;
    auto = new AutoSync({ run, intervalMs: () => period });
  });

  afterEach(() => {
    auto.stop();
    vi.useRealTimers();
  });

  it("開始すると 1 回実行する", () => {
    auto.start();
    expect(run).toHaveBeenCalledExactlyOnceWith("startup");
  });

  it("間隔ごとに実行する", () => {
    auto.start();
    run.mockClear();
    vi.advanceTimersByTime(179_999);
    expect(run).toHaveBeenCalledTimes(2);
    vi.advanceTimersByTime(1);
    expect(run).toHaveBeenCalledTimes(3);
  });

  it("保存は最後の変更から 10 秒待つ", () => {
    period = 1_000_000;
    auto.start();
    run.mockClear();

    auto.changed();
    vi.advanceTimersByTime(9_000);
    auto.changed();
    vi.advanceTimersByTime(9_999);
    expect(run).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(run).toHaveBeenCalledExactlyOnceWith("change");
  });

  it("前面に戻ったら実行する", () => {
    auto.start();
    run.mockClear();
    auto.resumed();
    expect(run).toHaveBeenCalledExactlyOnceWith("resume");
  });

  it("間隔が 0 なら何の契機でも実行しない", () => {
    period = 0;
    auto.start();
    auto.changed();
    auto.resumed();
    vi.advanceTimersByTime(600_000);
    expect(run).not.toHaveBeenCalled();
  });

  it("間隔の変更は restart で効く", () => {
    auto.start();
    run.mockClear();
    period = 10_000;
    auto.restart();
    vi.advanceTimersByTime(10_000);
    expect(run).toHaveBeenCalledExactlyOnceWith("interval");
  });

  it("間隔を 0 にすると、待っている実行も取り消す", () => {
    auto.start();
    auto.changed();
    run.mockClear();
    period = 0;
    auto.restart();
    vi.advanceTimersByTime(600_000);
    expect(run).not.toHaveBeenCalled();
  });

  it("止めた後は実行しない", () => {
    auto.start();
    auto.changed();
    run.mockClear();
    auto.stop();
    auto.changed();
    auto.resumed();
    vi.advanceTimersByTime(600_000);
    expect(run).not.toHaveBeenCalled();
  });

  it("開始前の変更は無視する", () => {
    auto.changed();
    auto.resumed();
    vi.advanceTimersByTime(600_000);
    expect(run).not.toHaveBeenCalled();
  });
});
