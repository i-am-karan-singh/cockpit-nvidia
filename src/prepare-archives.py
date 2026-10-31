"""Build a read-only view of PCP archives that contain NVIDIA metrics.

Cockpit's archive channel checks every archive in a directory. Older host
archives predate the NVIDIA PMDA and cause the entire query to fail, so this
helper makes a per-user view containing only compatible archives.
"""

import json
import os
import subprocess
import tempfile
from pathlib import Path

from pcp import pmapi

log_dir = Path(pmapi.pmContext.pmGetConfig("PCP_LOG_DIR"))
source = log_dir / "pmlogger" / os.uname().nodename
view = Path('/var/tmp') / f"cockpit-nvidia-archives-{os.getuid()}"
view.mkdir(mode=0o700, exist_ok=True)
if view.stat().st_uid != os.getuid():
    raise RuntimeError("Archive view is owned by another user")
view.chmod(0o700)

metrics = ("nvidia.gpuactive", "nvidia.memused", "nvidia.memtotal",
           "nvidia.temperature", "nvidia.power")
cache_file = view / ".compatibility.json"
try:
    saved = json.loads(cache_file.read_text())
    cached = saved["archives"] if saved["metrics"] == list(metrics) else {}
    if not isinstance(cached, dict):
        cached = {}
except (OSError, ValueError, KeyError, TypeError, UnicodeError):
    cached = {}

wanted = {cache_file.name}
checked = {}
for index in sorted(source.glob("*.index")):
    prefix = index.with_suffix("")
    stat = index.stat()
    signature = [stat.st_mtime_ns, stat.st_size]
    previous = cached.get(index.name)
    if not isinstance(previous, dict) or previous.get("signature") != signature:
        result = subprocess.run(
            ["pminfo", "-a", str(prefix), *metrics],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            timeout=10,
            check=False,
        )
        compatible = result.returncode == 0
    else:
        compatible = previous.get("compatible") is True
    checked[index.name] = {"signature": signature, "compatible": compatible}
    if not compatible:
        continue
    files = list(source.glob(prefix.name + ".*"))
    for original in files:
        link = view / original.name
        wanted.add(link.name)
        if original.suffix in {'.xz', '.zst', '.gz'}:
            if link.is_file() and not link.is_symlink() and link.stat().st_size == original.stat().st_size and link.stat().st_mtime_ns == original.stat().st_mtime_ns:
                continue
            if link.exists() or link.is_symlink():
                link.unlink()
            # PCP cannot open compressed archive files through symlinks.
            # Reflinks avoid duplicating their data on supported filesystems.
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

with tempfile.NamedTemporaryFile(mode="w", dir=view, prefix=".compatibility-", delete=False) as temporary:
    json.dump({"metrics": metrics, "archives": checked}, temporary)
    temporary_name = temporary.name
os.replace(temporary_name, cache_file)

print(view)
