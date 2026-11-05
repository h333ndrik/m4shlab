import assert from 'node:assert/strict';
import {existsSync, mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawn} from 'node:child_process';

const projectRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const port = Number(process.env.HEADER_TEST_PORT || 4184);
const baseUrl = `http://127.0.0.1:${port}/`;
const BASELINE_WORDMARK_PX = 15;
const MIN_GROWTH = 1.25;
const MAX_GROWTH = 1.4;
const CLS_BUDGET = 0.1;
const HEIGHT_TOLERANCE = 2;
const chromeCandidates = [
  process.env.CHROME_BIN,
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome',
  '/usr/bin/google-chrome-stable',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
].filter(Boolean);
let server = null;
let chrome = null;
let client = null;

function skip(message) {
  console.log(`SKIP header contract: ${message}`);
  client?.close();
  chrome?.process.kill('SIGTERM');
  server?.kill('SIGTERM');
  process.exit(0);
}

class CdpClient {
  constructor(url) {
    this.socket = new WebSocket(url);
    this.nextId = 0;
    this.pending = new Map();
    this.exceptions = [];
    this.socket.onmessage = event => {
      const message = JSON.parse(event.data);
      if (message.id) {
        const pending = this.pending.get(message.id);
        if (!pending) return;
        this.pending.delete(message.id);
        if (message.error) pending.reject(new Error(message.error.message));
        else pending.resolve(message.result);
      } else if (message.method === 'Runtime.exceptionThrown') {
        this.exceptions.push(message.params.exceptionDetails.exception?.description ?? message.params.exceptionDetails.text);
      }
    };
  }
  open() {
    if (this.socket.readyState === WebSocket.OPEN) return Promise.resolve();
    return new Promise((resolveOpen, rejectOpen) => {
      this.socket.onopen = resolveOpen;
      this.socket.onerror = rejectOpen;
    });
  }
  send(method, params = {}) {
    const id = ++this.nextId;
    this.socket.send(JSON.stringify({id, method, params}));
    return new Promise((resolveSend, rejectSend) => this.pending.set(id, {resolve: resolveSend, reject: rejectSend}));
  }
  async evaluate(expression) {
    const response = await this.send('Runtime.evaluate', {expression, awaitPromise: true, returnByValue: true});
    if (response.exceptionDetails) throw new Error(response.exceptionDetails.exception?.description ?? response.exceptionDetails.text);
    return response.result.value;
  }
  async waitFor(expression, timeout = 15000) {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      if (await this.evaluate(expression).catch(() => false)) return;
      await new Promise(resolveWait => setTimeout(resolveWait, 100));
    }
    throw new Error(`Timeout waiting for ${expression}`);
  }
  close() {
    this.socket.close();
  }
}

