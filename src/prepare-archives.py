"""Build a read-only view of recent PCP archives that contain NVIDIA metrics.

Cockpit's archive channel checks every archive in a directory. Older host
archives predate the NVIDIA PMDA and cause the entire query to fail, so this
helper makes a per-user view containing only compatible archives.
"""

import os
import subprocess
import time
from pathlib import Path

from pcp import pmapi

log_dir = Path(pmapi.pmContext.pmGetConfig("PCP_LOG_DIR"))
source = log_dir / "pmlogger" / os.uname().nodename
view = Path('/var/tmp') / f"cockpit-nvidia-archives-{os.getuid()}"
view.mkdir(mode=0o700, exist_ok=True)
if view.stat().st_uid != os.getuid():
    raise RuntimeError("Archive view is owned by another user")
view.chmod(0o700)

wanted = set()
cutoff = time.time() - 9 * 86400
for index in sorted(source.glob("*.index")):
    if index.stat().st_mtime < cutoff:
        continue
    prefix = index.with_suffix("")
    result = subprocess.run(
        ["pminfo", "-a", str(prefix), "nvidia.gpuactive", "nvidia.memused",
         "nvidia.memtotal", "nvidia.temperature", "nvidia.power"],
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        timeout=10,
        check=False,
    )
    if result.returncode:
        continue
    files = list(source.glob(prefix.name + ".*"))
    compressed = any(original.suffix in {'.xz', '.zst', '.gz'} for original in files)
    for original in files:
        link = view / original.name
        wanted.add(link.name)
        if compressed:
            if link.is_file() and not link.is_symlink() and link.stat().st_size == original.stat().st_size and link.stat().st_mtime_ns == original.stat().st_mtime_ns:
                continue
            if link.exists() or link.is_symlink():
                link.unlink()
            # PCP cannot reliably open compressed archive volumes through symlinks.
            # A reflink on the same Btrfs filesystem avoids duplicating their data.
            subprocess.run(['cp', '--reflink=auto', '--preserve=timestamps', '--', str(original), str(link)], check=True)
            continue
        if link.is_symlink() and link.resolve() == original:
            continue
        if link.exists() or link.is_symlink():
            link.unlink()
        link.symlink_to(original)

for link in view.iterdir():
    if link.name not in wanted:
        link.unlink()

print(view)
