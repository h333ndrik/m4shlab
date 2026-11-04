import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawn, spawnSync} from 'node:child_process';
import {parseMp4} from '../parser/mp4.js';

const projectRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const port = 4184;
const baseUrl = `http://127.0.0.1:${port}/`;
const downloadDir = join(projectRoot, 'testmedia', 'pwa-browser-downloads');
const exportPath = join(downloadDir, 'm4shlab-merge.mp4');
const hevcFixture = join(projectRoot, 'testmedia', 'synthetic-hevc.mov');
const shellPaths = [
  '/', '/index.html', '/styles.css', '/app.js',
  '/parser/mp4.js', '/parser/nal.js', '/parser/sps.js', '/parser/hevc.js',
  '/merge.js', '/mosh.js', '/webcodecs.js', '/webcodecs-muxer.js',
  '/converter.js', '/conversion-settings.js', '/classic-mosh.js', '/speed.js', '/looks.js', '/randomize.js', '/audio.js', '/hybrid-encoder.js',
  '/manifest.json', '/favicon.svg', '/favicon-32.png', '/icon.svg', '/icon-192.png', '/icon-512.png', '/icon-180.png',
];
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
  console.log(`SKIP PWA browser test: ${message}`);
  client?.close();
  chrome?.process.kill('SIGTERM');
  server?.kill('SIGTERM');
  process.exit(0);
}

function command(program, args, label) {
  const result = spawnSync(program, args, {cwd: projectRoot, encoding: 'utf8'});
  if (result.error) throw new Error(`${label} could not start: ${result.error.message}`);
  if (result.status !== 0) throw new Error(`${label} failed (${result.status}):\n${result.stderr || result.stdout}`);
  return result;
}

function pngDimensions(bytes) {
  assert.equal(bytes.subarray(0, 8).toString('hex'), '89504e470d0a1a0a', 'PNG signature');
  return {width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20)};
}

async function waitForDownload(path, timeout = 15000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (existsSync(path) && readFileSync(path).byteLength > 0) return;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(`Download did not appear: ${path}`);
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

  async open() {
    if (this.socket.readyState === WebSocket.OPEN) return;
    await new Promise((resolve, reject) => {
      this.socket.onopen = resolve;
      this.socket.onerror = reject;
    });
  }

  send(method, params = {}) {
    const id = ++this.nextId;
    this.socket.send(JSON.stringify({id, method, params}));
    return new Promise((resolve, reject) => this.pending.set(id, {resolve, reject}));
  }

  async evaluate(expression) {
    const response = await this.send('Runtime.evaluate', {expression, awaitPromise: true, returnByValue: true});
    if (response.exceptionDetails) throw new Error(response.exceptionDetails.exception?.description ?? response.exceptionDetails.text);
    return response.result.value;
  }

  async setFile(selector, path) {
    const response = await this.send('Runtime.evaluate', {expression: `document.querySelector(${JSON.stringify(selector)})`});
    await this.send('DOM.setFileInputFiles', {objectId: response.result.objectId, files: [path]});
  }

  async waitFor(expression, timeout = 120000) {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      if (await this.evaluate(expression)) return;
      await new Promise(resolve => setTimeout(resolve, 200));
    }
    const state = await this.evaluate(`({
      status: document.querySelector('#status')?.textContent,
      error: document.querySelector('#error')?.textContent,
      conversion: document.querySelector('#conversion-message')?.textContent,
      controller: navigator.serviceWorker?.controller?.state ?? null
    })`);
    throw new Error(`Timeout waiting for ${expression}: ${JSON.stringify(state)}`);
  }

  close() {
    this.socket.close();
  }
}

