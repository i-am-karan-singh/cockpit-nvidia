// SPDX-License-Identifier: LGPL-2.1-or-later
// The two Cockpit 370 timeformat helpers used by cockpit-components-plot.jsx.
// Derived from pkg/lib/timeformat.ts.
import cockpit from './cockpit.js';

export const formatter = options => new Intl.DateTimeFormat(cockpit.language.replace('_', '-'), options);
export const date = value => formatter({ dateStyle: 'long' }).format(value);
