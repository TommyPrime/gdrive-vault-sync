/**
 * Vault 内のパスを appProperties に入れる。Drive の上限はキーと値の合計で 1 件 124 バイト
 * （UTF-8）なので、文字境界で p0、p1 に分ける（spec-questions Q1）。
 * 名前の変更は削除＋新規として扱うので、パスが変わるのは重複を競合コピーの名前へ移すときだけ。
 * 競合コピーの名前は元より長いので、キーは増えるだけで、古い pN が残ることはない。
 */
const MAX_PROPERTY_BYTES = 124;
/** アプリごとの上限 30 件から vaultId の 1 件を引く。 */
const MAX_PATH_PROPERTIES = 29;

const encoder = new TextEncoder();

const keyOf = (index: number) => `p${index}`;

export class PathTooLongError extends Error {
  constructor(path: string) {
    super(`パスが長すぎて Drive に保存できません: ${path}`);
    this.name = "PathTooLongError";
  }
}

export function encodePathProps(path: string): Record<string, string> {
  const props: Record<string, string> = {};
  let index = 0;
  let value = "";
  let bytes = 0;

  const flush = () => {
    if (index >= MAX_PATH_PROPERTIES) throw new PathTooLongError(path);
    props[keyOf(index)] = value;
    index += 1;
    value = "";
    bytes = 0;
  };

  // for...of はコードポイントごとに回るので、絵文字のサロゲートペアを割らない。
  for (const char of path) {
    const size = encoder.encode(char).byteLength;
    if (encoder.encode(keyOf(index)).byteLength + bytes + size > MAX_PROPERTY_BYTES) flush();
    value += char;
    bytes += size;
  }
  flush();
  return props;
}

/** 欠けていれば null。途中までのパスを本物として扱わない。 */
export function decodePathProps(props: Readonly<Record<string, string>>): string | null {
  let path = "";
  for (let index = 0; ; index += 1) {
    const value = props[keyOf(index)];
    if (value === undefined) break;
    path += value;
  }
  return path === "" ? null : path;
}
