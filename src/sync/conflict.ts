const two = (value: number) => String(value).padStart(2, "0");

function stamp(when: Date): string {
  const date = `${when.getFullYear()}-${two(when.getMonth() + 1)}-${two(when.getDate())}`;
  return `${date} ${two(when.getHours())}${two(when.getMinutes())}`;
}

function safeDeviceName(deviceName: string): string {
  const replaced = deviceName.replace(/[/\\:*?"<>|\u0000-\u001f]/g, "-").trim();
  return replaced || "device";
}

const CONFLICT_COPY = / \(conflict \d{4}-\d{2}-\d{2} \d{4} [^/]+\)(\.[^/]*)?$/;

export function isConflictCopy(path: string): boolean {
  return CONFLICT_COPY.test(path);
}

/**
 * 競合コピーの名前を作る。`名前 (conflict YYYY-MM-DD HHmm 端末名).拡張子`
 * 同じ分に同じファイルが 2 度競合しても上書きしないよう、使用済みなら末尾に番号を足す。
 */
export function conflictPath(
  path: string,
  when: Date,
  deviceName: string,
  isTaken: (candidate: string) => boolean = () => false,
): string {
  const slash = path.lastIndexOf("/");
  const directory = path.slice(0, slash + 1);
  const name = path.slice(slash + 1);
  const dot = name.lastIndexOf(".");
  const stem = dot > 0 ? name.slice(0, dot) : name;
  const extension = dot > 0 ? name.slice(dot) : "";

  const label = `conflict ${stamp(when)} ${safeDeviceName(deviceName)}`;
  const candidate = (suffix: string) => `${directory}${stem} (${label}${suffix})${extension}`;

  let result = candidate("");
  for (let n = 2; isTaken(result); n += 1) result = candidate(` ${n}`);
  return result;
}
