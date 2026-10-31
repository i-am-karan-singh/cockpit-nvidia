import React, { useEffect, useState } from 'react';
import { Page, PageSection } from '@patternfly/react-core/dist/esm/components/Page/index.js';
import { Grid, GridItem } from '@patternfly/react-core/dist/esm/layouts/Grid/index.js';
import { Split, SplitItem } from '@patternfly/react-core/dist/esm/layouts/Split/index.js';
import { PlotState } from './vendor/cockpit/plot.js';
import { ZoomControls, SvgPlot } from './vendor/cockpit/cockpit-components-plot.jsx';

const cockpit = window.cockpit;
const METRICS = ['nvidia.gpuactive', 'nvidia.memused', 'nvidia.memtotal', 'nvidia.temperature', 'nvidia.power',
  'nvidia.proc.memused', 'proc.psinfo.pid'].map(name => ({ name }));
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

function processRows(sample, metadata) {
  const gpuMemory = sample?.[5];
  const gpuInstances = metadata?.metrics?.[5]?.instances || [];
  const processInstances = metadata?.metrics?.[6]?.instances || [];
  if (!Array.isArray(gpuMemory)) return [];

  // Metadata and samples may have different instance orders during process churn.
  const names = new Map(processInstances.flatMap(instance => {
    const match = instance.match(/^(\d+)\s+(.+)$/);
    return match ? [[Number(match[1]), match[2]]] : [];
  }));
  return gpuInstances.flatMap((instance, index) => {
    const match = instance.match(/^gpu(\d+)::(\d+)$/);
    const memoryBytes = gpuMemory[index];
    if (!match || typeof memoryBytes !== 'number' || !Number.isFinite(memoryBytes)) return [];
    const pid = Number(match[2]);
    return [{ gpuIndex: Number(match[1]), pid, name: names.get(pid) || `PID ${pid}`, memoryBytes }];
  }).sort((a, b) => b.memoryBytes - a.memoryBytes || a.pid - b.pid);
}

function useLiveMetrics() {
  const [data, setData] = useState({ rows: [], instances: [], processes: [], loading: true, unavailable: false, visible: !cockpit.hidden });
  useEffect(() => {
    let metrics;
    let grid;
    let timeout;

    const stop = (updateState = true) => {
      window.clearTimeout(timeout);
      grid?.close();
      metrics?.close();
      grid = metrics = undefined;
      if (updateState) setData(previous => ({ ...previous, visible: false }));
    };

    const start = () => {
      if (metrics) return;
      setData(previous => ({ ...previous, loading: !previous.rows.some(Boolean), unavailable: false, visible: true }));
      try {
        metrics = cockpit.metrics(2000, { source: 'pmcd', metrics: METRICS });
        grid = cockpit.grid(2000, -6, -0);
        const row = grid.add(metrics);
        const update = () => {
          if (!metrics?.meta) return;
          const rows = Array.from({ length: 6 }, (_, index) => row[index]);
          const sample = latestSample(rows);
          if (!sample) return;
          window.clearTimeout(timeout);
          setData({ rows, instances: metrics.meta.metrics[0]?.instances || [],
            processes: processRows(sample, metrics.meta), loading: false, unavailable: false, visible: true });
        };
        grid.addEventListener('notify', update);
        metrics.addEventListener('changed', update);
        grid.sync();
        grid.walk();
        metrics.follow();
        timeout = window.setTimeout(() => {
          if (metrics) setData(previous => ({ ...previous, loading: false, unavailable: true }));
        }, 8000);
      } catch (error) {
        console.error('Could not open NVIDIA metrics', error);
        stop(false);
        setData(previous => ({ ...previous, processes: [], loading: false, unavailable: true, visible: true }));
      }
    };

    const visibilityChanged = () => { if (cockpit.hidden) stop(); else start(); };
    cockpit.addEventListener('visibilitychange', visibilityChanged);
    visibilityChanged();
    return () => { cockpit.removeEventListener('visibilitychange', visibilityChanged); stop(false); };
  }, []);
  return data;
}

function useGpuPlots(instance) {
  const [plotState, setPlotState] = useState(null);
  useEffect(() => {
    if (!instance) return undefined;
    const state = new PlotState();
    const common = { archive_source: 'pcp-archive', instances: [instance] };
    state.plot_single('utilization', { ...common, pmcd: ['nvidia.gpuactive'] });
    state.plot_single('memory', { ...common, pmcd: ['nvidia.memused'], factor: 1 / 2 ** 30 });
    state.plot_single('temperature', { ...common, pmcd: ['nvidia.temperature'] });
    state.plot_single('power', { ...common, pmcd: ['nvidia.power'], factor: 0.001 });
    setPlotState(state);
    return () => {
      Object.values(state.plots).forEach(plot => plot.destroy());
      setPlotState(current => current === state ? null : current);
    };
  }, [instance]);
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
const processMemory = bytes => bytes == null ? '—' : bytes < 2 ** 30 ? `${Math.round(bytes / 2 ** 20)} MiB` : `${(bytes / 2 ** 30).toFixed(1)} GiB`;

export function App() {
  const [gpu, setGpu] = useState(0);
  const live = useLiveMetrics();
  const names = useGpuNames();
  const current = latestSample(live.rows);
  const instances = live.instances.length ? live.instances : (current?.[0]?.map((_, index) => `gpu${index}`) || []);
  const selectedGpu = Math.min(gpu, Math.max(instances.length - 1, 0));
  const plotState = useGpuPlots(instances[selectedGpu]);

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
        {live.unavailable && <div className="gpu-message" role="alert">GPU metrics are unavailable. Check that PCP and the NVIDIA PMDA are enabled.</div>}
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
        <div className="gpu-table-scroll"><table className="gpu-table">
          <thead><tr><th scope="col">Process</th><th scope="col">PID</th><th scope="col">GPU</th><th scope="col">VRAM</th></tr></thead>
          <tbody aria-busy={live.loading}>{live.loading ? null : live.processes.length ? live.processes.map(process => <tr key={`${process.gpuIndex}:${process.pid}`}>
            <th scope="row"><span className="gpu-process-path">{process.name || '—'}</span></th>
            <td>{process.pid}</td>
            <td>{names[`gpu${process.gpuIndex}`] || `GPU ${process.gpuIndex}`}</td>
            <td>{processMemory(process.memoryBytes)}</td>
          </tr>) : <tr><td colSpan="4">{live.visible ? 'No GPU processes' : 'Open the GPU page to see live processes'}</td></tr>}</tbody>
        </table></div>
      </section>
    </PageSection>
  </Page>;
}
