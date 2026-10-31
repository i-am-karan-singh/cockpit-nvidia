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
  await cdp('Page.navigate', { url: 'https://127.0.0.1:9090/cockpit-nvidia' });
  await waitFor(() => page('return doc.querySelector(".gpu-table tbody tr td")?.textContent?.includes("%") && doc.querySelectorAll(".gpu-graph svg path").length >= 4;').catch(() => false), 'GPU live readings and archive charts');

  const readings = await page('return Array.from(doc.querySelectorAll(".gpu-table tbody tr td"), item => item.textContent);');
  await page('doc.defaultView.dispatchEvent(new CustomEvent("cockpit-style", { detail: { style: "dark" } })); return true;');
  const dark = await page('return doc.documentElement.classList.contains("pf-v6-theme-dark");');
  if (!dark) throw new Error('GPU page did not follow Cockpit dark theme');
  for (const [index, label] of ['1 hour', '6 hours', '1 day', '1 week', '5 minutes'].entries()) {
    await page(`const select = doc.querySelector('.gpu-plot-controls select'); select.value = ${index === 4 ? 0 : index + 1}; select.dispatchEvent(new Event('change', { bubbles: true })); return true;`);
    await waitFor(() => page(`return doc.querySelector('.gpu-plot-controls select')?.selectedOptions[0]?.textContent === ${JSON.stringify(label)} && doc.querySelectorAll('.gpu-graph').length === 4;`).catch(() => false), `${label} charts`);
  }
  await page('doc.querySelector("button[aria-label=Earlier]").click(); return true;');
  await waitFor(() => page('return !doc.querySelector("button[aria-label=Later]").disabled;'), 'earlier history');
  await waitFor(() => page('return doc.querySelectorAll(".gpu-graph svg path").length >= 4;'), 'earlier history graphs');
  await page('const select = doc.querySelector(".gpu-plot-controls select"); select.value = "now"; select.dispatchEvent(new Event("change", { bubbles: true })); return true;');
  await waitFor(() => page('return doc.querySelector("button[aria-label=Later]").disabled;'), 'Go to now');
  await page('doc.querySelector("button[aria-label=Earlier]").click(); return true;');
  await waitFor(() => page('return !doc.querySelector("button[aria-label=Later]").disabled;'), 'earlier history again');
  await page('doc.querySelector("button[aria-label=Later]").click(); return true;');
  await waitFor(() => page('return doc.querySelector("button[aria-label=Later]").disabled;'), 'return to live history');
  await waitFor(() => page('return doc.querySelectorAll(".gpu-graph svg path").length >= 4;'), 'restored live graphs');
  const before = await page('return doc.querySelector(".gpu-graph svg path")?.getAttribute("d");');
  await sleep(2500);
  const after = await page('return doc.querySelector(".gpu-graph svg path")?.getAttribute("d");');
  if (before === after) throw new Error('Live graph did not advance');

  const screenshot = await cdp('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
  const screenshotPath = process.env.SCREENSHOT || '/tmp/cockpit-nvidia-smoke.png';
  fs.writeFileSync(screenshotPath, Buffer.from(screenshot.data, 'base64'));
  const paths = await page('return Array.from(doc.querySelectorAll(".gpu-graph svg path"), item => ({ length: item.getAttribute("d").length, stroke: getComputedStyle(item).stroke }));');
  console.log(JSON.stringify({ result: 'pass', readings, dark, paths, screenshot: screenshotPath }));
} finally {
  ws?.close();
  browser.kill();
  fs.rmSync(profile, { recursive: true, force: true });
}
