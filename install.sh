#!/bin/sh
# Installs or updates both mods in the Herdr app's home. Run it again after `git pull`.
# Keys: adds ⌘⇧N and ⌘⇧O to keys.json unless they're already bound to something else.
set -eu
here=$(cd "$(dirname "$0")" && pwd)
home=${HERDR_APP_HOME:-$HOME/.config/herdr-app}

for m in worktree-new worktrees; do
  mkdir -p "$home/mods/$m"
  cp -R "$here/mods/$m/." "$home/mods/$m/"
  herdr-app check "$home/mods/$m"
done

# keys.json holds every key, the defaults included, so it's only ever added to.
if [ ! -f "$home/keys.json" ]; then
  echo "No $home/keys.json yet: open Herdr once so it writes one, then run this again."
  exit 0
fi
if ! command -v node >/dev/null 2>&1; then
  echo "node not found: add the keys in keys.json to $home/keys.json by hand."
  exit 0
fi
node - "$home/keys.json" "$here/keys.json" <<'EOF'
const fs = require("fs");
const [file, wantedFile] = process.argv.slice(2);
const keys = JSON.parse(fs.readFileSync(file, "utf8"));
const wanted = JSON.parse(fs.readFileSync(wantedFile, "utf8")).global;
keys.global ??= {};
let changed = false;
for (const [key, command] of Object.entries(wanted)) {
  const now = keys.global[key];
  if (now === command) continue;
  if (now) { console.log(`${key} is already ${now}: left as it is. Bind ${command} to another key.`); continue; }
  keys.global[key] = command;
  changed = true;
  console.log(`${key} → ${command}`);
}
if (changed) fs.writeFileSync(file, JSON.stringify(keys, null, 2) + "\n");
EOF
