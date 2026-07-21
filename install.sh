#!/bin/sh
set -eu

repo_root=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
agent_dir=${PI_CODING_AGENT_DIR:-"$HOME/.pi/agent"}
npm_prefix=${PI_NPM_PREFIX:-"$HOME/.local"}
stamp=$(date '+%Y%m%d-%H%M%S')
pi_version=$(sed -n '1p' "$repo_root/pi-version.txt")
pi_command="$npm_prefix/bin/pi"
profile=${PI_TOOLS_PROFILE:-core}

case $profile in
    core) enabled_extensions='appearance-sync ssh-direct' ;;
    rescue-experiment) enabled_extensions='appearance-sync ssh-direct senior-rescue' ;;
    ops) enabled_extensions='appearance-sync ssh-direct side-task task-ledger' ;;
    full) enabled_extensions='appearance-sync ssh-direct thinking-router context-sentinel side-task task-ledger' ;;
    *)
        printf 'error   unknown PI_TOOLS_PROFILE: %s (use core, rescue-experiment, ops, or full)\n' "$profile" >&2
        exit 2
        ;;
esac

extension_enabled() {
    case " $enabled_extensions " in
        *" $1 "*) return 0 ;;
        *) return 1 ;;
    esac
}

if ! command -v node >/dev/null 2>&1 || ! command -v npm >/dev/null 2>&1; then
    printf 'error   Node.js 22.19+ and npm are required\n' >&2
    exit 1
fi

if ! node -e '
const [major, minor] = process.versions.node.split(".").map(Number);
process.exit(major > 22 || (major === 22 && minor >= 19) ? 0 : 1);
'; then
    printf 'error   Node.js 22.19+ is required; found %s\n' "$(node --version)" >&2
    exit 1
fi

pi_manifest="$npm_prefix/lib/node_modules/@earendil-works/pi-coding-agent/package.json"
if [ -x "$pi_command" ] && node - "$pi_manifest" "$pi_version" <<'NODE'
const fs = require('node:fs');
const [path, expected] = process.argv.slice(2);
try {
  const manifest = JSON.parse(fs.readFileSync(path, 'utf8'));
  process.exit(
    manifest.name === '@earendil-works/pi-coding-agent'
      && manifest.version === expected ? 0 : 1
  );
} catch {
  process.exit(1);
}
NODE
then
    printf 'ok      @earendil-works/pi-coding-agent@%s\n' "$pi_version"
else
    mkdir -p "$npm_prefix"
    npm install --global --prefix "$npm_prefix" --ignore-scripts \
        "@earendil-works/pi-coding-agent@$pi_version"
fi

node "$repo_root/lib/patch-pi-inline-compaction.mjs" "$pi_manifest" "$pi_version"

settings_path="$agent_dir/settings.json"
models_path="$agent_dir/models.json"
if [ -f "$settings_path" ]; then
    node - "$settings_path" <<'NODE' | while IFS= read -r package_source; do
const fs = require('node:fs');
const settings = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
for (const source of settings.packages ?? []) {
  const value = typeof source === 'string' ? source : source?.source;
  if (value) process.stdout.write(`${value}\n`);
}
NODE
        [ -n "$package_source" ] || continue
        "$pi_command" remove "$package_source" --no-approve
    done
fi

extensions_dir="$agent_dir/extensions"
retired_dir="$agent_dir/retired-extensions/$stamp"
mkdir -p "$extensions_dir"
set +f
for extension_path in "$extensions_dir"/*; do
    [ -e "$extension_path" ] || [ -L "$extension_path" ] || continue
    extension_name=$(basename -- "$extension_path")
    [ "$extension_name" = study-learn-emit ] && continue
    extension_enabled "$extension_name" && continue
    mkdir -p "$retired_dir"
    mv "$extension_path" "$retired_dir/"
    printf 'retire  %s -> %s/\n' "$extension_path" "$retired_dir"
done
set -f

link_path() {
    source_path=$1
    target_path=$2
    mkdir -p "$(dirname -- "$target_path")"

    if [ -L "$target_path" ] && [ "$(readlink "$target_path")" = "$source_path" ]; then
        printf 'ok      %s\n' "$target_path"
        return
    fi
    if [ -e "$target_path" ] || [ -L "$target_path" ]; then
        backup_path="${target_path}.backup-${stamp}"
        mv "$target_path" "$backup_path"
        printf 'backup  %s -> %s\n' "$target_path" "$backup_path"
    fi
    ln -s "$source_path" "$target_path"
    printf 'link    %s -> %s\n' "$target_path" "$source_path"
}

for extension_name in $enabled_extensions; do
    link_path "$repo_root/extensions/$extension_name" "$extensions_dir/$extension_name"
done
if extension_enabled task-ledger; then
    link_path "$repo_root/bin/pi-ledger" "$npm_prefix/bin/pi-ledger"
fi
link_path "$repo_root/skills/incident-investigation" \
    "$agent_dir/skills/incident-investigation"
link_path "$repo_root/themes/protocol-ink.json" "$agent_dir/themes/protocol-ink.json"
link_path "$repo_root/themes/protocol-paper.json" "$agent_dir/themes/protocol-paper.json"

mkdir -p "$agent_dir"
temporary_settings="$settings_path.pi-tools.$$"
node - "$settings_path" "$temporary_settings" <<'NODE'
const fs = require('node:fs');
const [settingsPath, temporaryPath] = process.argv.slice(2);
let settings = {};
if (fs.existsSync(settingsPath)) settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
settings.theme = 'protocol-paper/protocol-ink';
settings.externalEditor = 'nvim';
settings.defaultProvider = 'openai-codex';
settings.defaultModel = 'gpt-5.6-luna';
settings.defaultThinkingLevel = 'low';
settings.compaction = {
  ...(settings.compaction && typeof settings.compaction === 'object'
    ? settings.compaction
    : {}),
  enabled: true,
  reserveTokens: 68000,
  keepRecentTokens: 20000,
};
delete settings.packages;
fs.writeFileSync(temporaryPath, `${JSON.stringify(settings, null, 2)}\n`, { mode: 0o600 });
NODE
mv "$temporary_settings" "$settings_path"
chmod 0600 "$settings_path"
printf 'merge   %s\n' "$settings_path"

temporary_models="$models_path.pi-tools.$$"
node - "$models_path" "$repo_root/config/models.json" "$temporary_models" <<'NODE'
const fs = require('node:fs');
const [modelsPath, fragmentPath, temporaryPath] = process.argv.slice(2);

const isObject = (value) =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

const merge = (base, overlay) => {
  const result = isObject(base) ? { ...base } : {};
  for (const [key, value] of Object.entries(overlay)) {
    result[key] = isObject(value) ? merge(result[key], value) : value;
  }
  return result;
};

let models = {};
if (fs.existsSync(modelsPath)) models = JSON.parse(fs.readFileSync(modelsPath, 'utf8'));
const fragment = JSON.parse(fs.readFileSync(fragmentPath, 'utf8'));
fs.writeFileSync(temporaryPath, `${JSON.stringify(merge(models, fragment), null, 2)}\n`, {
  mode: 0o600,
});
NODE
mv "$temporary_models" "$models_path"
chmod 0600 "$models_path"
printf 'merge   %s\n' "$models_path"

printf '\nPi profile: %s (%s)\n' "$profile" "$enabled_extensions"
printf 'Default model: openai-codex/gpt-5.6-luna · low\n'
printf 'Pi is calibrated with repository-owned tools and reasoning skills only.\n'
printf 'Authentication, sessions, custom models, and domain skills remain machine-local.\n'
