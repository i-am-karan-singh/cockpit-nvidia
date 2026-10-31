# Cockpit NVIDIA GPU

A Cockpit page for NVIDIA GPU performance using Performance Co-Pilot (PCP). It
shows live utilization, VRAM occupancy, temperature, and power, with PCP archive
graphs from five minutes through one week. It does not run its own polling service
or store a separate history database.

## Requirements

- Cockpit 370 or newer
- PCP with the packaged NVIDIA PMDA and `pmcd`/`pmlogger`
- NVIDIA driver with working NVML access
- Node.js and npm for building the page

## Build and install

```sh
npm ci
npm run build
sudo ./scripts/install-pcp.sh
sudo ./scripts/install-plugin.sh
```

Reload Cockpit and open **GPU** in the System menu. The PCP setup script enables
the NVIDIA PMDA if needed, installs a five-metric logging group at a 10-second
interval, saves a backup of the existing logger config, and restarts pmlogger.
History begins after this setup. Existing PCP archive retention settings apply.

The packaged PCP configuration may also enable its standard NVIDIA logging
groups when the PMDA becomes available. This page does not use or show
per-process metrics.

To update the page after editing source files, rerun `npm run build` and
`sudo ./scripts/install-plugin.sh`, then reload Cockpit.

## Archive handling

Cockpit rejects an archive directory if it contains older archives that lack
one of the requested GPU metrics. On page load, a small helper creates a
per-user directory under `/var/tmp` with recent compatible PCP archives.
It links active archives and makes copies of compressed archives (using reflinks when available),
which PCP cannot reliably open through symlinks. The originals are untouched.
The page refreshes this view every 15 minutes, including after archive rotation.

PCP's `nvidia.memused` includes driver-reserved memory. For that reason, the
dashboard labels this value **VRAM occupied** and notes the reservation instead
of presenting it as the allocation figure from `nvidia-smi`.

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
