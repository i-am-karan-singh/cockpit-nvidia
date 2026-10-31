# Agent notes for cockpit-nvidia

Read `README.md` for user-facing setup. This file records implementation
decisions, host-specific findings, and the reasons behind them.

## Project history

1. The project began as a Cockpit GPU page for an Arch Linux host with an
   NVIDIA GeForce RTX 5090. The host is headless; Cockpit is the admin UI.
2. PCP's packaged NVIDIA PMDA was enabled to get persistent GPU history.
   Older PCP archives predate the GPU metrics, so the page prepares a filtered
   per-user archive view before asking Cockpit to plot history.
3. An initial page used custom graphs. A temporary `Storage2` copy of
   Cockpit's Storage page established that its native graphs and controls
   could be reused. The page now vendors the relevant Cockpit 370 plot code.
   Storage2 was subsequently removed; do not depend on it.
4. Live GPU process details were added through `nvidia-smi`. PCP's process
   utilization looked plausible but proved to be a lifetime average under a
   sustained Ollama workload, so it is unsuitable for a live activity column.
5. The graphs now use dynamic y-axis ranges, VRAM is in GiB, the GPU table
   names the model, and the process table shows full paths. The table layout
   wraps long paths so the other columns stay visible.

## Architecture and data semantics

- `src/app.jsx` reads live `nvidia.gpuactive`, `nvidia.memused`,
  `nvidia.memtotal`, `nvidia.temperature`, and `nvidia.power` from PCP every
  2 seconds for the summary table. The four plots use Cockpit's `PlotState`
  against `pmcd` and PCP archives. Graph history is logged by `pmlogger` at
  10-second intervals through `pcp/core` and `scripts/install-pcp.sh`.
- `src/vendor/cockpit/` contains plot code pinned to Cockpit 370, commit
  `fd21ab5cf661ec2442eaba80c40cb10f23eb860f`. Read its `README.md`
  before changing it. PatternFly versions in `package.json` track that
  Cockpit release. Upstream plot code is not a stable public API.
- `src/prepare-archives.py` runs from the logged-in Cockpit session on page
  load and every 15 minutes. It creates a per-user view under `/var/tmp` of
  recent archives containing all required GPU metrics. Active archives are
  symlinked; compressed archives are copied, preferably with Btrfs reflinks,
  because PCP cannot reliably open compressed volumes through symlinks.
  It does not alter or backfill older source archives. Archive retention is
  PCP's responsibility.
- PCP `nvidia.memused` is NVML's older device memory counter and includes
  driver-reserved memory. On this host it reported about 414 MiB while
  `nvidia-smi` reported 2 MiB used and 414 MiB reserved. The UI deliberately
  labels the PCP series **VRAM occupied** and uses it consistently for live
  summary and history. Do not silently subtract the reservation: the values
  did not reconcile exactly, and PCP does not archive the newer NVML used
  counter. A separate collector was considered and declined.
- `nvidia.cardname` is a PCP string metric. `src/app.jsx` reads it once with
  `pminfo -f` because the Cockpit numeric metrics channel is not suited to
  strings. Keep GPU instance IDs (`gpu0`, etc.) for metric selection and use
  the model name only for display.
- `src/processes.js` uses `nvidia-smi --query-compute-apps` for process paths
  and per-process VRAM every 5 seconds. One `nvidia-smi pmon -s u -d 5`
  process supplies recent per-process SM activity. Its first sample can be
  `-`; show an unavailable value rather than treating it as zero. Graphics
  processes seen only by `pmon` may lack a VRAM reading. The process data is
  live only and is not archived by this plugin.
- Cockpit sends embedded pages a `cockpit.hidden` / `visibilitychange` hint
  when the page or browser tab is hidden. `src/processes.js` stops both
  `nvidia-smi` paths then. Merely logging into Cockpit does not run them.
- PCP `nvidia.proc.gpuactive` and `nvidia.proc.memactive` use NVML process
  accounting over the process lifetime. In a test, GPU-wide utilization was
  about 92–94% while the process value crept from 0% to 6%; `pmon` showed
  about 90–93% SM activity during the same inference. Do not present PCP's
  process accounting value as current process utilization.
- PCP `nvidia.fanspeed` is unsupported on this host. `nvidia-smi` did report
  0% at idle and roughly 31–37% during a 40-second Ollama load, but that is
  intended fan speed, not physical RPM. The user chose to leave fans out of
  the page.

## Working on this headless host

- Chromium is installed. `test/browser-smoke.mjs` uses Chrome DevTools
  Protocol to log into local Cockpit at `https://127.0.0.1:9090` and inspect
  the rendered iframe. `.localcred` contains `user:password` for this local
  test, is Git-ignored, and must never be printed or committed. The user's
  external Cockpit endpoint may differ from the test URL.
- The sandbox may block `/dev/nvidia`, the local Ollama socket, `pmcd`, or
  systemd even when they work normally on the host. Use an approved elevated
  command for host-level verification. Do not install additional system
  packages without user review; prefer official Arch packages over AUR.
- This workspace is accessed through SSHFS from macOS. It can produce
  `.DS_Store`, `._*`, and transient `.fuse_hidden*` files. Never stage or
  delete user screenshots or transient SSHFS files as part of routine work.

## Build, install, verify

```sh
npm ci
npm run check
sudo ./scripts/install-pcp.sh      # PMDA plus GPU archive logging
sudo ./scripts/install-plugin.sh   # installs /usr/local/share/cockpit/cockpit-nvidia
pminfo -f nvidia.numcards nvidia.gpuactive nvidia.memused
node test/browser-smoke.mjs
```

`README.md` documents the prerequisite `cockpit.socket`, `pmcd.service`, and
`pmlogger.service` setup. The NVIDIA PMDA runs under `pmcd`; there is no
separate `nvidia-collector` systemd service. The PCP install script backs up
the logger config and restarts `pmlogger`; it does not install packages.

Optional browser checks: `CHECK_PROCESS_VISIBILITY=1` verifies `pmon` stops
after leaving the GPU page. `EXPECT_OLLAMA=1` requires the host's Ollama
process to be present, and `CHECK_PROCESS_ACTIVITY=1` runs a short local
Ollama inference with the local `zeta2:latest` model. The default smoke test
also expects this host's RTX 5090 and Cockpit login. Screenshots are written
under `/tmp`.
