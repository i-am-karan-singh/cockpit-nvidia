# Agent notes for cockpit-nvidia

Read `README.md` for user-facing setup. This file records implementation
decisions, host-specific findings, and the reasons behind them.

## Project history

1. The project began as a Cockpit GPU page for an Arch Linux host with an
   NVIDIA GeForce RTX 5090. The host is headless; Cockpit is the admin UI.
2. PCP's packaged NVIDIA PMDA was enabled to get persistent GPU history.
   The original archives predated GPU metrics, so an early version prepared a
   filtered per-user archive view before asking Cockpit to plot history.
3. An initial page used custom graphs. A temporary `Storage2` copy of
   Cockpit's Storage page established that its native graphs and controls
   could be reused. The page now vendors the relevant Cockpit 370 plot code.
   Storage2 was subsequently removed; do not depend on it.
4. Live GPU process details initially came from `nvidia-smi`. The table now
   joins PCP's NVIDIA process VRAM with Linux process labels by PID. PCP's
   process utilization looked plausible but proved to be a lifetime average
   under a sustained Ollama workload; the SM activity column was dropped.
5. The graphs now use dynamic y-axis ranges, VRAM is in GiB, the GPU table
   names the model, and the process table shows full paths. The table layout
   wraps long paths so the other columns stay visible.
6. The user reset the old PCP archives after GPU logging was enabled. The
   filtered view and its Python helper were then removed. GPU plots now read
   Cockpit's default `pcp-archive` source directly. This assumes every archive
   in that directory contains the plotted NVIDIA metrics. The user accepts
   deleting incompatible old logs to establish this invariant, knowing that
   doing so discards their historical samples.

## Architecture and data semantics

- `src/app.jsx` reads live `nvidia.gpuactive`, `nvidia.memused`,
  `nvidia.memtotal`, `nvidia.temperature`, `nvidia.power`, `nvidia.proc.memused`,
  and `proc.psinfo.pid` from one PCP channel every 2 seconds for both tables.
  The four plots use Cockpit's `PlotState` against `pmcd` and PCP archives.
  Graph history is logged by `pmlogger` at 10-second intervals through
  `pcp/core` and `scripts/install-pcp.sh`.
- `src/vendor/cockpit/` contains plot code pinned to Cockpit 370, commit
  `fd21ab5cf661ec2442eaba80c40cb10f23eb860f`. Read its `README.md`
  before changing it. PatternFly versions in `package.json` track that
  Cockpit release. Upstream plot code is not a stable public API.
- The plots request `archive_source: 'pcp-archive'` and Cockpit reads the
  normal PCP archives in `/var/log/pcp/pmlogger/<hostname>`. There is no
  per-user archive view, Python helper, or plugin-managed archive copy.
  `pmlogger` writes the archives and PCP manages retention.
- The vendored `PlotState` is frontend code. It passes the archive directory
  to Cockpit's installed Python PCP channel. That channel validates the
  requested metric in every archive before applying the requested time range;
  one older archive without the metric aborts that chart's entire history
  request. Its separate `pmcd` channel still provides live samples starting
  when the page opens. The reset archive set was checked for all five GPU
  metrics before switching sources. A frontend start-date filter cannot avoid
  this failure if an incompatible archive is added later.
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
- `src/app.jsx` joins the process metrics from that shared PCP sample by PID.
  NVIDIA instances use names like `gpu0::5851`; Linux process labels look like
  `005851 /usr/lib/ollama/llama-server`. Join by the numeric PID, retain the
  GPU index, and display the Linux label's executable path. Parse the PID from
  the label itself; do not zip label positions to sampled `proc.psinfo.pid`
  values, because their orders can diverge during process churn. Process
  memory is in bytes. These live process metrics are not part of this plugin's
  custom `pcp/core` logging group, although PCP's enabled standard
  `nvidia/summary` group logs `nvidia.proc.all` metrics.
- Cockpit sends embedded pages a `cockpit.hidden` / `visibilitychange` hint
  when the page or browser tab is hidden. `src/app.jsx` closes the shared table
  metrics and grid channels then, while retaining the last table samples so
  both tables render immediately when the page becomes visible again. A new
  two-second sample replaces the retained values. Merely logging into Cockpit
  does not run the table channel.
- PCP `nvidia.proc.gpuactive` and `nvidia.proc.memactive` use NVML process
  accounting over the process lifetime. In a test, GPU-wide utilization was
  about 92–94% while the process value crept from 0% to 6%; `pmon` showed
  about 90–93% SM activity during the same inference. Do not present PCP's
  process accounting value as current process utilization.
- PCP `nvidia.memactive` measures the percentage of a sample period in which
  GPU memory was read or written. It is not memory bandwidth in bytes per
  second. The user chose to leave the GPU charts unchanged rather than label
  this as bandwidth.
- PCP `nvidia.fanspeed` is unsupported on this host. `nvidia-smi` did report
  0% at idle and roughly 31–37% during a 40-second Ollama load, but that is
  intended fan speed, not physical RPM. The user chose to leave fans out of
  the page.

## Unimplemented future archive option

- If mixed-metric archives become a problem again, a separate `pmlogger`
  instance could record only GPU metrics into its own directory. Cockpit can
  use an absolute archive directory as a source; the hostname-derived path
  is only its default. This requires another logger and retention setup, and
  existing GPU history would need migration. New metrics added later could
  still create a mixed-history problem. Keep Cockpit's packaged backend
  untouched unless the user explicitly revisits that decision.

## Working on this headless host

- `flake.nix` builds the page with Nix, exposes an explicit `setup-pcp` app,
  and offers a Home Manager module that links the page into the Cockpit
  login user's XDG data directory. The packaged PCP script and `pcp/core`
  retain the relative layout the script expects. The setup app uses the
  host's `/usr/bin/sudo`; Home Manager activation does not run it.
- The main account `karan` has an existing standalone Home Manager flake at
  `/home/karan/.config/home-manager` with `homeConfigurations.karan`. Use it
  for the per-user installation. The `.localcred` account does not have this
  Home Manager setup. For the flake installation, do not read `.localcred`
  or run the login-based browser smoke test; the user will confirm Cockpit
  manually. `cockpit-bridge --packages` as `karan` checks package discovery.

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

Optional browser checks: `CHECK_PROCESS_VISIBILITY=1` verifies Cockpit marks
the GPU page hidden after navigation and shows retained process rows on return.
`EXPECT_OLLAMA=1` requires the host's Ollama process to be present in the PCP
process table. The default smoke test also expects this host's RTX 5090 and
Cockpit login. Screenshots are written under `/tmp`.
