#!/usr/bin/env bash
# Installs the Iyen and dori-mode skills and the `dori` CLI.
# Usage: curl -fsSL https://raw.githubusercontent.com/sisyphuslabs/omo-dori-mode-experimental/main/install.sh | bash
# Needs: git, bun 1.3+, Codex CLI, herdr. Optional env: DORI_SRC (clone dir), SKILLS_DIR (skill links), IYEN_HOME or DORI_CONFIG (persistent installation).
set -euo pipefail

repo="https://github.com/sisyphuslabs/omo-dori-mode-experimental.git"
src="${DORI_SRC:-$HOME/.dori/src}"
skills="${SKILLS_DIR:-$HOME/.agents/skills}"

command -v bun >/dev/null || { echo "bun is required: https://bun.sh" >&2; exit 1; }
command -v git >/dev/null || { echo "git is required" >&2; exit 1; }
command -v codex >/dev/null || { echo "Codex CLI is required; activation validates the shared daemon and client" >&2; exit 1; }
command -v herdr >/dev/null || { echo "herdr is required" >&2; exit 1; }

if [ -d "$src/.git" ]; then git -C "$src" pull --ff-only --quiet; else git clone --quiet --depth 1 "$repo" "$src"; fi

mkdir -p "$skills"
for skill in dori-mode iyen; do
  if [ -e "$skills/$skill" ] && [ ! -L "$skills/$skill" ]; then
    echo "$skills/$skill exists and is not a link; leaving it alone" >&2
  else
    ln -sfn "$src/skills/$skill" "$skills/$skill"
  fi
done

(cd "$src/skills/dori-mode/scripts" && bun install --frozen-lockfile --silent && bun link --silent)

config="$(bun -e 'const { configPath } = await import(process.argv[1]); console.log(configPath())' "$src/skills/dori-mode/scripts/src/config.ts")"
mkdir -p "$(dirname "$config")"
if [ ! -f "$config" ]; then
  bun -e 'const [template, path] = process.argv.slice(1); const config = await Bun.file(template).json(); config.stateDir = `${(await import("node:path")).dirname(path)}/state`; await Bun.write(path, JSON.stringify(config, null, 2) + "\n")' "$src/skills/dori-mode/references/config.example.json" "$config"
fi

echo "Installed. Skills: $skills/iyen, $skills/dori-mode  CLI: dori  Config: $config"
echo "Next: configure or migrate $config; run dori doctor and dori serve with this installation, then ask for iyen mode in your current Codex conversation"
