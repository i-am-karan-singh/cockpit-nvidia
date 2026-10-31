# Cockpit NVIDIA GPU

Authored by codex.

A Cockpit page for NVIDIA GPU performance using Performance Co-Pilot (PCP). It
shows live utilization, VRAM occupancy, temperature, and power, with PCP archive
graphs from five minutes through one week. A live process table uses `nvidia-smi`
for process memory and SM activity. It does not run its own polling service or
store a separate history database.

## Requirements

- Cockpit 370 or newer (Arch package: `cockpit`)
- PCP with its packaged NVIDIA PMDA (Arch package: `pcp`)
- NVIDIA driver with working NVML access and `nvidia-smi` (Arch package: `nvidia-utils`)
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
groups when the PMDA becomes available. The process table uses live `nvidia-smi`
data rather than PCP's lifetime-average process activity metric. Process memory
is queried every five seconds and one `pmon` process samples SM activity every
five seconds while the GPU page is visible. Cockpit stops both when the page is
hidden or closed. Process readings are not logged by this plugin.

To update the page after editing source files, rerun `npm run build` and
`sudo ./scripts/install-plugin.sh`, then reload Cockpit.

## Cockpit plots

The GPU page uses the plotting code from Cockpit 370's Storage page, including
its `SvgPlot`, `ZoomControls`, and `PlotState`. The copied source and its
small GPU-specific adaptation are documented in
[`src/vendor/cockpit/README.md`](src/vendor/cockpit/README.md). The build uses
the same PatternFly 6.6 package versions as Cockpit 370.

## Archive handling

Cockpit checks every archive in a source directory for the requested metric
before returning history. An older archive without GPU metrics would make the
chart's history request fail, even for a recent time range. The live plot still
receives new readings from `pmcd` while the page is open.

On page load, a helper creates a per-user view under `/var/tmp` containing
compatible archives. It checks all retained archives, with no age cutoff,
and caches each archive's compatibility using its index timestamp and size.
Later runs check only new or changed archives. Active archive files are
symlinked, so new writes remain visible. Compressed files are copied using
reflinks where supported, because PCP cannot read them through symlinks;
`cp --reflink=auto` uses a full copy otherwise. The source archives are
untouched. The page refreshes the view every 15 minutes to pick up rotations.
PCP's archive retention controls how far back history is available.

A possible future alternative is a separate GPU `pmlogger` instance writing
to its own archive directory, which Cockpit can read by absolute path. That
would remove the filtered view for new history, but it would need separate
logger and retention configuration. Existing GPU history would need migration
to appear in the new directory.

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
live readings and all history ranges, and writes a screenshot to
`/tmp/cockpit-nvidia-smoke.png`. Keep `.localcred` readable only by your user.
