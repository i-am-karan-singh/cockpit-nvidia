import { useEffect, useState } from 'react';

const cockpit = window.cockpit;
const PROCESS_INTERVAL_MS = 5000;
const GPU_QUERY = ['nvidia-smi', '--query-gpu=index,uuid', '--format=csv,noheader,nounits'];
const PROCESS_QUERY = ['nvidia-smi', '--query-compute-apps=gpu_uuid,pid,process_name,used_gpu_memory', '--format=csv,noheader,nounits'];
const PMON = ['nvidia-smi', 'pmon', '-s', 'u', '-d', '5'];

function parseProcesses(output, gpuIndexes) {
  return output.split('\n').flatMap(line => {
    // The process name may contain commas, so match it from the final memory field.
    const match = line.match(/^\s*(GPU-[^,]+),\s*(\d+),\s*(.*),\s*([^,]+)\s*$/);
    if (!match) return [];
    const gpuIndex = gpuIndexes.get(match[1]);
    if (gpuIndex == null) return [];
    const memoryMiB = Number(match[4].trim());
    return [{ gpuIndex, pid: Number(match[2]), name: match[3].trim(),
      memoryMiB: Number.isFinite(memoryMiB) ? memoryMiB : null }];
  });
}

function parsePmon(line) {
  const fields = line.trim().split(/\s+/);
  if (!/^\d+$/.test(fields[0]) || !/^\d+$/.test(fields[1]) || fields.length < 10) return null;
  return { gpuIndex: Number(fields[0]), pid: Number(fields[1]), name: fields.slice(9).join(' '),
    activity: /^\d+$/.test(fields[3]) ? Number(fields[3]) : null, seen: Date.now() };
}

export function useGpuProcesses() {
  const [state, setState] = useState({ rows: [], loading: true, error: false, visible: !cockpit.hidden });

  useEffect(() => {
    let active = false;
    let timer;
    let indexRequest;
    let processRequest;
    let pmon;
    let pmonBuffer = '';
    let computeRows = [];
    let generation = 0;
    const monitored = new Map();

    const key = row => `${row.gpuIndex}:${row.pid}`;
    const publish = () => {
      if (!active) return;
      const now = Date.now();
      const combined = new Map(computeRows.map(row => [key(row), { ...row, activity: null }]));
      for (const [id, row] of monitored) {
        if (now - row.seen > 2 * PROCESS_INTERVAL_MS + 2000) { monitored.delete(id); continue; }
        combined.set(id, { ...row, ...combined.get(id), activity: row.activity });
      }
      const rows = [...combined.values()].sort((a, b) => (b.memoryMiB ?? -1) - (a.memoryMiB ?? -1) || a.pid - b.pid);
      setState({ rows, loading: false, error: false, visible: true });
    };

    const stop = (updateState = true) => {
      active = false;
      generation++;
      window.clearInterval(timer);
      indexRequest?.close();
      processRequest?.close();
      pmon?.close();
      indexRequest = processRequest = pmon = undefined;
      computeRows = [];
      monitored.clear();
      if (updateState) setState(previous => ({ ...previous, visible: false }));
    };

    const start = () => {
      if (active) return;
      active = true;
      const currentGeneration = ++generation;
      pmonBuffer = '';
      setState({ rows: [], loading: true, error: false, visible: true });
      indexRequest = cockpit.spawn(GPU_QUERY, { err: 'message' });
      indexRequest.then(output => {
        if (!active || generation !== currentGeneration) return;
        const gpuIndexes = new Map();
        for (const line of output.split('\n')) {
          const match = line.match(/^\s*(\d+),\s*(GPU-\S+)\s*$/);
          if (match) gpuIndexes.set(match[2], Number(match[1]));
        }
        const poll = () => {
          if (!active || generation !== currentGeneration || processRequest) return;
          const request = cockpit.spawn(PROCESS_QUERY, { err: 'message' });
          processRequest = request;
          request.then(result => {
            if (!active || generation !== currentGeneration) return;
            computeRows = parseProcesses(result, gpuIndexes);
            publish();
          }).catch(error => {
            if (active && generation === currentGeneration) { console.error('Could not read NVIDIA processes', error); setState(previous => ({ ...previous, loading: false, error: true })); }
          }).finally(() => { if (processRequest === request) processRequest = undefined; });
        };
        pmon = cockpit.spawn(PMON, { err: 'message' });
        pmon.stream(chunk => {
          if (!active || generation !== currentGeneration) return;
          pmonBuffer += chunk;
          const lines = pmonBuffer.split('\n');
          pmonBuffer = lines.pop();
          for (const line of lines) {
            const row = parsePmon(line);
            if (row) monitored.set(key(row), row);
          }
          publish();
        }).catch(error => { if (active && generation === currentGeneration) console.error('Could not sample NVIDIA process activity', error); });
        poll();
        timer = window.setInterval(poll, PROCESS_INTERVAL_MS);
      }).catch(error => {
        if (active && generation === currentGeneration) { console.error('Could not identify NVIDIA GPUs', error); setState({ rows: [], loading: false, error: true, visible: true }); }
      });
    };

    const visibilityChanged = () => { if (cockpit.hidden) stop(); else start(); };
    cockpit.addEventListener('visibilitychange', visibilityChanged);
    visibilityChanged();
    return () => { cockpit.removeEventListener('visibilitychange', visibilityChanged); stop(false); };
  }, []);

  return state;
}
