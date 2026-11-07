import tseslint from "typescript-eslint";

const nodeModules = ["fs", "http", "https", "net", "path", "os", "crypto", "child_process"];

export default tseslint.config(
  { ignores: ["node_modules/", "main.js", "_test-vault/", "_test-vault-2/", "reference/", "*.mjs", "scripts/"] },
  ...tseslint.configs.recommended,
  {
    files: ["src/**/*.ts"],
    rules: {
      // CLAUDE.md: HTTP はすべて requestUrl。fetch はモバイルで CORS に阻まれる。
      "no-restricted-globals": ["error", { name: "fetch", message: "requestUrl を使う" }],
      // CLAUDE.md: Node.js の API は desktopLoopback.ts 以外で使わない。
      "no-restricted-imports": [
        "error",
        { paths: nodeModules.flatMap((m) => [m, `node:${m}`]) },
      ],
    },
  },
  {
    // CLAUDE.md の唯一の例外。Platform.isDesktopApp の分岐の先で動的 import される。
    files: ["src/auth/desktopLoopback.ts"],
    rules: { "no-restricted-imports": "off" },
  },
);
