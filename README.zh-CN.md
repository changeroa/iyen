[English](README.md) · [简体中文](README.zh-CN.md) · [日本語](README.ja.md) · [한국어](README.ko.md)

# Iyen — Codex 与 OMP 运行时

Iyen 是管理消息与任务通道的上层系统。Codex 和 OMP 是同一仓库中的运行时组件，分别位于 `src/runtime/codex/` 和 `src/runtime/omp/`，通过 `runtime.kind` 选择。共享服务位于 `src/`，技能位于 `skills/`。将已验证的当前会话连接为主代理，不创建另一个主代理。

需要 Bun 1.3+、Herdr、git 和选定的运行时。Codex 连接主代理验证 CLI 与守护进程的兼容性，托管工作进程验证配置的版本。OMP 使用配置的二进制、扩展及隔离配置。详见[设置指南](skills/dori-mode/references/setup.md)。

```sh
cd /path/to/iyen
bun install --frozen-lockfile
bun link
# Configure ~/.dori-codex/config.json from skills/dori-mode/references/config.example.json
export DORI_CONFIG="$HOME/.dori-codex/config.json"
dori doctor
dori serve
# In the existing Codex session:
python3 /path/to/iyen/skills/iyen/scripts/activate.py start --session UUID --pane PANE
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

分配请求前，使用 `dori work similar --title "任务"` 查询历史。如果类似任务耗时达到 `workThresholdSec`（默认120秒），则委派给工作通道。小型直接任务用 `dori work start --title "任务"` / `dori work stop ID` 计时，并在最终报告中包含开始、结束时间和耗时秒数。复杂任务分成范围和完成条件明确的通道，整合后验证。主代理使用启动时返回的专用 bridge 的 `work similar`、`work start` 和 `work stop`。

MIT.
