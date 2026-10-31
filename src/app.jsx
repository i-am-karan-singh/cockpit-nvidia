import React, { useEffect, useState } from 'react';
import { Page, PageSection } from '@patternfly/react-core/dist/esm/components/Page/index.js';
import { Grid, GridItem } from '@patternfly/react-core/dist/esm/layouts/Grid/index.js';
import { Split, SplitItem } from '@patternfly/react-core/dist/esm/layouts/Split/index.js';
import { PlotState } from './vendor/cockpit/plot.js';
import { ZoomControls, SvgPlot } from './vendor/cockpit/cockpit-components-plot.jsx';
import prepareArchives from './prepare-archives.py';
import { useGpuProcesses } from './processes.js';

const cockpit = window.cockpit;
const METRICS = ['nvidia.gpuactive', 'nvidia.memused', 'nvidia.memtotal', 'nvidia.temperature', 'nvidia.power'].map(name => ({ name }));
const unitConfig = (unit, min_max, widest_string = unit) => ({
  min_max,
  pull_out_unit: true,
  widest_string,
  formatter: value => [Math.round(value).toString(), unit],
});
const percentConfig = unitConfig('%', 1, '100');
const memoryConfig = {
  min_max: 0.01,
  pull_out_unit: true,
  widest_string: '0.00',
  formatter: value => [Number(value.toFixed(2)).toString(), 'GiB'],
};
const temperatureConfig = unitConfig('°C', 1, '100');
const powerConfig = unitConfig('W', 1, '600');

function useGpuNames() {
  const [names, setNames] = useState({});
  useEffect(() => {
    let active = true;
    cockpit.spawn(['pminfo', '-f', 'nvidia.cardname'], { err: 'message' })
      .then(output => {
        if (!active) return;
        const found = {};
        for (const line of output.split('\n')) {
          const match = line.match(/^\s*inst \[\d+ or "([^"]+)"\] value "(.+)"\s*$/);
          if (match) found[match[1]] = match[2];
        }
        setNames(found);
      })
      .catch(error => console.error('Could not read NVIDIA card names', error));
    return () => { active = false; };
  }, []);
  return names;
}

function useArchiveSource() {
  const [source, setSource] = useState({ path: null, revision: 0, error: false });
  useEffect(() => {
    let active = true;
    const refresh = () => cockpit.spawn(['python3', '-c', prepareArchives], { err: 'message' })
      .then(path => { if (active) setSource(previous => ({ path: path.trim(), revision: previous.revision + 1, error: false })); })
      .catch(error => {
        console.error('Could not prepare PCP GPU archives', error);
        if (active) setSource(previous => ({ ...previous, error: true }));
      });
    refresh();
    const timer = window.setInterval(refresh, 15 * 60 * 1000);
    return () => { active = false; window.clearInterval(timer); };
  }, []);
  return source;
}

function useLiveMetrics() {
  const [data, setData] = useState({ rows: [], instances: [], unavailable: false });
  useEffect(() => {
    let active = true;
    let metrics;
    let grid;
    let timeout;
    try {
      metrics = cockpit.metrics(2000, { source: 'pmcd', metrics: METRICS });
      grid = cockpit.grid(2000, -6, -0);
      const row = grid.add(metrics);
      const update = () => {
        if (!active) return;
        setData({ rows: Array.from({ length: 6 }, (_, index) => row[index]), instances: metrics.meta?.metrics?.[0]?.instances || [], unavailable: false });
      };
      grid.addEventListener('notify', update);
      metrics.addEventListener('changed', update);
      grid.sync();
      grid.walk();
      metrics.follow();
      timeout = window.setTimeout(() => { if (active) setData(previous => ({ ...previous, unavailable: !previous.rows.some(Boolean) })); }, 8000);
    } catch (error) {
      console.error('Could not open NVIDIA metrics', error);
      setData({ rows: [], instances: [], unavailable: true });
    }
    return () => { active = false; window.clearTimeout(timeout); metrics?.close(); grid?.close(); };
  }, []);
  return data;
}

function useGpuPlots(source, instance) {
  const [plotState, setPlotState] = useState(null);
  useEffect(() => {
    if (!instance) return undefined;
    const state = new PlotState();
    const common = { ...(source ? { archive_source: source } : {}), instances: [instance] };
    state.plot_single('utilization', { ...common, pmcd: ['nvidia.gpuactive'] });
    state.plot_single('memory', { ...common, pmcd: ['nvidia.memused'], factor: 1 / 2 ** 30 });
    state.plot_single('temperature', { ...common, pmcd: ['nvidia.temperature'] });
    state.plot_single('power', { ...common, pmcd: ['nvidia.power'], factor: 0.001 });
    setPlotState(state);
    return () => {
      Object.values(state.plots).forEach(plot => plot.destroy());
      setPlotState(current => current === state ? null : current);
    };
  }, [source, instance]);
  return plotState;
}

