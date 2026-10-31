# Cockpit plotting code

`plot.js`, `cockpit-components-plot.jsx`, and `cockpit-components-plot.scss`
are copied from [Cockpit 370](https://github.com/cockpit-project/cockpit/tree/370/pkg/lib)
at commit `fd21ab5cf661ec2442eaba80c40cb10f23eb860f` and retain their
LGPL-2.1-or-later notices. The local `hooks.js` and `timeformat.js` contain
the small portions of their Cockpit 370 counterparts required by the plot.

Local adaptations:

- Imports use the package's `window.cockpit` adapter and local helpers.
- `plot.js` accepts `archive_source` on a PMCD metric description so the
  GPU plots can read PCP's default archive directory.

These Cockpit modules are not a stable public API. When upgrading Cockpit or
PatternFly, compare this directory with the new upstream source and run the
Chromium smoke test against the installed version.
