#!/bin/sh
set -eu

repo_root=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
agent_dir=${PI_CODING_AGENT_DIR:-"$HOME/.pi/agent"}
npm_prefix=${PI_NPM_PREFIX:-"$HOME/.local"}
stamp=$(date '+%Y%m%d-%H%M%S')
pi_version=$(sed -n '1p' "$repo_root/pi-version.txt")
pi_command="$npm_prefix/bin/pi"

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

settings_path="$agent_dir/settings.json"
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
    case "$(basename -- "$extension_path")" in
        ssh-direct|thinking-router|side-task|task-ledger) continue ;;
    esac
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

link_path "$repo_root/extensions/ssh-direct" "$extensions_dir/ssh-direct"
link_path "$repo_root/extensions/thinking-router" "$extensions_dir/thinking-router"
link_path "$repo_root/extensions/side-task" "$extensions_dir/side-task"
link_path "$repo_root/extensions/task-ledger" "$extensions_dir/task-ledger"
link_path "$repo_root/bin/pi-ledger" "$npm_prefix/bin/pi-ledger"
link_path "$repo_root/skills/incident-investigation" \
    "$agent_dir/skills/incident-investigation"
link_path "$repo_root/themes/protocol-ink.json" "$agent_dir/themes/protocol-ink.json"

mkdir -p "$agent_dir"
temporary_settings="$settings_path.pi-tools.$$"
node - "$settings_path" "$temporary_settings" <<'NODE'
const fs = require('node:fs');
const [settingsPath, temporaryPath] = process.argv.slice(2);
let settings = {};
if (fs.existsSync(settingsPath)) settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
settings.theme = 'protocol-ink';
settings.externalEditor = 'nvim';
delete settings.packages;
fs.writeFileSync(temporaryPath, `${JSON.stringify(settings, null, 2)}\n`, { mode: 0o600 });
NODE
mv "$temporary_settings" "$settings_path"
chmod 0600 "$settings_path"
printf 'merge   %s\n' "$settings_path"

printf '\nPi is calibrated with repository-owned tools and reasoning skills only.\n'
printf 'Authentication, sessions, models, and domain skills remain machine-local.\n'
