#!/usr/bin/env bash
# Installs the dori-mode skill and the `dori` CLI.
# Usage: curl -fsSL https://raw.githubusercontent.com/sisyphuslabs/omo-dori-mode-experimental/main/install.sh | bash
# Needs: git, bun 1.3+, Codex CLI 0.163.0, herdr. Optional env: DORI_SRC (clone dir), SKILLS_DIR (where your agent loads skills).
set -euo pipefail

repo="https://github.com/sisyphuslabs/omo-dori-mode-experimental.git"
src="${DORI_SRC:-$HOME/.dori/src}"
skills="${SKILLS_DIR:-$HOME/.agents/skills}"

command -v bun >/dev/null || { echo "bun is required: https://bun.sh" >&2; exit 1; }
command -v git >/dev/null || { echo "git is required" >&2; exit 1; }
command -v codex >/dev/null || { echo "Codex CLI 0.163.0 is required" >&2; exit 1; }
[ "$(codex --version)" = "codex-cli 0.163.0" ] || { echo "Codex CLI 0.163.0 is required; validate newer protocol versions before upgrading" >&2; exit 1; }
command -v herdr >/dev/null || { echo "herdr is required" >&2; exit 1; }

if [ -d "$src/.git" ]; then git -C "$src" pull --ff-only --quiet; else git clone --quiet --depth 1 "$repo" "$src"; fi

mkdir -p "$skills"
if [ -e "$skills/dori-mode" ] && [ ! -L "$skills/dori-mode" ]; then
  echo "$skills/dori-mode exists and is not a link; leaving it alone" >&2
else
  ln -sfn "$src/skills/dori-mode" "$skills/dori-mode"
fi

(cd "$src/skills/dori-mode/scripts" && bun install --frozen-lockfile --silent && bun link --silent)

mkdir -p "$HOME/.dori"
[ -f "$HOME/.dori/config.json" ] || cp "$src/skills/dori-mode/references/config.example.json" "$HOME/.dori/config.json"

echo "Installed. Skill: $skills/dori-mode  CLI: dori  Config: ~/.dori/config.json"
echo "Next: configure or migrate ~/.dori/config.json; run dori doctor, dori serve, then dori lead in another terminal"
