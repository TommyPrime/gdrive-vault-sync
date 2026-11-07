// テスト用 Vault をリポジトリ内の _test-vault/ に作る（設計書 第5章 段階0）。
// ダミーノート 200 件と画像・PDF。同じ内容を何度でも作れる。ファイルは消さない。
// 出力先は固定。本番の Vault を指す手段を持たせない。
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { deflateSync } from "node:zlib";

const ROOT = "_test-vault";
const NOTE_COUNT = 200;

function write(path, content) {
  const full = join(ROOT, path);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, content);
}

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let i = 0; i < 8; i++) crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const typed = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(typed));
  return Buffer.concat([length, typed, crc]);
}

/** 単色の PNG。番号ごとに色を変え、MD5 が揃わないようにする。 */
function png(seed, size = 64) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header[8] = 8; // ビット深度
  header[9] = 2; // RGB
  const rgb = [(seed * 67) % 256, (seed * 131) % 256, (seed * 199) % 256];
  const rows = [];
  for (let y = 0; y < size; y++) {
    rows.push(0);
    for (let x = 0; x < size; x++) rows.push(...rgb);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk("IHDR", header),
    pngChunk("IDAT", deflateSync(Buffer.from(rows))),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

/** 1 ページの最小の PDF。xref の位置は実測して埋める。 */
function pdf(title) {
  const stream = `BT /F1 18 Tf 72 720 Td (${title}) Tj ET`;
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R " +
      "/Resources << /Font << /F1 5 0 R >> >> >>",
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  let body = "%PDF-1.4\n";
  const offsets = objects.map((object, index) => {
    const offset = body.length;
    body += `${index + 1} 0 obj\n${object}\nendobj\n`;
    return offset;
  });
  const xref = body.length;
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) body += `${String(offset).padStart(10, "0")} 00000 n \n`;
  body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\n`;
  body += `startxref\n${xref}\n%%EOF\n`;
  return Buffer.from(body, "latin1");
}

const KINDS = [
  { folder: "Inbox", type: "knowledge", status: "inbox", label: "メモ" },
  { folder: "日記/2026", type: "journal", status: "done", label: "日記" },
  { folder: "タスク", type: "task", status: "active", label: "タスク" },
  { folder: "学習/TypeScript", type: "learning", status: "active", label: "学習ノート" },
  { folder: "読書", type: "book", status: "done", label: "読書メモ" },
  { folder: "知識", type: "knowledge", status: "archived", label: "知識" },
];

function note(index, title, kind) {
  const previous = index > 0 ? `\n前のノート: ${index - 1} 番\n` : "";
  return [
    "---",
    `type: ${kind.type}`,
    `status: ${kind.status}`,
    "tags: [dummy]",
    "created: 2026-11-05",
    "updated: 2026-11-05",
    "---",
    "",
    `# ${title}`,
    "",
    `これはテスト用のダミーノート ${index} 番です。実データではありません。`,
    previous,
    "- [ ] チェックボックス",
    `- 添付: ![[attachments/image-${(index % 10) + 1}.png]]`,
    "",
  ].join("\n");
}

// 通常のノート。末尾の特殊な名前のぶんを空けて、合計を NOTE_COUNT にする。
const SPECIAL = [
  ["スペース を 含む 名前.md", 0],
  ["絵文字📚のノート.md", 1],
  ["Inbox/濁点パカ゚ピ合成文字の確認.md", 2],
  [
    // 日本語 40 字を超えるパス。appProperties の 124 バイト上限に当たる（spec-questions Q1）。
    "知識/とても長いフォルダの名前を付けてパスの長さの上限を確かめるための階層/" +
      "さらに深い階層にある日本語のファイル名がどこまで扱えるかを実際に試すノート.md",
    3,
  ],
];

for (let i = SPECIAL.length; i < NOTE_COUNT; i++) {
  const kind = KINDS[i % KINDS.length];
  const title = `${kind.label} ${String(i).padStart(3, "0")}`;
  write(`${kind.folder}/${title}.md`, note(i, title, kind));
}
for (const [path, index] of SPECIAL) {
  const title = path.split("/").pop().replace(/\.md$/, "");
  write(path, note(index, title, KINDS[index % KINDS.length]));
}

for (let i = 1; i <= 10; i++) write(`attachments/image-${i}.png`, png(i));
for (let i = 1; i <= 3; i++) write(`attachments/document-${i}.pdf`, pdf(`Dummy PDF ${i}`));

write(".obsidian/community-plugins.json", '["gdrive-vault-sync"]\n');

// 分割アップロード（5MB 超）の確認用。内容は固定で、毎回同じ MD5 になる。
const large = Buffer.alloc(6 * 1024 * 1024);
for (let i = 0; i < large.length; i++) large[i] = (i * 31) % 251;
write("attachments/large-6mb.bin", large);

console.log(`${ROOT}/ に ノート ${NOTE_COUNT} 件、画像 10 件、PDF 3 件を作りました`);
