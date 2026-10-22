[English](README.md) · [简体中文](README.zh-CN.md) · [日本語](README.ja.md) · [한국어](README.ko.md)

# Dori — Codex ランタイム

リードとすべての作業レーンを Codex app-server で実行します。Herdr のタブ、メッセンジャーのスレッド、進捗報告、5 分間の完了確認は維持します。OMO のインストールは不要です。

Codex CLI **0.163.0**, Bun 1.3+, Herdr, git, gh.

```sh
cd skills/dori-mode/scripts
bun install --frozen-lockfile
bun link
# Configure ~/.dori/config.json from references/config.example.json
dori doctor
dori serve
# Another terminal:
dori lead
```

既存設定を上書きせず、旧ワーカーを停止してから migrate を実行してください。進行中のレーンには停止確認と引き継ぎ文書が必要です。旧セッション ID は Codex thread ID に変換しません。実際のメッセンジャーには ACK 後にカーソルを進める ingress アダプターが必要です。

```sh
dori migrate --dry-run
dori migrate --apply --handoff-file /path/to/handoff.json
bun test
bun run typecheck
```

- [Complete runtime guide (English)](README.md)
- [Setup](skills/dori-mode/references/setup.md)
- [CLI / ingress / recovery](skills/dori-mode/references/scripts.md)
- [Sessions](skills/dori-mode/references/sessions.md)
- [Technical specification](docs/specs/codex-runtime-migration.md)

MIT.