async function launchChrome() {
  const binary = chromeCandidates.find(candidate => existsSync(candidate));
  if (!binary) return null;
  const profile = mkdtempSync(join(tmpdir(), 'm4shlab-header-'));
  const process = spawn(binary, [
    '--headless=new',
    '--remote-debugging-port=0',
    `--user-data-dir=${profile}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-gpu',
    'about:blank',
  ], {stdio: ['ignore', 'ignore', 'pipe']});
  const endpoint = await new Promise((resolveEndpoint, rejectEndpoint) => {
    let stderr = '';
    const timer = setTimeout(() => {
      process.kill('SIGTERM');
      rejectEndpoint(new Error(`Chrome did not expose CDP within 15 seconds: ${stderr}`));
    }, 15000);
    process.stderr.on('data', chunk => {
      stderr += chunk.toString();
      const match = /DevTools listening on (ws:\/\/[^\s]+)/.exec(stderr);
      if (!match) return;
      clearTimeout(timer);
      resolveEndpoint(match[1]);
    });
    process.once('exit', code => {
      clearTimeout(timer);
      rejectEndpoint(new Error(`Chrome exited before CDP was ready (${code}): ${stderr}`));
    });
  });
  return {process, profile, endpoint};
}

async function pageTarget(endpoint) {
  const debugUrl = new URL(endpoint);
  const targets = await (await fetch(`http://${debugUrl.host}/json/list`)).json();
  const target = targets.find(item => item.type === 'page');
  if (!target) throw new Error('Chrome has no page target');
  const connection = new CdpClient(target.webSocketDebuggerUrl);
  await connection.open();
  return connection;
}

const measurement = `(() => {
  const header = document.querySelector('header');
  const wordmark = header.querySelector('h1');
  const tagline = header.querySelector('p');
  const button = header.querySelector('.file-actions .button');
  const headerStyle = getComputedStyle(header);
  const wordmarkStyle = getComputedStyle(wordmark);
  const buttonStyle = getComputedStyle(button);
  const box = element => element.getBoundingClientRect();
  return {
    viewport: window.innerWidth,
    headerHeight: box(header).height,
    padTop: parseFloat(headerStyle.paddingTop),
    padBottom: parseFloat(headerStyle.paddingBottom),
    headerGap: parseFloat(headerStyle.gap || headerStyle.columnGap),
    headerMarginBottom: parseFloat(headerStyle.marginBottom),
    wordmarkSize: parseFloat(wordmarkStyle.fontSize),
    wordmarkLineHeight: parseFloat(wordmarkStyle.lineHeight),
    wordmarkHeight: box(wordmark).height,
    wordmarkWidth: box(wordmark).width,
    wordmarkLetterSpacing: wordmarkStyle.letterSpacing,
    wordmarkWeight: wordmarkStyle.fontWeight,
    taglinePresent: tagline !== null,
    taglineSize: tagline ? parseFloat(getComputedStyle(tagline).fontSize) : null,
    buttonFontSize: parseFloat(buttonStyle.fontSize),
    buttonHeight: box(button).height,
    buttonWidth: box(button).width,
    minHeight: parseFloat(headerStyle.minHeight) || 0,
    scrollWidth: document.documentElement.scrollWidth,
    clientWidth: document.documentElement.clientWidth,
    cls: Number(window.__headerCls ?? 0),
  };
})()`;

if (typeof WebSocket !== 'function') skip('this Node version has no built-in WebSocket client; run with Node 22+.');
const started = Date.now();
server = spawn(process.execPath, ['scripts/serve.mjs'], {
  cwd: projectRoot,
  env: {...process.env, PORT: String(port)},
  stdio: 'ignore',
});
chrome = await launchChrome();
if (!chrome) skip('Chrome/Chromium was not found. Set CHROME_BIN to run this test.');

try {
  client = await pageTarget(chrome.endpoint);
  await client.send('Page.enable');
  await client.send('Runtime.enable');
  await client.send('Page.addScriptToEvaluateOnNewDocument', {
    source: `window.__headerCls = 0;
      try {
        new PerformanceObserver(list => {
          for (const entry of list.getEntries()) {
            if (!entry.hadRecentInput) window.__headerCls += entry.value;
          }
        }).observe({type: 'layout-shift', buffered: true});
      } catch {}`,
  });

  const results = [];
  for (const width of [1440, 1024, 390, 320]) {
    await client.send('Emulation.setDeviceMetricsOverride', {width, height: 900, deviceScaleFactor: 1, mobile: width < 600});
    await client.send('Page.navigate', {url: `${baseUrl}?header-contract=${width}`});
    await client.waitFor("document.documentElement.dataset.appReady === 'true'");
    const beforeFonts = await client.evaluate("document.querySelector('header').getBoundingClientRect().height");
    await client.evaluate("document.fonts.ready.then(() => true)");
    await new Promise(resolveWait => setTimeout(resolveWait, 250));
    const state = await client.evaluate(measurement);
    state.heightBeforeFonts = beforeFonts;
    results.push(state);

    assert.equal(state.scrollWidth, state.clientWidth, `${width}px: horizontal overflow ${state.scrollWidth} > ${state.clientWidth}`);
    assert.ok(state.width !== 0);
    assert.ok(Math.abs(state.heightBeforeFonts - state.headerHeight) <= HEIGHT_TOLERANCE, `${width}px: header height moved ${state.heightBeforeFonts} -> ${state.headerHeight} across font load`);
    assert.ok(state.cls <= CLS_BUDGET, `${width}px: CLS ${state.cls} exceeds budget ${CLS_BUDGET}`);
    const content = Math.max(state.wordmarkHeight, state.buttonHeight);
    const expected = Math.max(state.minHeight, state.padTop + state.padBottom + content);
    assert.ok(Math.abs(expected - state.headerHeight) <= HEIGHT_TOLERANCE, `${width}px: header height ${state.headerHeight} != computed ${expected} (padding ${state.padTop}+${state.padBottom}, content ${content})`);
    assert.ok(state.wordmarkLetterSpacing === 'normal' || Math.abs(parseFloat(state.wordmarkLetterSpacing)) <= 0.5, `${width}px: wordmark letter-spacing drifted to ${state.wordmarkLetterSpacing}`);
  }

  const desktop = results.find(item => item.viewport === 1440);
  const growth = desktop.wordmarkSize / BASELINE_WORDMARK_PX;
  assert.ok(desktop.wordmarkSize > BASELINE_WORDMARK_PX, `wordmark ${desktop.wordmarkSize}px is not larger than the 15px baseline`);
  assert.ok(growth >= MIN_GROWTH && growth <= MAX_GROWTH, `wordmark growth ${(growth * 100).toFixed(1)}% is outside the 125-140% corridor`);
  console.log(`PASS wordmark at 1440 is ${desktop.wordmarkSize.toFixed(2)}px, ${(growth * 100).toFixed(1)}% over the 15px baseline (corridor 125-140%)`);

  await client.send('Emulation.setDeviceMetricsOverride', {width: 1440, height: 900, deviceScaleFactor: 1, mobile: false});
  await client.send('Page.navigate', {url: `${baseUrl}?header-decoupling=1`});
  await client.waitFor("document.documentElement.dataset.appReady === 'true'");
  const decoupling = await client.evaluate(`(() => {
    const header = document.querySelector('header');
    const wordmark = header.querySelector('h1');
    const button = header.querySelector('.file-actions .button');
    const tagline = header.querySelector('p');
    const before = {tagline: tagline ? getComputedStyle(tagline).fontSize : null, button: getComputedStyle(button).fontSize};
    document.documentElement.style.setProperty('--header-wordmark-size', '40px');
    const after = {
      tagline: tagline ? getComputedStyle(tagline).fontSize : null,
      button: getComputedStyle(button).fontSize,
      wordmark: getComputedStyle(wordmark).fontSize,
    };
    const taglineToken = getComputedStyle(document.documentElement).getPropertyValue('--header-tagline-size').trim();
    document.documentElement.style.removeProperty('--header-wordmark-size');
    return {before, after, taglineToken, hasTagline: tagline !== null};
  })()`);
  assert.equal(decoupling.after.wordmark, '40px');
  assert.equal(decoupling.before.button, decoupling.after.button, 'the wordmark token must not resize neighbouring header text');
  assert.equal(decoupling.hasTagline, false, 'this shell has no tagline element; the tagline token stays independent');
  assert.equal(decoupling.before.tagline, decoupling.after.tagline);
  console.log(`PASS changing --header-wordmark-size to 40px leaves the tagline token (${decoupling.taglineToken}) and the import control font (${decoupling.after.button}) untouched`);

  await client.send('Emulation.setDeviceMetricsOverride', {width: 390, height: 900, deviceScaleFactor: 1, mobile: true});
  await client.send('Emulation.setTouchEmulationEnabled', {enabled: true, maxTouchPoints: 5});
  await client.send('Page.navigate', {url: `${baseUrl}?header-touch=1`});
  await client.waitFor("document.documentElement.dataset.appReady === 'true'");
  const touch = await client.evaluate(measurement);
  assert.equal(touch.scrollWidth, touch.clientWidth);
  assert.ok(touch.buttonHeight >= 44, `coarse pointer import control is ${touch.buttonHeight}px tall, expected >= 44`);
  assert.ok(touch.headerHeight >= touch.buttonHeight, 'the header must contain its tallest touch target');
  await client.send('Emulation.setTouchEmulationEnabled', {enabled: false, maxTouchPoints: 1});
  console.log(`PASS coarse pointer: header ${touch.headerHeight}px tall with a ${touch.buttonHeight}px touch target and no overflow`);

  const elapsed = ((Date.now() - started) / 1000).toFixed(1);
  assert.ok(Number(elapsed) < 60, `header contract took ${elapsed}s, budget is 60s`);
  console.log(`PASS header contract completed in ${elapsed}s: ${results.map(item => `${item.viewport}px/${item.headerHeight.toFixed(2)}px`).join(' ')}`);
  if (client.exceptions.length) throw new Error(`Browser exceptions:\n${client.exceptions.join('\n')}`);
} finally {
  client?.close();
  chrome?.process.kill('SIGTERM');
  server?.kill('SIGTERM');
  await new Promise(resolveWait => setTimeout(resolveWait, 250));
  if (chrome?.profile) {
    try {
      rmSync(chrome.profile, {recursive: true, force: true, maxRetries: 5, retryDelay: 100});
    } catch {}
  }
}
