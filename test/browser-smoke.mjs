import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

const secret = fs.readFileSync('.localcred', 'utf8').trim();
const separator = secret.indexOf(':');
if (separator < 1) throw new Error('Expected user:password in .localcred');
const user = secret.slice(0, separator);
const password = secret.slice(separator + 1);
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'cockpit-nvidia-test-'));
const browser = spawn('/usr/bin/chromium', [
  '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
  '--ignore-certificate-errors', '--window-size=1440,1300',
  '--remote-debugging-port=0', `--user-data-dir=${profile}`, 'about:blank',
], { stdio: 'ignore' });
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
let ws;

async function waitFor(test, description, attempts = 200) {
  for (let i = 0; i < attempts; i++) {
    const result = await test();
    if (result) return result;
    await sleep(100);
  }
  throw new Error(`Timed out waiting for ${description}`);
}

try {
  const marker = path.join(profile, 'DevToolsActivePort');
  await waitFor(() => {
    if (browser.exitCode !== null) throw new Error('Chromium exited before startup');
    return fs.existsSync(marker);
  }, 'Chromium');
  const port = Number(fs.readFileSync(marker, 'utf8').split('\n')[0]);
  const targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
  const target = targets.find(item => item.type === 'page');
  if (!target) throw new Error('No browser page');
  ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
  let nextId = 0;
  const pending = new Map();
  ws.onmessage = event => {
    const message = JSON.parse(event.data);
    if (message.method === 'Runtime.exceptionThrown') console.log('browser exception', message.params.exceptionDetails.text);
    if (message.method === 'Runtime.consoleAPICalled' && message.params.type === 'error') console.log('browser error', message.params.args.map(arg => arg.value || arg.description));
    if (!message.id || !pending.has(message.id)) return;
    const slot = pending.get(message.id);
    pending.delete(message.id);
    message.error ? slot.reject(new Error(message.error.message)) : slot.resolve(message.result);
  };
  function cdp(method, params = {}) {
    const id = ++nextId;
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      ws.send(JSON.stringify({ id, method, params }));
    });
  }
  async function evaluate(expression) {
    const response = await cdp('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (response.exceptionDetails) throw new Error(response.exceptionDetails.text);
    return response.result.value;
  }
  const page = expression => evaluate(`(() => {
    const doc = document.querySelector('iframe[src*="/cockpit-nvidia/"]')?.contentDocument;
    if (!doc) return null;
    ${expression}
  })()`);

  await cdp('Page.enable');
  await cdp('Runtime.enable');
  await cdp('Page.navigate', { url: 'https://127.0.0.1:9090/' });
  await waitFor(() => evaluate('Boolean(document.querySelector("#login-user-input") && !document.querySelector("#login")?.hidden)').catch(() => false), 'login form');
  await evaluate(`(() => {
    const set = (selector, value) => {
      const input = document.querySelector(selector);
      input.value = value;
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
    };
    set('#login-user-input', ${JSON.stringify(user)});
    set('#login-password-input', ${JSON.stringify(password)});
    document.querySelector('#login-button').click();
  })()`);
  await waitFor(() => evaluate('location.pathname === "/system"'), 'authenticated Cockpit shell');
  const openedAt = Date.now();
  await cdp('Page.navigate', { url: 'https://127.0.0.1:9090/cockpit-nvidia' });
  await waitFor(() => page('return Boolean(doc.querySelector(".gpu-table tbody tr td")?.textContent?.includes("%") && doc.querySelectorAll(".ct-plot-paths path").length >= 4 && doc.querySelector("#zoom-control"));').catch(() => false), 'GPU live readings and archive charts');

  const archiveSample = await page(`return new Promise(resolve => {
    const channel = doc.defaultView.cockpit.channel({
      payload: 'metrics1', source: 'pcp-archive', interval: 10000,
      timestamp: ${openedAt - 60000}, limit: 4,
      metrics: [{ name: 'nvidia.temperature' }],
    });
    let done = false;
    const finish = result => {
      if (done) return;
      done = true;
      clearTimeout(timeout);
      channel.close();
      resolve(result);
    };
    const timeout = setTimeout(() => finish('timed out'), 10000);
    const hasNumber = value => typeof value === 'number' && Number.isFinite(value) ||
      Array.isArray(value) && value.some(hasNumber);
    channel.addEventListener('message', (_event, payload) => {
      const message = JSON.parse(payload);
      if (Array.isArray(message) && hasNumber(message)) finish('sample received');
    });
    channel.addEventListener('close', (_event, options) => finish(options.problem || 'no historical sample'));
  });`);
  if (archiveSample !== 'sample received') throw new Error(`PCP archive history failed: ${archiveSample}`);

  const readings = await page('return Array.from(doc.querySelectorAll(".gpu-devices .gpu-table tbody tr td"), item => item.textContent);');
  if (process.env.EXPECT_OLLAMA) {
    await waitFor(() => page('return Array.from(doc.querySelectorAll(".gpu-processes tbody tr"), row => row.textContent).some(text => text.includes("/usr/lib/ollama/llama-server") && text.includes("GiB"));'), 'full Ollama process path and memory');
    const ollamaPid = await page('return Array.from(doc.querySelectorAll(".gpu-processes tbody tr")).find(row => row.cells[0]?.textContent.includes("/usr/lib/ollama/llama-server"))?.cells[1]?.textContent;');
    for (let index = 0; index < 6; index++) {
      const name = await page(`return Array.from(doc.querySelectorAll(".gpu-processes tbody tr")).find(row => row.cells[1]?.textContent === ${JSON.stringify(ollamaPid)})?.cells[0]?.textContent;`);
      if (name && !name.includes('/usr/lib/ollama/llama-server')) throw new Error(`GPU process ${ollamaPid} was mislabeled as ${name}`);
      await sleep(1000);
    }
  }
  if (await page('return Boolean(Array.from(doc.querySelectorAll(".gpu-processes thead th"), cell => cell.textContent).includes("SM activity"));')) throw new Error('SM activity column is still visible');
  if (await page('return Boolean(doc.querySelector(".gpu-devices h1, .gpu-processes h1"));')) throw new Error('GPU table headings are still visible');
  if (process.env.EXPECT_OLLAMA) {
    const style = await page('const name = doc.querySelector(".gpu-process-path"); const css = getComputedStyle(name); return { decoration: css.textDecorationStyle, color: css.color };');
    if (style.decoration !== 'dotted') throw new Error(`Process path lacks dotted underline: ${JSON.stringify(style)}`);
  }
  const model = await page('return doc.querySelector(".gpu-table tbody th")?.textContent;');
  if (!model?.includes('RTX 5090')) throw new Error(`GPU model was not shown: ${model}`);
  const plots = await page('return Array.from(doc.querySelectorAll(".ct-plot"), plot => ({ unit: plot.querySelector(".ct-plot-unit")?.textContent, upper: Math.max(...Array.from(plot.querySelectorAll(".ct-plot-axis-y text"), tick => Number(tick.textContent))) }));');
  if (plots[1]?.unit !== 'GiB' || !Number.isFinite(plots[1]?.upper) || plots[1].upper <= 0) throw new Error(`VRAM plot is not scaled in GiB: ${JSON.stringify(plots[1])}`);
  if (!plots.every(plot => Number.isFinite(plot.upper) && plot.upper > 0)) throw new Error(`GPU axes are invalid: ${JSON.stringify(plots)}`);
  if (await page('return Boolean(doc.querySelector(".gpu-footnote"));')) throw new Error('VRAM footnote is still visible');
  await page('doc.defaultView.dispatchEvent(new CustomEvent("cockpit-style", { detail: { style: "dark" } })); return true;');
  const dark = await page('return doc.documentElement.classList.contains("pf-v6-theme-dark");');
  if (!dark) throw new Error('GPU page did not follow Cockpit dark theme');
  for (const label of ['1 hour', '6 hours', '1 day', '1 week', '5 minutes']) {
    await page('doc.querySelector("#zoom-control .pf-v6-c-menu-toggle").click(); return true;');
    await waitFor(() => page(`return Array.from(doc.querySelectorAll('[role=menuitem]')).some(item => item.textContent === ${JSON.stringify(label)});`).catch(() => false), `${label} menu item`);
    await page(`Array.from(doc.querySelectorAll('[role=menuitem]')).find(item => item.textContent === ${JSON.stringify(label)}).click(); return true;`);
    await waitFor(() => page(`return doc.querySelector('#zoom-control .pf-v6-c-menu-toggle')?.textContent === ${JSON.stringify(label)} && doc.querySelectorAll('.ct-plot').length === 4;`).catch(() => false), `${label} charts`);
  }
  await page('doc.querySelectorAll("#zoom-control > button")[2].click(); return true;');
  await waitFor(() => page('return !doc.querySelectorAll("#zoom-control > button")[3].disabled;'), 'earlier history');
  await page('doc.querySelector("#zoom-control .pf-v6-c-menu-toggle").click(); return true;');
  await waitFor(() => page('return Array.from(doc.querySelectorAll("[role=menuitem]")).some(item => item.textContent === "Go to now");'), 'Go to now menu item');
  await page('Array.from(doc.querySelectorAll("[role=menuitem]")).find(item => item.textContent === "Go to now").click(); return true;');
  await waitFor(() => page('return doc.querySelectorAll("#zoom-control > button")[3].disabled;'), 'return to live history');
  await waitFor(() => page('return doc.querySelectorAll(".ct-plot-paths path").length >= 4;'), 'restored live graphs');
  await waitFor(() => page('const d = doc.querySelectorAll(".ct-plot-paths path")[2]?.getAttribute("d"); return d && Array.from(d.matchAll(/L\\d+,(\\d+)/g)).filter(match => Number(match[1]) < 120).length > 200;'), 'temperature trace after navigation');

  const screenshot = await cdp('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
  const screenshotPath = process.env.SCREENSHOT || '/tmp/cockpit-nvidia-smoke.png';
  fs.writeFileSync(screenshotPath, Buffer.from(screenshot.data, 'base64'));
  const paths = await page('return Array.from(doc.querySelectorAll(".ct-plot-paths path"), item => ({ length: item.getAttribute("d").length, fill: getComputedStyle(item).fill }));');
  console.log(JSON.stringify({ result: 'pass', model, readings, plots, dark, paths, screenshot: screenshotPath }));
  if (process.env.CHECK_PROCESS_VISIBILITY) {
    const opened = await evaluate('document.querySelector(\'iframe[src*="/cockpit-nvidia/"]\')?.contentWindow?.cockpit?.hidden');
    if (opened !== false) throw new Error(`GPU page was unexpectedly hidden: ${opened}`);
    await evaluate('Array.from(document.querySelectorAll("a")).find(link => link.textContent?.trim() === "Storage")?.click();');
    await waitFor(() => evaluate('location.pathname === "/storage"'), 'Storage navigation');
    const hidden = await evaluate('document.querySelector(\'iframe[src*="/cockpit-nvidia/"]\')?.contentWindow?.cockpit?.hidden ?? true');
    if (hidden !== true) throw new Error('GPU page stayed visible after navigating away');
    await evaluate('Array.from(document.querySelectorAll("a")).find(link => link.textContent?.trim() === "GPU")?.click();');
    await waitFor(() => evaluate('location.pathname === "/cockpit-nvidia"'), 'return to GPU page');
    const returned = await page('return { process: doc.querySelector(".gpu-processes tbody")?.textContent || "", busy: doc.querySelector(".gpu-processes tbody")?.getAttribute("aria-busy") };');
    if (process.env.EXPECT_OLLAMA && (!returned?.process.includes('/usr/lib/ollama/llama-server') || returned.busy !== 'false')) {
      throw new Error(`GPU process row was not retained on return: ${JSON.stringify(returned)}`);
    }
    console.log(JSON.stringify({ result: 'pass', gpuPageHiddenAfterNavigation: hidden, retainedProcessOnReturn: returned?.process.includes('/usr/lib/ollama/llama-server') || false }));
  }
} finally {
  ws?.close();
  browser.kill();
  fs.rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