function latestSample(rows) {
  for (let index = rows.length - 1; index >= 0; index--) {
    if (Array.isArray(rows[index]) && Array.isArray(rows[index][0])) return rows[index];
  }
  return null;
}
const value = (sample, metric, gpu) => {
  const result = sample?.[metric]?.[gpu];
  return typeof result === 'number' && Number.isFinite(result) ? result : null;
};
const bytes = number => number == null ? '—' : `${(number / 2 ** 30).toFixed(1)} GiB`;
const reading = (number, unit) => number == null ? '—' : `${Math.round(number)} ${unit}`;
const processMemory = mebibytes => mebibytes == null ? '—' : mebibytes < 1024 ? `${Math.round(mebibytes)} MiB` : `${(mebibytes / 1024).toFixed(1)} GiB`;

export function App() {
  const [gpu, setGpu] = useState(0);
  const live = useLiveMetrics();
  const names = useGpuNames();
  const archive = useArchiveSource();
  const processes = useGpuProcesses();
  const current = latestSample(live.rows);
  const instances = live.instances.length ? live.instances : (current?.[0]?.map((_, index) => `gpu${index}`) || []);
  const selectedGpu = Math.min(gpu, Math.max(instances.length - 1, 0));
  const plotState = useGpuPlots(archive.path, instances[selectedGpu]);

  return <Page id="gpu" className="pf-m-no-sidebar">
    <PageSection hasBodyWrapper={false} isFilled={false}>
      {plotState && <>
        <Split><SplitItem isFilled /><SplitItem><ZoomControls plot_state={plotState} /></SplitItem></Split>
        <Grid sm={12} md={6} lg={6} hasGutter>
          <GridItem><SvgPlot className="gpu-graph" title="GPU utilization" config={percentConfig} plot_state={plotState} plot_id="utilization" /></GridItem>
          <GridItem><SvgPlot className="gpu-graph" title="VRAM occupied" config={memoryConfig} plot_state={plotState} plot_id="memory" /></GridItem>
          <GridItem><SvgPlot className="gpu-graph" title="Temperature" config={temperatureConfig} plot_state={plotState} plot_id="temperature" /></GridItem>
          <GridItem><SvgPlot className="gpu-graph" title="Power draw" config={powerConfig} plot_state={plotState} plot_id="power" /></GridItem>
        </Grid>
      </>}
      <section className="gpu-devices" aria-label="GPU readings">
        {live.unavailable && !current && <div className="gpu-message" role="alert">GPU metrics are unavailable. Check that the PCP NVIDIA PMDA is enabled.</div>}
        {archive.error && <div className="gpu-message" role="status">History will appear after the PCP logger records GPU samples.</div>}
        <div className="gpu-table-scroll"><table className="gpu-table">
          <thead><tr><th scope="col">GPU</th><th scope="col">Utilization</th><th scope="col">VRAM occupied</th><th scope="col">Temperature</th><th scope="col">Power draw</th></tr></thead>
          <tbody>{instances.length ? instances.map((name, index) => {
            const used = value(current, 1, index);
            const total = value(current, 2, index);
            return <tr key={name} className={selectedGpu === index ? 'is-selected' : ''}>
              <th scope="row"><button type="button" className="gpu-select-link" onClick={() => setGpu(index)} aria-pressed={selectedGpu === index}>{names[name] || name}</button></th>
              <td>{reading(value(current, 0, index), '%')}</td>
              <td>{total == null ? bytes(used) : `${bytes(used)} / ${bytes(total)}`}</td>
              <td>{reading(value(current, 3, index), '°C')}</td>
              <td>{value(current, 4, index) == null ? '—' : `${(value(current, 4, index) / 1000).toFixed(1)} W`}</td>
            </tr>;
          }) : <tr><td colSpan="5">Waiting for GPU readings…</td></tr>}</tbody>
        </table></div>
      </section>
      <section className="gpu-processes" aria-label="GPU processes">
        {processes.error && <div className="gpu-message" role="status">Could not read NVIDIA processes.</div>}
        <div className="gpu-table-scroll"><table className="gpu-table">
          <thead><tr><th scope="col">Process</th><th scope="col">PID</th><th scope="col">GPU</th><th scope="col">VRAM</th><th scope="col">SM activity</th></tr></thead>
          <tbody>{processes.rows.length ? processes.rows.map(process => <tr key={`${process.gpuIndex}:${process.pid}`}>
            <th scope="row"><span className="gpu-process-path">{process.name || '—'}</span></th>
            <td>{process.pid}</td>
            <td>{names[`gpu${process.gpuIndex}`] || `GPU ${process.gpuIndex}`}</td>
            <td>{processMemory(process.memoryMiB)}</td>
            <td>{process.activity == null ? '—' : `${process.activity} %`}</td>
          </tr>) : <tr><td colSpan="5">{processes.loading ? 'Checking GPU processes…' : processes.visible ? 'No GPU processes' : 'Open the GPU page to see live processes'}</td></tr>}</tbody>
        </table></div>
      </section>
    </PageSection>
  </Page>;
}
