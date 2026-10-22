[English](README.md) · [简体中文](README.zh-CN.md) · [日本語](README.ja.md) · [한국어](README.ko.md)

# Dori — Codex 运行时

主代理和所有工作通道均通过 Codex app-server 运行。保留 Herdr 标签页、消息线程、进度报告和五分钟完成确认流程。不再需要安装 OMO。

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

不要覆盖已有配置。先停止旧工作进程，再运行 migrate。进行中的任务需要停止确认和交接文档；旧会话 ID 不会转换成 Codex thread ID。实际消息接入需要收到 ACK 后才推进游标的 ingress 适配器。

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

分配请求前，使用 `dori work similar --title "任务"` 查询历史。如果类似任务耗时达到 `workThresholdSec`（默认120秒），则委派给工作通道。小型直接任务用 `dori work start --title "任务"` / `dori work stop ID` 计时，并在最终报告中包含开始、结束时间和耗时秒数。复杂任务分成范围和完成条件明确的通道，整合后验证。Codex主代理使用MCP的 `work-similar`、`work-start` 和 `work-stop`。

MIT.
