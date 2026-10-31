import React, { useEffect, useMemo, useState } from 'react';
import prepareArchives from './prepare-archives.py';

const cockpit = window.cockpit;
const METRICS = ['nvidia.gpuactive', 'nvidia.memused', 'nvidia.memtotal', 'nvidia.temperature', 'nvidia.power'].map(name => ({ name }));
const RANGES = [
  { label: '5 minutes', interval: 1000, count: 300 },
  { label: '1 hour', interval: 10000, count: 360 },
  { label: '6 hours', interval: 60000, count: 360 },
  { label: '1 day', interval: 120000, count: 720 },
  { label: '1 week', interval: 600000, count: 1008 },
];

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

function useGpuMetrics(interval, count, archiveSource, revision = 0, offset = 0) {
  const [data, setData] = useState({ rows: [], instances: [], ready: false, unavailable: false, endTime: Date.now() });
  useEffect(() => {
    let active = true;
    setData({ rows: [], instances: [], ready: false, unavailable: false, endTime: Date.now() - offset * interval });
    if (archiveSource === null) return () => { active = false; };
    let metrics;
    let grid;
    let timeout;
    try {
      metrics = cockpit.metrics(interval, { source: 'pmcd', ...(archiveSource ? { archive_source: archiveSource } : {}), metrics: METRICS });
      grid = cockpit.grid(interval, -count - offset, -offset);
      const row = grid.add(metrics);
      const update = () => {
        if (!active) return;
        const instances = metrics.meta?.metrics?.[0]?.instances || [];
        const rows = Array.from({ length: count }, (_, index) => row[index]);
        const ready = rows.some(sample => Array.isArray(sample) && Array.isArray(sample[0]));
        setData({ rows, instances, ready, unavailable: false, endTime: Date.now() - offset * interval });
      };
      grid.addEventListener('notify', update);
      metrics.onchanged = update;
      grid.sync();
      if (offset === 0) grid.walk();
      if (archiveSource) metrics.fetch(grid.beg, grid.end);
      if (offset === 0) metrics.follow();
      timeout = window.setTimeout(() => { if (active) setData(previous => ({ ...previous, unavailable: !previous.ready })); }, 8000);
    } catch (error) {
      setData({ rows: [], instances: [], ready: false, unavailable: true, endTime: Date.now() - offset * interval });
      console.error('Could not open NVIDIA metrics', error);
    }
    return () => { active = false; window.clearTimeout(timeout); metrics?.close(); grid?.close(); };
  }, [interval, count, archiveSource, revision, offset]);
  return data;
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
const identity = number => number;
const powerWatts = number => number / 1000;
const memoryPercent = (used, sample, gpu) => {
  const total = value(sample, 2, gpu);
  return total ? used / total * 100 : null;
};
function timeLabel(time, duration) {
  const options = duration >= 86400000
    ? { weekday: 'short', hour: '2-digit', minute: '2-digit' }
    : { hour: '2-digit', minute: '2-digit', hour12: false };
  return new Intl.DateTimeFormat(undefined, options).format(new Date(time));
}

function Graph({ title, unit, color, rows, gpu, metric, transform, ceiling, endTime, interval }) {
  const [hover, setHover] = useState(null);
  const values = useMemo(() => rows.map(sample => {
    const raw = value(sample, metric, gpu);
    return raw == null ? null : transform(raw, sample, gpu);
  }), [rows, gpu, metric, transform]);
  const valid = values.filter(item => item != null && Number.isFinite(item));
  const top = Math.max(ceiling, Math.ceil(Math.max(0, ...valid) * 1.15 / 10) * 10);
  const plot = { left: 57, right: 690, top: 24, bottom: 178 };
  const x = index => plot.left + index / Math.max(1, values.length - 1) * (plot.right - plot.left);
  const y = item => plot.bottom - Math.min(top, Math.max(0, item)) / top * (plot.bottom - plot.top);
  const paths = [];
  let path = '';
  let previousIndex = -1;
  // PCP archives can be sampled every 10 seconds while a five-minute graph
  // uses one-second buckets. Join nearby samples, but retain real gaps.
  const gapLimit = Math.max(30, Math.ceil(60000 / interval));
  values.forEach((item, index) => {
    if (item == null || !Number.isFinite(item)) return;
    if (previousIndex >= 0 && index - previousIndex > gapLimit) {
      if (path) paths.push(path);
      path = '';
    }
    path += `${path ? ' L' : 'M'}${x(index).toFixed(1)} ${y(item).toFixed(1)}`;
    previousIndex = index;
  });
  if (path) paths.push(path);
  const duration = Math.max(0, values.length - 1) * interval;
  const hovered = hover == null ? null : values[hover];
  const hoverTime = endTime - (values.length - 1 - hover) * interval;
  return <section className="gpu-graph" aria-label={`${title} history`}>
    <div className="gpu-graph-title"><span className="gpu-unit">{unit}</span>{title}</div>
    <svg viewBox="0 0 710 210" preserveAspectRatio="none" role="img" aria-label={`${title} from ${timeLabel(endTime - duration, duration)} to ${timeLabel(endTime, duration)}`} onMouseLeave={() => setHover(null)} onMouseMove={event => {
      const bounds = event.currentTarget.getBoundingClientRect();
      const position = (event.clientX - bounds.left) / bounds.width * 710;
      setHover(Math.max(0, Math.min(values.length - 1, Math.round((position - plot.left) / (plot.right - plot.left) * (values.length - 1)))));
    }}>
      {[0, 1, 2].map(index => {
        const lineY = plot.top + index * (plot.bottom - plot.top) / 2;
        const label = top - index * top / 2;
        return <g key={index}><line className="gpu-grid-line" x1={plot.left} x2={plot.right} y1={lineY} y2={lineY} /><text className="gpu-axis-label" x={plot.left - 10} y={lineY + 5} textAnchor="end">{label}</text></g>;
      })}
      <line className="gpu-axis-edge" x1={plot.left} x2={plot.left} y1={plot.top} y2={plot.bottom} />
      {[0, 1, 2, 3, 4, 5].map(index => {
        const tickX = plot.left + index * (plot.right - plot.left) / 5;
        return <g key={index}><line className="gpu-axis-tick" x1={tickX} x2={tickX} y1={plot.bottom} y2={plot.bottom + 6} /><text className="gpu-axis-label" x={tickX} y="204" textAnchor="middle">{timeLabel(endTime - duration * (1 - index / 5), duration)}</text></g>;
      })}
      {paths.map((item, index) => item.includes(' L')
        ? <path key={index} d={item} fill="none" stroke={color} strokeWidth="2" vectorEffect="non-scaling-stroke" />
        : <circle key={index} cx={Number(item.slice(1).split(' ')[0])} cy={Number(item.split(' ')[1])} r="2" fill={color} />)}
      {hovered != null && Number.isFinite(hovered) && <g><line className="gpu-hover-line" x1={x(hover)} x2={x(hover)} y1={plot.top} y2={plot.bottom} /><circle cx={x(hover)} cy={y(hovered)} r="4" fill={color} /></g>}
    </svg>
    {hovered != null && Number.isFinite(hovered) && <div className="gpu-graph-tooltip" role="status">{timeLabel(hoverTime, duration)} · {hovered.toFixed(unit === '%' ? 0 : 1)} {unit}</div>}
  </section>;
}

export function App() {
  const [rangeIndex, setRangeIndex] = useState(0);
  const [offset, setOffset] = useState(0);
  const [gpu, setGpu] = useState(0);
  const live = useGpuMetrics(2000, 6, undefined);
  const range = RANGES[rangeIndex];
  const archive = useArchiveSource();
  const history = useGpuMetrics(range.interval, range.count, archive.path, archive.revision, offset);
  const current = latestSample(live.rows);
  const instances = live.instances.length ? live.instances : (current?.[0]?.map((_, index) => `gpu${index}`) || []);
  const selectedGpu = Math.min(gpu, Math.max(instances.length - 1, 0));
  const historyGpu = Math.max(0, history.instances.indexOf(instances[selectedGpu]));
  const step = range.count;
  return <main className="gpu-page">
    <div className="gpu-plot-controls" aria-label="Graph time controls">
      <select aria-label="Time range" value={rangeIndex} onChange={event => {
        if (event.target.value === 'now') setOffset(0);
        else { setRangeIndex(Number(event.target.value)); setOffset(0); }
      }}>
        <option value="now">Go to now</option>
        {RANGES.map((item, index) => <option key={item.label} value={index}>{item.label}</option>)}
      </select>
      <button type="button" onClick={() => { setRangeIndex(previous => Math.min(RANGES.length - 1, previous + 1)); setOffset(0); }} disabled={rangeIndex === RANGES.length - 1} title="Zoom out" aria-label="Zoom out"><svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="10" cy="10" r="6" /><path d="M7 10h6m1.5 4.5 6 6" /></svg></button>
      <button type="button" onClick={() => setOffset(previous => previous + step)} title="Earlier" aria-label="Earlier">‹</button>
      <button type="button" onClick={() => setOffset(previous => Math.max(0, previous - step))} disabled={offset === 0} title="Later" aria-label="Later">›</button>
    </div>
    <div className="gpu-graphs">
      <Graph title="GPU utilization" unit="%" color="var(--gpu-blue)" rows={history.rows} gpu={historyGpu} metric={0} transform={identity} ceiling={100} endTime={history.endTime} interval={range.interval} />
      <Graph title="VRAM occupied" unit="%" color="var(--gpu-teal)" rows={history.rows} gpu={historyGpu} metric={1} transform={memoryPercent} ceiling={100} endTime={history.endTime} interval={range.interval} />
      <Graph title="Temperature" unit="°C" color="var(--gpu-orange)" rows={history.rows} gpu={historyGpu} metric={3} transform={identity} ceiling={100} endTime={history.endTime} interval={range.interval} />
      <Graph title="Power draw" unit="W" color="var(--gpu-purple)" rows={history.rows} gpu={historyGpu} metric={4} transform={powerWatts} ceiling={600} endTime={history.endTime} interval={range.interval} />
    </div>
    <section className="gpu-devices">
      <h1>GPU</h1>
      {live.unavailable && !current && <div className="gpu-message" role="alert">GPU metrics are unavailable. Check that the PCP NVIDIA PMDA is enabled.</div>}
      {(history.unavailable || archive.error) && !history.ready && <div className="gpu-message" role="status">History will appear after the PCP logger records GPU samples.</div>}
      <div className="gpu-table-scroll"><table className="gpu-table">
        <thead><tr><th scope="col">GPU</th><th scope="col">Utilization</th><th scope="col">VRAM occupied</th><th scope="col">Temperature</th><th scope="col">Power draw</th></tr></thead>
        <tbody>{instances.length ? instances.map((name, index) => {
          const used = value(current, 1, index);
          const total = value(current, 2, index);
          return <tr key={name} className={selectedGpu === index ? 'is-selected' : ''}>
            <th scope="row"><button type="button" className="gpu-select-link" onClick={() => setGpu(index)} aria-pressed={selectedGpu === index}>{name}</button></th>
            <td>{reading(value(current, 0, index), '%')}</td>
            <td>{total == null ? bytes(used) : `${bytes(used)} / ${bytes(total)}`}</td>
            <td>{reading(value(current, 3, index), '°C')}</td>
            <td>{value(current, 4, index) == null ? '—' : `${(value(current, 4, index) / 1000).toFixed(1)} W`}</td>
          </tr>;
        }) : <tr><td colSpan="5">Waiting for GPU readings…</td></tr>}</tbody>
      </table></div>
      <p className="gpu-footnote">VRAM occupied includes driver-reserved memory.</p>
    </section>
  </main>;
}
