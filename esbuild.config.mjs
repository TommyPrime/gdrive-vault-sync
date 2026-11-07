import { copyFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { builtinModules } from "node:module";
import { join } from "node:path";
import esbuild from "esbuild";

const production = process.argv[2] === "production";

// dev の出力先はリポジトリ内のテスト用 Vault に固定する。
// 本番の Vault のパスを、ここにも環境変数にも持たせない。
const devPluginDir = join("_test-vault", ".obsidian", "plugins", "gdrive-vault-sync");
const outdir = production ? "." : devPluginDir;

const copyStatic = {
  name: "copy-static",
  setup(build) {
    build.onEnd(() => {
      if (production) return;
      mkdirSync(outdir, { recursive: true });
      for (const file of ["manifest.json", "styles.css"]) {
        if (existsSync(file)) copyFileSync(file, join(outdir, file));
      }
    });
  },
};

// Obsidian の画面側では import("http") を解決できず、require だけが Node のモジュールを読める。
// supported で require に変換させ、変換漏れはここでビルドエラーにする。
const noNativeImport = {
  name: "no-native-import",
  setup(build) {
    build.onEnd((result) => {
      if (result.errors.length > 0) return;
      if (/\bimport\(/.test(readFileSync(join(outdir, "main.js"), "utf8"))) {
        return { errors: [{ text: "main.js に import() が残っています。Obsidian では動きません" }] };
      }
    });
  },
};

const context = await esbuild.context({
  entryPoints: ["src/main.ts"],
  bundle: true,
  supported: { "dynamic-import": false },
  outfile: join(outdir, "main.js"),
  format: "cjs",
  platform: "browser",
  target: "es2018",
  logLevel: "info",
  sourcemap: production ? false : "inline",
  treeShaking: true,
  minify: production,
  external: [
    "obsidian",
    "electron",
    "@codemirror/*",
    "@lezer/*",
    ...builtinModules,
    ...builtinModules.map((m) => `node:${m}`),
  ],
  plugins: [copyStatic, noNativeImport],
});

if (production) {
  await context.rebuild();
  await context.dispose();
} else {
  await context.watch();
}
