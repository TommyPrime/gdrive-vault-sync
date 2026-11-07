// 往復の確認用に、中身が空の 2 台目の Vault を _test-vault-2/_test-vault/ に作る。
// Drive のフォルダは Vault 名で決まるので、同じ名前 _test-vault にする。
// プラグインは _test-vault の dev ビルドを写す。出力先は固定。本番の Vault を指す手段を持たせない。
import { copyFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const from = join("_test-vault", ".obsidian", "plugins", "gdrive-vault-sync");
const obsidian = join("_test-vault-2", "_test-vault", ".obsidian");
const to = join(obsidian, "plugins", "gdrive-vault-sync");

mkdirSync(to, { recursive: true });
for (const file of ["main.js", "manifest.json", "styles.css"]) {
  copyFileSync(join(from, file), join(to, file));
}
writeFileSync(join(obsidian, "community-plugins.json"), '["gdrive-vault-sync"]\n');
console.log(`作成しました: ${join("_test-vault-2", "_test-vault")}`);
