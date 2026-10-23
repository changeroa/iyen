[English](README.md) · [简体中文](README.zh-CN.md) · [日本語](README.ja.md) · [한국어](README.ko.md)

# Dori — Codex ランタイム

Iyen モードは現在の Codex 会話をリードとして接続します。「이연 모드 시작」で開始し、別のリードは起動しません。独立した Codex セッションは委任するワーカーだけに使用します。

Bun 1.3+, Herdr, git, gh と Codex CLI が必要です。接続するリードは CLI とデーモンが同じ **0.163.0** または **0.164.0** をサポートします。管理ワーカーは設定された固定バージョン（既定 **0.163.0**）を使用します。

```sh
cd skills/dori-mode/scripts
bun install --frozen-lockfile
bun link
# Configure ~/.dori-codex/config.json from references/config.example.json
export DORI_CONFIG="$HOME/.dori-codex/config.json"
dori doctor
dori serve
# In the existing Codex session:
python3 /path/to/iyen/skills/iyen/scripts/activate.py start --session UUID --pane PANE
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

依頼の振り分け前に `dori work similar --title "作業"` で履歴を確認し、類似作業が `workThresholdSec`（既定120秒）以上ならレーンへ委任します。小さな直接作業は `dori work start --title "作業"` / `dori work stop ID` で計測し、最終報告に開始・終了時刻と所要秒数を含めます。複雑な作業は範囲と完了条件を明示したレーンへ分割し、統合後に検証します。リードは起動時に返される専用 bridge の `work similar`、`work start`、`work stop` を使います。

MIT.
