# Cockpit NVIDIA GPU

Authored by codex.

A Cockpit page for NVIDIA GPU performance using Performance Co-Pilot (PCP). It
shows live utilization, VRAM occupancy, temperature, and power, with PCP archive
graphs from five minutes through one week. A live process table reads process
names and per-GPU VRAM from PCP. It does not run its own polling service or
store a separate history database.

## Requirements

- Cockpit 370 or newer (Arch package: `cockpit`)
- PCP with its packaged NVIDIA PMDA (Arch package: `pcp`)
- NVIDIA driver with working NVML access (Arch package: `nvidia-utils`)
- Node.js and npm for building the page

## Build and install

Enable Cockpit and PCP's collector and archive logger:

```sh
sudo systemctl enable --now cockpit.socket pmcd.service pmlogger.service
```

The NVIDIA collector is PCP's **NVIDIA PMDA** (`pmdanvidia`), which runs under
`pmcd`; it does not need its own systemd service. Install it and configure
10-second GPU archive logging with the included setup script:

```sh
npm ci
npm run build
sudo ./scripts/install-pcp.sh
sudo ./scripts/install-plugin.sh
pminfo -f nvidia.numcards nvidia.gpuactive nvidia.memused
```

Reload Cockpit and open **GPU** in the System menu. The PCP setup script runs
`/var/lib/pcp/pmdas/nvidia/Install` if the PMDA is absent, checks that it sees
a GPU, adds the five dashboard metrics to `pmlogger`, saves a backup of the
existing logger config, and restarts `pmlogger`. The `pminfo` command above
should report a card count and GPU readings. History begins after setup;
existing PCP archive retention settings apply.

The packaged PCP configuration may also enable its standard NVIDIA logging
groups when the PMDA becomes available. The process table joins PCP's
`nvidia.proc.memused` with Linux `proc.psinfo.pid` by PID; the latter's instance
label includes the executable path. Both tables share one PCP channel and
refresh every two seconds while the GPU page is visible; the channel closes
when the page is hidden. On return, both tables show their last readings
immediately until the next sample arrives. The process table omits per-process
GPU activity because PCP's value is a lifetime average. The plugin does not
add process metrics to its custom archive logging group.

PCP also exposes `nvidia.memactive`, the percentage of time GPU memory was
accessed during a sample period. That is not measured memory bandwidth in
bytes per second, so the page does not present it as a bandwidth chart.

To update the page after editing source files, rerun `npm run build` and
`sudo ./scripts/install-plugin.sh`, then reload Cockpit.

## Cockpit plots

The GPU page uses the plotting code from Cockpit 370's Storage page, including
its `SvgPlot`, `ZoomControls`, and `PlotState`. The copied source and its
small GPU-specific adaptation are documented in
[`src/vendor/cockpit/README.md`](src/vendor/cockpit/README.md). The build uses
the same PatternFly 6.6 package versions as Cockpit 370.

## Archive handling

The plots read Cockpit's default PCP archive source directly. `pmlogger`
records GPU readings in `/var/log/pcp/pmlogger/<hostname>`; PCP controls
archive rotation and retention. The plugin does not create an archive view,
copy logs, or run a history preparation helper.

This setup assumes every archive in that directory contains the plotted GPU
metrics. Cockpit checks every archive for the requested metric before it
returns historical samples. If an older archive lacking a metric is restored,
that chart's history request will fail even for a recent time range. Live
readings from `pmcd` will still appear while the page is open. For this host,
the user chose to delete incompatible old PCP logs to make direct history
work, accepting the loss of their older samples. Adding a newly logged metric
later may require the same decision again.

A possible, unimplemented alternative is a separate GPU `pmlogger` instance
writing to its own archive directory, which Cockpit can read by absolute path.
It would need separate logger and retention configuration, and existing GPU
history would need migration to appear there.

The VRAM graph and table use PCP's `nvidia.memused` in GiB. This is NVML's
older frame-buffer memory counter and includes driver-reserved memory. On this
host, `nvidia-smi` reports a smaller **Used** value from NVML's newer memory
counter, which PCP's NVIDIA PMDA does not archive. The page keeps one
consistent PCP-backed history series rather than starting a separate collector.

## Checks

```sh
npm run check
pminfo -f nvidia.gpuactive nvidia.memused nvidia.temperature nvidia.power
node test/browser-smoke.mjs
```

The browser test uses the local, Git-ignored `.localcred` file in
`user:password` format, logs into Cockpit at `https://127.0.0.1:9090`, checks
live readings, an actual sample from the default PCP archive, and all history
ranges, then writes a screenshot to `/tmp/cockpit-nvidia-smoke.png`. Keep
`.localcred` readable only by your user.
