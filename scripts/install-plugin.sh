#!/bin/sh
set -eu

repo_dir=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
target=/usr/local/share/cockpit/cockpit-nvidia

if [ "$(id -u)" -ne 0 ]; then
    echo "Run as root after npm run build: sudo ./scripts/install-plugin.sh" >&2
    exit 1
fi

if [ ! -f "$repo_dir/dist/manifest.json" ]; then
    echo "Build the plugin first: npm run build" >&2
    exit 1
fi

if [ -L "$target" ]; then
    echo "Refusing to replace symlink: $target" >&2
    exit 1
fi
if [ -e "$target" ]; then
    rm -r -- "$target"
fi
install -d -m 755 "$target"
cp -a "$repo_dir/dist/." "$target/"
echo "Installed Cockpit GPU page at $target"
