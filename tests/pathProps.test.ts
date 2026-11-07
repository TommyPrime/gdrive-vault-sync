import { describe, expect, it } from "vitest";
import { PathTooLongError, decodePathProps, encodePathProps } from "../src/drive/pathProps";

const bytes = (text: string) => new TextEncoder().encode(text).byteLength;

describe("encodePathProps", () => {
  it.each([
    ["ascii", "a.md"],
    ["日本語", "日記/2026/11/今日のメモ.md"],
    ["絵文字", "絵文字📚のノート.md"],
    ["長い日本語", `${"長い名前のフォルダ/".repeat(12)}ノート.md`],
    ["絵文字だけの長いパス", "📚".repeat(100)],
  ])("%s のパスを元に戻せる", (_, path) => {
    expect(decodePathProps(encodePathProps(path))).toBe(path);
  });

  it("どの属性もキーと値の合計が 124 バイト以下", () => {
    const props = encodePathProps(`${"あ".repeat(50)}📚${"い".repeat(300)}.md`);
    expect(Object.keys(props).length).toBeGreaterThan(1);
    for (const [key, value] of Object.entries(props)) {
      expect(bytes(key) + bytes(value)).toBeLessThanOrEqual(124);
      expect(value).not.toContain("�");
    }
  });

  it("文字の途中で割らない", () => {
    const props = encodePathProps("📚".repeat(100));
    for (const value of Object.values(props)) {
      expect([...value].every((char) => char === "📚")).toBe(true);
    }
  });

  it("上限の 29 件に収まらないパスは失敗にする", () => {
    expect(() => encodePathProps("あ".repeat(1400))).toThrow(PathTooLongError);
  });
});

describe("decodePathProps", () => {
  it("パスの属性が無ければ null", () => {
    expect(decodePathProps({ vaultId: "v" })).toBeNull();
  });

  it("他の属性を混ぜない", () => {
    expect(decodePathProps({ vaultId: "v", p0: "a.md", p10: "x" })).toBe("a.md");
  });
});
