# GDrive Vault Sync

Obsidian の Vault を自分の Google Drive と双方向同期する個人用プラグイン。
macOS / Windows / iPadOS / Android の 4 台で 1 つの Vault を使う。

- 正の仕様: 「Obsidian マルチデバイス構成 設計書」第 4 章
- 開発の決まり: [CLAUDE.md](CLAUDE.md)
- 段階 0 の本人作業: [docs/setup.md](docs/setup.md)
- 仕様の確認事項: [docs/spec-questions.md](docs/spec-questions.md)

**現在は段階 0。同期はまだ実装していない。** できるのは Google へのログインと、Drive のフォルダ作成だけ。
本番の Vault に入れないこと。

```bash
npm install
npm test
npm run lint
```