async function launchChrome() {
  const chromePath = chromeCandidates.find(candidate => existsSync(candidate));
  if (!chromePath) return null;
  const profile = mkdtempSync(join(tmpdir(), 'm4shlab-pwa-'));
  const process = spawn(chromePath, [
    '--headless=new',
    '--remote-debugging-port=0',
    `--user-data-dir=${profile}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-gpu',
    'about:blank',
  ], {stdio: ['ignore', 'ignore', 'pipe']});
  const endpoint = await new Promise((resolve, reject) => {
    let stderr = '';
    const timer = setTimeout(() => {
      process.kill('SIGTERM');
      reject(new Error(`Chrome did not expose CDP within 15 seconds: ${stderr}`));
    }, 15000);
    process.stderr.on('data', chunk => {
      stderr += chunk.toString();
      const match = /DevTools listening on (ws:\/\/[^\s]+)/.exec(stderr);
      if (!match) return;
      clearTimeout(timer);
      resolve(match[1]);
    });
    process.once('exit', code => {
      clearTimeout(timer);
      reject(new Error(`Chrome exited before CDP was ready (${code}): ${stderr}`));
    });
  });
  return {process, profile, endpoint};
}

async function pageTarget(endpoint) {
  const debugUrl = new URL(endpoint);
  const targets = await (await fetch(`http://${debugUrl.host}/json/list`)).json();
  const target = targets.find(item => item.type === 'page');
  if (!target) throw new Error('Chrome has no page target');
  const targetClient = new CdpClient(target.webSocketDebuggerUrl);
  await targetClient.open();
  return targetClient;
}

if (!existsSync(hevcFixture)) command('bash', ['testmedia/generate.sh'], 'fixture generation');

server = spawn(process.execPath, ['scripts/serve.mjs'], {
  cwd: projectRoot,
  env: {...process.env, PORT: String(port)},
  stdio: 'ignore',
});

try {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    try {
      if ((await fetch(baseUrl)).ok) break;
    } catch {
      await new Promise(resolve => setTimeout(resolve, 100));
    }
  }

  const manifestResponse = await fetch(new URL('manifest.json', baseUrl));
  assert.equal(manifestResponse.status, 200);
  assert.match(manifestResponse.headers.get('content-type') ?? '', /application\/json/);
  const manifest = await manifestResponse.json();
  assert.equal(manifest.name, 'm4shlab');
  assert.equal(manifest.short_name, 'm4shlab');
  assert.equal(manifest.display, 'standalone');
  assert.equal(manifest.theme_color, '#f5f5f3');
  assert.equal(manifest.background_color, '#f5f5f3');
  assert.equal(manifest.start_url, './');
  assert.equal(manifest.icons.length, 3);
  assert.ok(manifest.icons.some(icon => icon.type === 'image/svg+xml' && icon.sizes === 'any'));
  assert.ok(manifest.icons.some(icon => icon.sizes === '192x192' && icon.type === 'image/png'));
  assert.ok(manifest.icons.some(icon => icon.sizes === '512x512' && icon.type === 'image/png' && icon.purpose === 'maskable'));
  for (const icon of manifest.icons) {
    const response = await fetch(new URL(icon.src, baseUrl));
    assert.equal(response.status, 200, `manifest icon did not resolve: ${icon.src}`);
    assert.match(response.headers.get('content-type') ?? '', icon.type === 'image/svg+xml' ? /image\/svg\+xml/ : /image\/png/);
  }
  const indexResponse = await fetch(baseUrl);
  const indexHtml = await indexResponse.text();
  assert.match(indexHtml, /<link rel="icon" href="favicon\.svg" type="image\/svg\+xml">/);
  assert.match(indexHtml, /<link rel="icon" href="favicon-32\.png" sizes="32x32" type="image\/png">/);
  assert.match(indexHtml, /<link rel="apple-touch-icon" sizes="180x180" href="icon-180\.png">/);
  assert.doesNotMatch(indexHtml, /<link rel="icon" href="icon\.svg"/, 'stale tab icon link');
  assert.deepEqual(pngDimensions(readFileSync(join(projectRoot, 'favicon-32.png'))), {width: 32, height: 32});
  assert.deepEqual(pngDimensions(readFileSync(join(projectRoot, 'icon-192.png'))), {width: 192, height: 192});
  assert.deepEqual(pngDimensions(readFileSync(join(projectRoot, 'icon-512.png'))), {width: 512, height: 512});
  assert.deepEqual(pngDimensions(readFileSync(join(projectRoot, 'icon-180.png'))), {width: 180, height: 180});
  console.log('PASS manifest is valid with standalone display, light theme, resolving SVG/192/512-maskable icons, and favicon plus 180px Apple links');

  chrome = await launchChrome();
  if (!chrome) skip('Chrome/Chromium was not found. Set CHROME_BIN to run this test.');
  client = await pageTarget(chrome.endpoint);
  await client.send('Page.enable');
  await client.send('Runtime.enable');
  await client.send('DOM.enable');
  await client.send('Network.enable');
  await client.send('Emulation.setDeviceMetricsOverride', {width: 1200, height: 1600, deviceScaleFactor: 1, mobile: false});
  await client.send('Browser.setDownloadBehavior', {behavior: 'allow', downloadPath: downloadDir, eventsEnabled: true});
  await client.send('Page.addScriptToEvaluateOnNewDocument', {
    source: "window.__installPromptAvailable = false; window.addEventListener('beforeinstallprompt', event => { event.preventDefault(); window.__installPromptAvailable = true; });",
  });
  await client.send('Page.navigate', {url: baseUrl});
  await client.waitFor("document.documentElement.dataset.appReady === 'true'", 15000);
  await client.waitFor("navigator.serviceWorker?.controller?.state === 'activated'", 20000);

  const pwaState = await client.evaluate(`(async () => {
    const registration = await navigator.serviceWorker.ready;
    const cache = await caches.open('m4shlab-v19');
    return {
      manifestHref: document.querySelector('link[rel="manifest"]')?.getAttribute('href'),
      themeColor: document.querySelector('meta[name="theme-color"]')?.content,
      appleCapable: document.querySelector('meta[name="apple-mobile-web-app-capable"]')?.content,
      appleIcon: document.querySelector('link[rel="apple-touch-icon"]')?.getAttribute('href'),
      scope: registration.scope,
      workerState: registration.active?.state,
      controllerState: navigator.serviceWorker.controller?.state,
      cacheKeys: (await cache.keys()).map(request => new URL(request.url).pathname),
      installPromptAvailable: window.__installPromptAvailable,
    };
  })()`);
  assert.equal(pwaState.manifestHref, 'manifest.json');
  assert.equal(pwaState.themeColor, '#f5f5f3');
  assert.equal(pwaState.appleCapable, 'yes');
  assert.equal(pwaState.appleIcon, 'icon-180.png');
  assert.equal(pwaState.workerState, 'activated');
  assert.equal(pwaState.controllerState, 'activated');
  for (const path of shellPaths) assert.ok(pwaState.cacheKeys.includes(path), `missing precached shell asset ${path}`);
  assert.ok(!pwaState.cacheKeys.includes('/converter-worker.js'), 'conversion worker must not be precached');
  assert.ok(!pwaState.cacheKeys.some(path => path.includes('/@ffmpeg/core@')), 'ffmpeg core must not be precached');

  const wordmarkGeometry = await client.evaluate(`(async () => {
    async function measure(path) {
      const source = await (await fetch(path)).text();
      const parsed = new DOMParser().parseFromString(source, 'image/svg+xml');
      const svg = document.importNode(parsed.documentElement, true);
      svg.style.cssText = 'position:fixed;left:-2000px;top:0';
      document.body.append(svg);
      const box = svg.querySelector('text').getBBox();
      const result = {
        x: box.x,
        y: box.y,
        width: box.width,
        height: box.height,
        viewWidth: svg.viewBox.baseVal.width,
        viewHeight: svg.viewBox.baseVal.height,
      };
      svg.remove();
      return result;
    }
    const favicon = await measure('favicon.svg');
    const maskable = await measure('icon.svg');
    const center = maskable.viewWidth / 2;
    const sx = Math.abs(maskable.x - center);
    const sy = Math.abs(maskable.y - center);
    const ex = Math.abs(maskable.x + maskable.width - center);
    const ey = Math.abs(maskable.y + maskable.height - center);
    return {
      favicon,
      maskable,
      maxCornerDistance: Math.max(
        Math.hypot(sx, sy),
        Math.hypot(ex, sy),
        Math.hypot(sx, ey),
        Math.hypot(ex, ey),
      ),
      safeRadius: maskable.viewWidth * 0.4,
    };
  })()`);
  assert.ok(wordmarkGeometry.favicon.x >= 0 && wordmarkGeometry.favicon.y >= 0);
  assert.ok(wordmarkGeometry.favicon.x + wordmarkGeometry.favicon.width <= wordmarkGeometry.favicon.viewWidth);
  assert.ok(wordmarkGeometry.favicon.y + wordmarkGeometry.favicon.height <= wordmarkGeometry.favicon.viewHeight);
  assert.ok(wordmarkGeometry.maxCornerDistance <= wordmarkGeometry.safeRadius, `maskable wordmark exceeded safe circle: ${JSON.stringify(wordmarkGeometry)}`);
  console.log(`INFO wordmark geometry: favicon ${wordmarkGeometry.favicon.width.toFixed(1)}×${wordmarkGeometry.favicon.height.toFixed(1)} inside 32×32; maskable corner ${wordmarkGeometry.maxCornerDistance.toFixed(1)}px <= ${wordmarkGeometry.safeRadius.toFixed(1)}px safe radius`);

  const manifestInfo = await client.send('Page.getAppManifest');
  assert.deepEqual(manifestInfo.errors, [], `Manifest errors: ${JSON.stringify(manifestInfo.errors)}`);
  let installabilityErrors = [];
  try {
    installabilityErrors = (await client.send('Page.getInstallabilityErrors')).installabilityErrors;
  } catch (cause) {
    console.log(`INFO Page.getInstallabilityErrors unavailable: ${cause.message}`);
  }
  assert.deepEqual(installabilityErrors, [], `Installability errors: ${JSON.stringify(installabilityErrors)}`);
  console.log(`PASS service worker registered, controlled the page, precached ${shellPaths.length} shell assets, and Chrome reports no manifest/installability errors; beforeinstallprompt observed=${pwaState.installPromptAvailable}`);

  await client.evaluate(`(async () => {
    const old = await caches.open('m4shlab-v10');
    await old.put('/old-shell.txt', new Response('old shell'));
    const oldRuntime = await caches.open('m4shlab-runtime-v10');
    await oldRuntime.put('/old-worker.js', new Response('old worker'));
    const registration = await navigator.serviceWorker.getRegistration();
    await registration.unregister();
  })()`);
  await client.send('Page.reload', {ignoreCache: false});
  await client.waitFor("document.documentElement.dataset.appReady === 'true'", 15000);
  await client.waitFor("navigator.serviceWorker?.controller?.state === 'activated'", 20000);
  const cacheNames = await client.evaluate('caches.keys()');
  assert.ok(cacheNames.includes('m4shlab-v19'));
  assert.ok(!cacheNames.includes('m4shlab-v10'), 'old shell cache must be deleted on activate');
  assert.ok(!cacheNames.includes('m4shlab-runtime-v10'), 'old runtime cache must be deleted on activate');
  console.log('PASS activate cleanup removed the old versioned cache and re-registered the current shell');

  const cdnCheck = await fetch('https://cdn.jsdelivr.net/npm/@ffmpeg/core@0.12.10/dist/esm/ffmpeg-core.js', {method: 'HEAD'});
  if (!cdnCheck.ok) skip(`ffmpeg.wasm assets are unavailable (${cdnCheck.status}); app shell checks passed, offline conversion was not tested.`);

  await client.setFile('#file-input-a', hevcFixture);
  await client.waitFor("document.querySelector('#status').textContent.includes('clip A')", 180000);
  await client.setFile('#file-input-b', hevcFixture);
  await client.waitFor("document.querySelector('#status').textContent.includes('samples') || !document.querySelector('#error').hidden", 300000);
  const onlineConversion = await client.evaluate(`(() => ({
    error: document.querySelector('#error').hidden ? null : document.querySelector('#error').textContent,
    report: JSON.parse(document.querySelector('#report').textContent),
  }))()`);
  assert.equal(onlineConversion.error, null, onlineConversion.error);
  assert.ok(onlineConversion.report.merge.mergedSamples > 0);
  const runtimeKeys = await client.evaluate(`(async () => {
    const cache = await caches.open('m4shlab-runtime-v19');
    return (await cache.keys()).map(request => request.url);
  })()`);
  assert.ok(runtimeKeys.some(url => url.endsWith('/converter-worker.js')), 'conversion worker was not runtime-cached');
  assert.ok(runtimeKeys.some(url => url.endsWith('/ffmpeg-core.js')), 'ffmpeg core module was not runtime-cached');
  assert.ok(runtimeKeys.some(url => url.endsWith('/ffmpeg-core.wasm')), 'ffmpeg wasm binary was not runtime-cached');
  console.log(`PASS first online conversion runtime-cached converter-worker.js, ffmpeg-core.js, and ffmpeg-core.wasm (${runtimeKeys.length} runtime entries)`);

  rmSync(downloadDir, {recursive: true, force: true});
  mkdirSync(downloadDir, {recursive: true});
  await client.send('Network.emulateNetworkConditions', {
    offline: true,
    latency: 0,
    downloadThroughput: 0,
    uploadThroughput: 0,
    connectionType: 'none',
  });
  await client.send('Page.reload', {ignoreCache: false});
  await client.waitFor("document.documentElement.dataset.appReady === 'true'", 20000);
  const offlineShell = await client.evaluate(`({
    online: navigator.onLine,
    status: document.querySelector('#status').textContent,
    cards: document.querySelectorAll('.clip-card').length,
    controller: navigator.serviceWorker?.controller?.state ?? null,
    error: document.querySelector('#error').hidden ? null : document.querySelector('#error').textContent,
  })`);
  assert.equal(offlineShell.online, false);
  assert.equal(offlineShell.cards, 0);
  assert.equal(offlineShell.controller, 'activated');
  assert.equal(offlineShell.error, null);
  console.log('PASS offline reload served the complete app shell from Cache Storage with no network');

  await client.setFile('#file-input-a', hevcFixture);
  await client.waitFor("document.querySelector('#status').textContent.includes('clip A') || !document.querySelector('#error').hidden", 300000);
  await client.setFile('#file-input-b', hevcFixture);
  await client.waitFor("document.querySelector('#status').textContent.includes('samples') || !document.querySelector('#error').hidden", 600000);
  const offlineConversion = await client.evaluate(`(() => ({
    error: document.querySelector('#error').hidden ? null : document.querySelector('#error').textContent,
    status: document.querySelector('#status').textContent,
    report: JSON.parse(document.querySelector('#report').textContent),
    previewLabel: document.querySelector('#preview-label').textContent,
  }))()`);
  assert.equal(offlineConversion.error, null, offlineConversion.error);
  assert.equal(offlineConversion.report.sources.a.conversion.decodeEngine, 'ffmpeg.wasm');
  assert.equal(offlineConversion.report.sources.b.conversion.decodeEngine, 'ffmpeg.wasm');
  assert.ok(offlineConversion.report.merge.mergedSamples > 0);
  assert.match(offlineConversion.status, /samples/);
  await client.evaluate("document.querySelector('#assemble-preview').click()");
  await client.waitFor("document.querySelector('#preview-video').readyState >= 2 || document.querySelector('#preview-video').error", 20000);
  const playback = await client.evaluate(`({
    error: document.querySelector('#preview-video').error?.code ?? null,
    width: document.querySelector('#preview-video').videoWidth,
    height: document.querySelector('#preview-video').videoHeight,
  })`);
  assert.equal(playback.error, null);
  assert.ok(playback.width > 0 && playback.height > 0);
  await client.evaluate("document.querySelector('#export-button').click()");
  await waitForDownload(exportPath);
  const exported = new Uint8Array(readFileSync(exportPath));
  const parsed = parseMp4(exported);
  assert.equal(parsed.videoTrack.samples.length, offlineConversion.report.merge.mergedSamples);
  const probe = command('ffprobe', [
    '-v', 'error', '-select_streams', 'v:0', '-count_frames',
    '-show_entries', 'stream=codec_name,width,height,nb_read_frames',
    '-of', 'default=noprint_wrappers=1', exportPath,
  ], 'offline PWA export probe');
  assert.match(probe.stdout, /codec_name=h264/);
  const decodedFrames = Number(/nb_read_frames=(\d+)/.exec(probe.stdout)?.[1] ?? 0);
  assert.ok(decodedFrames > 0);
  const sha256 = createHash('sha256').update(exported).digest('hex');
  console.log(`PASS previously cached ffmpeg.wasm converted two HEVC clips fully offline; merge preview and ${exported.byteLength}-byte export decoded ${decodedFrames} frames, SHA-256 ${sha256}`);

  if (client.exceptions.length) throw new Error(`Browser exceptions:\n${client.exceptions.join('\n')}`);
} finally {
  client?.close();
  chrome?.process.kill('SIGTERM');
  server?.kill('SIGTERM');
  await new Promise(resolve => setTimeout(resolve, 300));
  if (chrome?.profile) {
    try {
      rmSync(chrome.profile, {recursive: true, force: true, maxRetries: 5, retryDelay: 100});
    } catch {}
  }
}
