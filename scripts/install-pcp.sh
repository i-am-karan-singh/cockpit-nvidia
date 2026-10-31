#!/bin/sh
set -eu

if [ "$(id -u)" -ne 0 ]; then
    echo "Run as root: sudo ./scripts/install-pcp.sh" >&2
    exit 1
fi

repo_dir=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
pmda_dir=/var/lib/pcp/pmdas/nvidia
group_dir=/var/lib/pcp/config/pmlogconf/cockpit-nvidia
logger_config=/var/lib/pcp/config/pmlogger/config.default

if ! pminfo nvidia.numcards >/dev/null 2>&1; then
    (cd "$pmda_dir" && ./Install </dev/null)
fi

if ! pminfo -f nvidia.numcards 2>/dev/null | grep -q 'value'; then
    echo "NVIDIA PMDA is installed but reports no GPUs" >&2
    exit 1
fi

install -d -m 755 "$group_dir"
install -m 644 "$repo_dir/pcp/core" "$group_dir/core"

if [ ! -f "$logger_config" ]; then
    echo "PCP logger config is missing: $logger_config" >&2
    exit 1
fi

backup="${logger_config}.cockpit-nvidia-backup"
if [ ! -e "$backup" ]; then
    cp -p "$logger_config" "$backup"
fi
pmlogconf -c -r -q "$logger_config"
systemctl restart pmlogger.service

echo "NVIDIA PMDA active; GPU metrics added to PCP archive configuration."
echo "Previous logger configuration: $backup"
