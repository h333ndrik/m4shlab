import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {dirname, join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawn, spawnSync} from 'node:child_process';
import {parseMp4} from '../parser/mp4.js';
import {extractNals} from '../parser/nal.js';

const projectRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const fixtures = {
  a: join(projectRoot, 'testmedia', 'synthetic-b-a.mp4'),
  b: join(projectRoot, 'testmedia', 'synthetic-b-mismatch.mp4'),
  largeA: join(projectRoot, 'testmedia', 'synthetic-native-large-a.mp4'),
  largeB: join(projectRoot, 'testmedia', 'synthetic-native-large-b.mp4'),
  effectA: join(projectRoot, 'testmedia', 'synthetic-multigop-a.mp4'),
  effectB: join(projectRoot, 'testmedia', 'synthetic-multigop-b.mp4'),
  bFrameB: join(projectRoot, 'testmedia', 'synthetic-b-b.mp4'),
  audioA: join(projectRoot, 'testmedia', 'synthetic-audio-a.mp4'),
  audioB: join(projectRoot, 'testmedia', 'synthetic-audio-b.mp4'),
  silentB: join(projectRoot, 'testmedia', 'synthetic-audio-silent-b.mp4'),
  speed: join(projectRoot, 'testmedia', 'synthetic-speed-60.mp4'),
  poc0A: join(projectRoot, 'testmedia', 'synthetic-multigop-poc0-a.mp4'),
  poc0B: join(projectRoot, 'testmedia', 'synthetic-multigop-poc0-b.mp4'),
};
const normalizedPaths = {
  a: join(projectRoot, 'testmedia', 'webcodecs-browser-normalized-a.mp4'),
  b: join(projectRoot, 'testmedia', 'webcodecs-browser-normalized-b.mp4'),
};
const downloadDir = join(projectRoot, 'testmedia', 'webcodecs-browser-downloads');
const mergedPath = join(downloadDir, 'm4shlab-merge.mp4');
const audioMergedPath = join(projectRoot, 'testmedia', 'webcodecs-audio-merged.mp4');
const speedMergedPath = join(projectRoot, 'testmedia', 'webcodecs-speed-merged.mp4');
const multiGopMergedPath = join(projectRoot, 'testmedia', 'webcodecs-browser-multigop-merged.mp4');
const hybridExportPath = join(projectRoot, 'testmedia', 'webcodecs-hybrid-export.mp4');
const multiTimelineExportPath = join(projectRoot, 'testmedia', 'webcodecs-multitimeline-export.mp4');
const looksMergedPath = join(projectRoot, 'testmedia', 'webcodecs-looks-merged.mp4');
const audioDisabledPath = join(projectRoot, 'testmedia', 'webcodecs-audio-disabled.mp4');
const looksFramePath = join(projectRoot, 'testmedia', 'webcodecs-looks-frame.rgb');
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
  console.log(`SKIP WebCodecs browser test: ${message}`);
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

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function assertNormalizedClip(bytes, label) {
  const parsed = parseMp4(bytes);
  const nals = extractNals(bytes, parsed.videoTrack);
  const idrSamples = [...new Set(nals.filter(nal => nal.type === 5).map(nal => nal.sampleIndex))];
  assert.deepEqual(idrSamples, [0], `${label} must have exactly one leading IDR sample`);
  assert.equal(nals.filter(nal => nal.sampleIndex === 0 && nal.type === 5).length, 1);
  assert.ok(nals.filter(nal => nal.sampleIndex > 0).every(nal => nal.type !== 5), `${label} must not contain later IDRs in this short fixture`);
  assert.equal(parsed.videoTrack.stts.sampleCount, parsed.videoTrack.samples.length);
  return parsed;
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
    await new Promise((resolveOpen, rejectOpen) => {
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

  async setFile(selector, path) {
    await this.setFiles(selector, [path]);
  }

  async setFiles(selector, paths) {
    const response = await this.send('Runtime.evaluate', {expression: `document.querySelector(${JSON.stringify(selector)})`});
    await this.send('DOM.setFileInputFiles', {objectId: response.result.objectId, files: paths});
  }

  async waitFor(expression, timeout = 120000) {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      if (await this.evaluate(expression)) return;
      await new Promise(resolveWait => setTimeout(resolveWait, 200));
    }
    const state = await this.evaluate(`({
      status: document.querySelector('#status')?.textContent,
      error: document.querySelector('#error')?.textContent,
      conversion: document.querySelector('#conversion-message')?.textContent
    })`);
    throw new Error(`Timeout waiting for ${expression}: ${JSON.stringify(state)}`);
  }

  close() {
    this.socket.close();
  }
}

async function launchChrome({disableGpu = true} = {}) {
  const chrome = chromeCandidates.find(candidate => existsSync(candidate));
  if (!chrome) return null;
  const profile = mkdtempSync(join(tmpdir(), 'm4shlab-webcodecs-'));
  const process = spawn(chrome, [
    '--headless=new',
    '--remote-debugging-port=0',
    `--user-data-dir=${profile}`,
    '--no-first-run',
    '--no-default-browser-check',
    ...(disableGpu ? ['--disable-gpu'] : []),
    '--autoplay-policy=no-user-gesture-required',
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
  const client = new CdpClient(target.webSocketDebuggerUrl);
  await client.open();
  return client;
}

async function waitForDownload(path, timeout = 15000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (existsSync(path) && readFileSync(path).byteLength > 0) return;
    await new Promise(resolveWait => setTimeout(resolveWait, 100));
  }
  throw new Error(`Download did not appear: ${path}`);
}

function requiredFixturesExist() {
  return Object.values(fixtures).every(path => existsSync(path));
}

if (typeof WebSocket !== 'function') skip('this Node version has no built-in WebSocket client; run with Node 22+ or use Playwright.');
if (!requiredFixturesExist()) command('bash', ['testmedia/generate.sh'], 'fixture generation');

server = spawn(process.execPath, ['scripts/serve.mjs'], {
  cwd: projectRoot,
  env: {...process.env, PORT: '4182'},
  stdio: 'ignore',
});
try {
  const serverStarted = Date.now() + 5000;
  while (Date.now() < serverStarted) {
    try {
      const response = await fetch('http://127.0.0.1:4182/');
      if (response.ok) break;
    } catch {
      await new Promise(resolveWait => setTimeout(resolveWait, 100));
    }
  }
  chrome = await launchChrome();
  if (!chrome) skip('Chrome/Chromium was not found. Set CHROME_BIN to run this test.');
  client = await pageTarget(chrome.endpoint);
  await client.send('Page.enable');
  await client.send('Runtime.enable');
  await client.send('DOM.enable');
  await client.send('Emulation.setDeviceMetricsOverride', {width: 1200, height: 1600, deviceScaleFactor: 1, mobile: false});
  await client.send('Browser.setDownloadBehavior', {behavior: 'allow', downloadPath: downloadDir, eventsEnabled: true});
  await client.send('Page.navigate', {url: 'http://127.0.0.1:4182/'});
  await client.waitFor("document.querySelector('#file-input-a') !== null && document.documentElement.dataset.appReady === 'true'", 10000);

  const feature = await client.evaluate(`(async () => ({
    decoder: typeof VideoDecoder,
    encoder: typeof VideoEncoder,
    frame: typeof VideoFrame,
    h264: (await VideoEncoder.isConfigSupported({codec: 'avc1.42001f', width: 320, height: 240, framerate: 30, bitrate: 500000, avc: {format: 'avc'}})).supported
  }))()`);
  if (feature.decoder !== 'function' || feature.encoder !== 'function' || !feature.h264) {
    skip(`this Chrome build lacks usable H.264 WebCodecs encode/decode (${JSON.stringify(feature)}).`);
  }

  const normalizedBytes = await client.evaluate(`(async () => {
    const {normalizeWithWebCodecs} = await import('./webcodecs.js');
    const inputA = new Uint8Array(await (await fetch('/testmedia/synthetic-b-a.mp4')).arrayBuffer());
    const inputB = new Uint8Array(await (await fetch('/testmedia/synthetic-b-mismatch.mp4')).arrayBuffer());
    const target = {width: 320, height: 240};
    const a = await normalizeWithWebCodecs(inputA, {target});
    const b = await normalizeWithWebCodecs(inputB, {target, frameNumberBase: a.outputSamples - 1});
    return {a: Array.from(a.bytes), b: Array.from(b.bytes), aReport: {...a, bytes: undefined}, bReport: {...b, bytes: undefined}};
  })()`);
  const normalizedA = Uint8Array.from(normalizedBytes.a);
  const normalizedB = Uint8Array.from(normalizedBytes.b);
  writeFileSync(normalizedPaths.a, normalizedA);
  writeFileSync(normalizedPaths.b, normalizedB);
  const parsedA = assertNormalizedClip(normalizedA, 'normalized clip A');
  const parsedB = assertNormalizedClip(normalizedB, 'normalized clip B');
  assert.equal(parsedA.videoTrack.samples.length, 25);
  assert.equal(parsedB.videoTrack.samples.length, 25);
  assert.equal(parsedA.videoTrack.mdhd.timescale, parsedB.videoTrack.mdhd.timescale);
  assert.equal(parsedA.videoTrack.width, 320);
  assert.equal(parsedA.videoTrack.height, 240);
  assert.equal(parsedB.videoTrack.width, 320);
  assert.equal(parsedB.videoTrack.height, 240);
  console.log(`PASS WebCodecs decoded and normalized both clips with one leading IDR each; ${normalizedA.byteLength} B / ${normalizedB.byteLength} B`);

  const longGop = await client.evaluate(`(async () => {
    const {normalizeWithWebCodecs} = await import('./webcodecs.js');
    const {mergeMoshH264} = await import('./merge.js');
    const input = new Uint8Array(await (await fetch('/testmedia/synthetic-h264.mp4')).arrayBuffer());
    const target = {width: 320, height: 240};
    const a = await normalizeWithWebCodecs(input, {target});
    const b = await normalizeWithWebCodecs(input, {target, frameNumberBase: a.outputSamples - 1});
    const merged = await mergeMoshH264(a.bytes, b.bytes);
    return {
      samples: a.outputSamples,
      keyframes: a.keyframes,
      idrCount: a.idrCount,
      mergeReport: merged.report,
      mergedBytes: Array.from(merged.output),
    };
  })()`);
  assert.equal(longGop.samples, 75);
  assert.deepEqual(longGop.keyframes, [1, 31, 61]);
  assert.equal(longGop.idrCount, 3);
  assert.equal(longGop.mergeReport.mergedSamples, 149);
  assert.equal(longGop.mergeReport.bIdrCountRemaining, 2);
  assert.equal(longGop.mergeReport.frameAlignment.applied, true);
  assert.equal(longGop.mergeReport.frameAlignment.nextIdrSample, 30);
  writeFileSync(multiGopMergedPath, Uint8Array.from(longGop.mergedBytes));
  const longGopProbe = command('ffprobe', [
    '-v', 'error', '-select_streams', 'v:0', '-count_frames',
    '-show_entries', 'stream=nb_read_frames', '-of', 'default=noprint_wrappers=1', multiGopMergedPath,
  ], 'WebCodecs multi-GOP merge probe');
  assert.match(longGopProbe.stdout, /nb_read_frames=149/);
  command('ffmpeg', ['-v', 'error', '-i', multiGopMergedPath, '-f', 'null', '-'], 'WebCodecs multi-GOP strict decode');
  console.log('PASS WebCodecs emitted keyframes at samples 1, 31, and 61; the multi-GOP merge retained two later IDRs and decoded all 149 frames');

  await client.send('Page.navigate', {url: 'http://127.0.0.1:4182/?safari-poc0=1'});
  await client.waitFor("document.querySelector('#file-input-a') !== null && document.documentElement.dataset.appReady === 'true'", 10000);
  await client.setFile('#file-input-a', fixtures.poc0A);
  await client.waitFor("document.querySelector('#status').textContent.includes('clip A')", 15000);
  await client.evaluate(`(() => {
    const error = document.querySelector('#error');
    error.textContent = 'stale pre-merge error';
    error.hidden = false;
  })()`);
  await client.setFile('#file-input-b', fixtures.poc0B);
  await client.waitFor("document.querySelector('#status').textContent.includes('samples') || /failed/i.test(document.querySelector('#status').textContent)", 30000);
  const poc0Pair = await client.evaluate(`(() => {
    const reportNode = document.querySelector('#report');
    return {
      status: document.querySelector('#status').textContent,
      error: document.querySelector('#error').hidden ? null : document.querySelector('#error').textContent,
      compatibilityMarkup: document.querySelector('#compatibility-panel, #compatibility-status, .compatibility-table'),
      cards: document.querySelectorAll('.clip-card').length,
      connector: document.querySelector('.connector')?.textContent ?? '',
      reportText: reportNode.textContent,
      report: reportNode.textContent ? JSON.parse(reportNode.textContent) : null,
    };
  })()`);
  assert.equal(poc0Pair.error, null, 'A successful merge must clear stale errors');
  assert.equal(poc0Pair.compatibilityMarkup, null, 'Compatibility UI must not exist');
  assert.equal(poc0Pair.cards, 2);
  assert.match(poc0Pair.connector, /Classic Mosh/);
  assert.ok(!poc0Pair.reportText.includes('spsHash'), 'SPS/PPS hashes must not be rendered');
  assert.equal(poc0Pair.report.compatibility.compatible, true);
  assert.equal(poc0Pair.report.merge.mergedSamples, 99);
  assert.equal(poc0Pair.report.merge.frameAlignment.applied, true);
  assert.equal(poc0Pair.report.merge.frameAlignment.picOrderCntType, 0);
  assert.equal(poc0Pair.report.merge.frameAlignment.pictureReordering.noReordering, true);
  console.log('PASS Safari-style POC type 0 multi-GOP pair merges in the browser and clears stale errors');

  await client.send('Emulation.setDeviceMetricsOverride', {width: 390, height: 1000, deviceScaleFactor: 1, mobile: true});
  await client.send('Emulation.setTouchEmulationEnabled', {enabled: true, maxTouchPoints: 5});
  await new Promise(resolve => setTimeout(resolve, 150));
  const mobileLayout = await client.evaluate(`(() => ({
    headerDirection: getComputedStyle(document.querySelector('header')).flexDirection,
    previewDirection: getComputedStyle(document.querySelector('.preview-meta')).flexDirection,
    importHeight: document.querySelector('.file-actions .button').getBoundingClientRect().height,
    clipControlHeight: document.querySelector('.clip-controls button').getBoundingClientRect().height,
    timelineScrolls: document.querySelector('.timeline').scrollWidth > document.querySelector('.timeline').clientWidth,
  }))()`);
  assert.equal(mobileLayout.headerDirection, 'column');
  assert.equal(mobileLayout.previewDirection, 'column');
  assert.ok(mobileLayout.importHeight >= 44);
  assert.ok(mobileLayout.clipControlHeight >= 44);
  assert.equal(mobileLayout.timelineScrolls, true);
  console.log('PASS mobile layout stacks under 600px and keeps 44px touch targets on the scrolling timeline');
  await client.send('Emulation.setTouchEmulationEnabled', {enabled: false});
  await client.send('Emulation.setDeviceMetricsOverride', {width: 1200, height: 1600, deviceScaleFactor: 1, mobile: false});

  await client.send('Page.navigate', {url: 'http://127.0.0.1:4182/?merge-error=1'});
  await client.waitFor("document.querySelector('#file-input-a') !== null && document.documentElement.dataset.appReady === 'true'", 10000);
  await client.setFile('#file-input-a', join(projectRoot, 'testmedia', 'synthetic-h264.mp4'));
  await client.waitFor("document.querySelector('#status').textContent.includes('clip A')", 15000);
  await client.setFile('#file-input-b', join(projectRoot, 'testmedia', 'synthetic-h264.mp4'));
  await client.waitFor("!document.querySelector('#error').hidden || /no merged mp4/i.test(document.querySelector('#status').textContent)", 30000);
  const mergeError = await client.evaluate(`(() => ({
    text: document.querySelector('#error').textContent,
    hidden: document.querySelector('#error').hidden,
    status: document.querySelector('#status').textContent,
    compatibilityMarkup: document.querySelector('#compatibility-panel, #compatibility-status, .compatibility-table'),
  }))()`);
  assert.equal(mergeError.hidden, false);
  assert.match(mergeError.text, /picture reordering|frame-number alignment/i);
  assert.ok(mergeError.text.length < 320, 'Blocking error should stay short and actionable');
  assert.equal(mergeError.compatibilityMarkup, null, 'Error case must not render a compatibility panel');
  console.log('PASS blocking merge errors stay short and do not render a compatibility panel');

  await client.send('Page.navigate', {url: 'http://127.0.0.1:4182/?large-native=1'});
  await client.waitFor("document.querySelector('#file-input-a') !== null && document.documentElement.dataset.appReady === 'true'", 10000);
  await client.setFile('#file-input-a', fixtures.largeA);
  await client.waitFor("document.querySelector('#status').textContent.includes('clip A')", 15000);
  await client.evaluate(`(() => {
    window.__uiStates = [document.querySelector('#status').textContent, document.querySelector('#conversion-status').textContent];
    const observer = new MutationObserver(() => window.__uiStates.push(
      document.querySelector('#status').textContent,
      document.querySelector('#conversion-status').textContent,
    ));
    observer.observe(document.querySelector('#status'), {childList: true, characterData: true, subtree: true});
    observer.observe(document.querySelector('#conversion-status'), {childList: true, characterData: true, subtree: true});
  })()`);
  await client.setFile('#file-input-b', fixtures.largeB);
  await client.waitFor("document.querySelector('#status').textContent.includes('samples') || !document.querySelector('#error').hidden", 120000);
  const largePair = await client.evaluate(`(() => {
    const reportNode = document.querySelector('#report');
    return {
      error: document.querySelector('#error').hidden ? null : document.querySelector('#error').textContent,
      states: window.__uiStates,
      compatibilityMarkup: document.querySelector('#compatibility-panel, #compatibility-status, .compatibility-table'),
      conversionStatus: document.querySelector('#conversion-status').textContent,
      progressA: document.querySelector('#conversion-progress').value,
      progressB: document.querySelector('#conversion-progress-b').value,
      report: reportNode.textContent ? JSON.parse(reportNode.textContent) : null,
    };
  })()`);
  assert.equal(largePair.error, null, largePair.error || 'large native pair did not normalize');
  assert.equal(largePair.compatibilityMarkup, null, 'Compatibility UI must not exist');
  assert.ok(largePair.states.some(state => /normaliz/i.test(state)), 'UI never exposed the normalizing state');
  assert.equal(largePair.report.normalization.autoNormalized, true);
  assert.equal(largePair.report.normalization.parallel, true);
  assert.deepEqual(largePair.report.normalization.target, {width: 540, height: 720});
  assert.equal(largePair.report.sources.a.conversion.mode, 'normalized');
  assert.equal(largePair.report.sources.b.conversion.mode, 'normalized');
  assert.equal(largePair.report.sources.a.conversion.encodeEngine, 'WebCodecs', largePair.report.sources.a.conversion.webcodecsFallbackReason || 'Clip A did not use WebCodecs');
  assert.equal(largePair.report.sources.b.conversion.encodeEngine, 'WebCodecs', largePair.report.sources.b.conversion.webcodecsFallbackReason || 'Clip B did not use WebCodecs');
  assert.ok(largePair.report.merge.mergedSamples > 0);
  assert.equal(largePair.progressA, 1);
  assert.equal(largePair.progressB, 1);
  console.log(`PASS large native mismatch auto-normalized to ${largePair.report.normalization.target.width}x${largePair.report.normalization.target.height}; UI showed the normalizing state and merge produced ${largePair.report.merge.mergedSamples} samples`);

  await client.send('Page.navigate', {url: 'http://127.0.0.1:4182/?multi-timeline=1'});
  await client.waitFor("document.querySelector('#file-input-a') !== null && document.documentElement.dataset.appReady === 'true'", 10000);
  await client.setFiles('#file-input-a', [fixtures.largeA, fixtures.largeB, fixtures.a]);
  await client.waitFor("document.querySelector('#status').textContent.includes('samples') || !document.querySelector('#error').hidden", 180000);
  const multiInitial = await client.evaluate(`(() => {
    const reportNode = document.querySelector('#report');
    return {
      error: document.querySelector('#error').hidden ? null : document.querySelector('#error').textContent,
      cards: [...document.querySelectorAll('.clip-card .clip-name')].map(node => node.textContent),
      connectors: [...document.querySelectorAll('.connector')].map(node => node.textContent),
      frameAlignment: document.querySelector('#transition-dialog') !== null,
      compatibilityMarkup: document.querySelector('#compatibility-panel, #compatibility-status, .compatibility-table'),
      report: reportNode.textContent ? JSON.parse(reportNode.textContent) : null,
    };
  })()`);
  assert.equal(multiInitial.error, null, multiInitial.error || 'multi-clip sequence did not normalize');
  assert.equal(multiInitial.cards.length, 3);
  assert.equal(multiInitial.connectors.length, 2);
  assert.ok(multiInitial.connectors.every(text => /Classic Mosh/.test(text)));
  assert.equal(multiInitial.compatibilityMarkup, null);
  assert.equal(multiInitial.report.normalization.autoNormalized, true);
  assert.equal(multiInitial.report.normalization.parallel, true);
  assert.deepEqual(multiInitial.report.normalization.target, {width: 540, height: 720});
  assert.equal(multiInitial.report.sources.clips.length, 3);
  assert.ok(multiInitial.report.sources.clips.every(clip => clip.conversion?.mode === 'normalized'));
  assert.ok(multiInitial.report.sources.clips.every(clip => clip.conversion?.encodeEngine === 'WebCodecs'));
  assert.equal(multiInitial.report.merge.clipCount, 3);
  assert.deepEqual(multiInitial.report.merge.methods, ['classic-mosh', 'classic-mosh']);

  const dialogMethods = await client.evaluate(`(() => {
    document.querySelectorAll('.connector')[0].click();
    const duration = document.querySelector('#transition-duration');
    return {
      open: document.querySelector('#transition-dialog').open,
      methods: [...document.querySelectorAll('#transition-dialog input[name="transition-method"]')].map(input => input.value),
      classicHidden: document.querySelector('#classic-mosh-options').hidden,
      effectHidden: document.querySelector('#nal-effect-options').hidden,
      endingOptions: [...document.querySelectorAll('#transition-ending option')].map(option => option.textContent),
      ending: document.querySelector('#transition-ending').value,
      durationMax: Number(duration.max),
      durationValue: Number(duration.value),
      durationMode: document.querySelector('#transition-duration-mode').textContent,
      randomizeDisabled: document.querySelector('#transition-randomize').disabled,
      seed: document.querySelector('#transition-seed').textContent,
    };
  })()`);
  assert.equal(dialogMethods.open, true);
  assert.deepEqual(dialogMethods.methods, ['cut', 'classic-mosh', 'melt', 'loop', 'reset-pulse']);
  assert.equal(dialogMethods.classicHidden, false);
  assert.equal(dialogMethods.effectHidden, true);
  assert.deepEqual(dialogMethods.endingOptions, ['Restore clear image', 'Continue motion']);
  assert.equal(dialogMethods.ending, 'restore');
  assert.ok(dialogMethods.durationMax >= 1);
  assert.equal(dialogMethods.durationValue, dialogMethods.durationMax);
  assert.equal(dialogMethods.durationMode, 'full length');
  assert.equal(dialogMethods.randomizeDisabled, false);
  assert.equal(dialogMethods.seed, 'seed —');
  const randomizedUi = await client.evaluate(`(() => {
    const button = document.querySelector('#transition-randomize');
    button.click();
    const seeded = {
      seedText: document.querySelector('#transition-seed').textContent,
      method: document.querySelector('#transition-dialog input[name="transition-method"]:checked').value,
      duration: Number(document.querySelector('#transition-duration').value),
      ending: document.querySelector('#transition-ending').value,
      mode: document.querySelector('#transition-duration-mode').textContent,
    };
    const duration = document.querySelector('#transition-duration');
    duration.dispatchEvent(new Event('input', {bubbles: true}));
    return {
      ...seeded,
      clearedSeedText: document.querySelector('#transition-seed').textContent,
    };
  })()`);
  assert.match(randomizedUi.seedText, /^seed [0-9a-f]{16}$/);
  assert.ok(['classic-mosh', 'melt', 'loop', 'reset-pulse'].includes(randomizedUi.method));
  assert.ok(randomizedUi.duration >= 12 && randomizedUi.duration <= dialogMethods.durationMax);
  assert.ok(randomizedUi.ending === 'restore' || randomizedUi.ending === 'continue');
  assert.equal(randomizedUi.mode, 'randomized');
  assert.equal(randomizedUi.clearedSeedText, 'seed —');
  const appliedRandomSeed = await client.evaluate(`(() => {
    document.querySelector('#transition-randomize').click();
    const seed = document.querySelector('#transition-seed').textContent.replace('seed ', '');
    document.querySelector('#transition-apply').click();
    return seed;
  })()`);
  assert.match(appliedRandomSeed, /^[0-9a-f]{16}$/);
  await client.waitFor(`(() => {
    const node = document.querySelector('#report');
    if (!node.textContent) return false;
    try {
      const report = JSON.parse(node.textContent);
      return report.stage === 'merged' && report.transitions?.[0]?.random_seed === '${appliedRandomSeed}';
    } catch { return false; }
  })()`, 30000);
  console.log('PASS Randomize creates a 16-hex seed, manual edits clear it, and random_seed persists in the boundary report');
  await client.evaluate("document.querySelector('#undo-button').click()");
  await client.waitFor(`(() => {
    const node = document.querySelector('#report');
    if (!node.textContent) return false;
    try {
      const report = JSON.parse(node.textContent);
      return report.stage === 'merged' && report.transitions?.[0]?.random_seed === null;
    } catch { return false; }
  })()`, 30000);
  await client.evaluate("document.querySelector('.connector').click()");
  const durationControls = await client.evaluate(`(() => {
    const duration = document.querySelector('#transition-duration');
    duration.value = '5';
    duration.dispatchEvent(new Event('input', {bubbles: true}));
    const ending = document.querySelector('#transition-ending');
    ending.value = 'continue';
    ending.dispatchEvent(new Event('change', {bubbles: true}));
    const melt = document.querySelector('#transition-dialog input[value="melt"]');
    melt.checked = true;
    melt.dispatchEvent(new Event('change', {bubbles: true}));
    const effect = document.querySelector('#effect-parameter');
    const meltState = {
      classicHidden: document.querySelector('#classic-mosh-options').hidden,
      effectHidden: document.querySelector('#nal-effect-options').hidden,
      ending: document.querySelector('#transition-ending').value,
      cadenceHidden: document.querySelector('#melt-cadence-control').hidden,
      cadence: document.querySelector('#melt-cadence').value,
      label: document.querySelector('#effect-parameter-label').textContent,
      min: Number(effect.min),
      max: Number(effect.max),
      value: Number(effect.value),
      valueText: document.querySelector('#effect-parameter-value').textContent,
    };
    const loop = document.querySelector('#transition-dialog input[value="loop"]');
    loop.checked = true;
    loop.dispatchEvent(new Event('change', {bubbles: true}));
    const loopState = {
      classicHidden: document.querySelector('#classic-mosh-options').hidden,
      ending: document.querySelector('#transition-ending').value,
      cadenceHidden: document.querySelector('#melt-cadence-control').hidden,
      cadence: document.querySelector('#melt-cadence').value,
      label: document.querySelector('#effect-parameter-label').textContent,
      max: Number(effect.max),
      value: Number(effect.value),
      valueText: document.querySelector('#effect-parameter-value').textContent,
    };
    const reset = document.querySelector('#transition-dialog input[value="reset-pulse"]');
    reset.checked = true;
    reset.dispatchEvent(new Event('change', {bubbles: true}));
    const resetState = {
      classicHidden: document.querySelector('#classic-mosh-options').hidden,
      effectHidden: document.querySelector('#nal-effect-options').hidden,
      resetHidden: document.querySelector('#reset-pulse-options').hidden,
      intervalMin: Number(document.querySelector('#reset-interval').min),
      intervalMax: Number(document.querySelector('#reset-interval').max),
      intervalValue: Number(document.querySelector('#reset-interval').value),
      repeatMin: Number(document.querySelector('#reset-repeat').min),
      repeatMax: Number(document.querySelector('#reset-repeat').max),
      repeatValue: Number(document.querySelector('#reset-repeat').value),
    };
    const cut = document.querySelector('#transition-dialog input[value="cut"]');
    cut.checked = true;
    cut.dispatchEvent(new Event('change', {bubbles: true}));
    return {
      valueText: document.querySelector('#transition-duration-value').textContent,
      mode: document.querySelector('#transition-duration-mode').textContent,
      classicHiddenForCut: document.querySelector('#classic-mosh-options').hidden,
      effectHiddenForCut: document.querySelector('#nal-effect-options').hidden,
      resetHiddenForCut: document.querySelector('#reset-pulse-options').hidden,
      meltState,
      loopState,
      resetState,
    };
  })()`);
  assert.match(durationControls.valueText, /5 frames/);
  assert.equal(durationControls.mode, 'custom');
  assert.equal(durationControls.classicHiddenForCut, true);
  assert.equal(durationControls.effectHiddenForCut, true);
  assert.equal(durationControls.resetHiddenForCut, true);
  assert.equal(durationControls.meltState.classicHidden, false);
  assert.equal(durationControls.meltState.effectHidden, false);
  assert.equal(durationControls.meltState.ending, 'continue');
  assert.equal(durationControls.meltState.cadenceHidden, false);
  assert.equal(durationControls.meltState.cadence, 'original');
  assert.equal(durationControls.meltState.label, 'repeat');
  assert.equal(durationControls.meltState.min, 2);
  assert.equal(durationControls.meltState.max, 12);
  assert.equal(durationControls.meltState.value, 4);
  assert.match(durationControls.meltState.valueText, /4×/);
  assert.equal(durationControls.loopState.label, 'loop frames');
  assert.equal(durationControls.loopState.classicHidden, false);
  assert.equal(durationControls.loopState.ending, 'continue');
  assert.equal(durationControls.loopState.cadenceHidden, false);
  assert.equal(durationControls.loopState.cadence, 'original');
  assert.equal(durationControls.loopState.max, 48);
  assert.equal(durationControls.loopState.value, 4);
  assert.match(durationControls.loopState.valueText, /4 frames/);
  assert.equal(durationControls.resetState.classicHidden, false);
  assert.equal(durationControls.resetState.effectHidden, true);
  assert.equal(durationControls.resetState.resetHidden, false);
  assert.equal(durationControls.resetState.intervalMin, 4);
  assert.ok(durationControls.resetState.intervalMax >= 4);
  assert.ok(durationControls.resetState.intervalValue >= 4);
  assert.equal(durationControls.resetState.repeatMin, 2);
  assert.equal(durationControls.resetState.repeatMax, 12);
  assert.equal(durationControls.resetState.repeatValue, 4);
  console.log('PASS transition dialog exposes Classic/Reset duration, Melt/Loop, and Reset Pulse interval/repeat controls');
  await client.evaluate("document.querySelector('#transition-apply').click()");
  await client.waitFor("JSON.parse(document.querySelector('#report').textContent).transitions?.[0]?.method === 'cut' && document.querySelector('#status').textContent.includes('samples')", 30000);
  const mixedTimeline = await client.evaluate(`(() => ({
    connectors: [...document.querySelectorAll('.connector')].map(node => node.textContent),
    methods: JSON.parse(document.querySelector('#report').textContent).merge.methods,
    mergedSamples: JSON.parse(document.querySelector('#report').textContent).merge.mergedSamples,
    modifiedEnabled: !document.querySelector('#show-modified').disabled,
  }))()`);
  assert.match(mixedTimeline.connectors[0], /Cut/);
  assert.match(mixedTimeline.connectors[1], /Classic Mosh/);
  assert.deepEqual(mixedTimeline.methods, ['cut', 'classic-mosh']);
  assert.ok(mixedTimeline.mergedSamples > 0);
  assert.equal(mixedTimeline.modifiedEnabled, true);
  console.log(`PASS multi-file import normalized 3 clips to 540x720, exposed two Cut/Classic Mosh boundary dialogs, and merged ${mixedTimeline.mergedSamples} samples`);

  const originalOrder = multiInitial.cards;
  await client.evaluate("document.querySelectorAll('.clip-card')[2].querySelectorAll('.clip-controls button')[0].click()");
  await client.waitFor(`JSON.stringify([...document.querySelectorAll('.clip-card .clip-name')].map(node => node.textContent)) === ${JSON.stringify(JSON.stringify([originalOrder[0], originalOrder[2], originalOrder[1]]))}`, 10000);
  await client.evaluate("document.querySelector('#undo-button').click()");
  await client.waitFor(`JSON.stringify([...document.querySelectorAll('.clip-card .clip-name')].map(node => node.textContent)) === ${JSON.stringify(JSON.stringify(originalOrder))}`, 10000);
  await client.evaluate("document.querySelectorAll('.clip-card')[2].querySelectorAll('.clip-controls button')[2].click()");
  await client.waitFor("document.querySelectorAll('.clip-card').length === 2", 10000);
  await client.evaluate("document.querySelector('#undo-button').click()");
  await client.waitFor("document.querySelectorAll('.clip-card').length === 3", 10000);
  await client.waitFor("document.querySelector('#status').textContent.includes('samples') || !document.querySelector('#error').hidden", 30000);
  const historyState = await client.evaluate(`(() => ({
    cards: [...document.querySelectorAll('.clip-card .clip-name')].map(node => node.textContent),
    undoDisabled: document.querySelector('#undo-button').disabled,
    error: document.querySelector('#error').hidden ? null : document.querySelector('#error').textContent,
  }))()`);
  assert.deepEqual(historyState.cards, originalOrder);
  assert.equal(historyState.undoDisabled, false);
  assert.equal(historyState.error, null, historyState.error);
  console.log('PASS timeline reorder, remove, and full undo restores the three-clip order and merged preview');

  await client.evaluate("document.querySelector('#show-modified').click()");
  await client.waitFor("document.querySelector('#preview-video').readyState >= 2 || document.querySelector('#preview-video').error", 15000);
  const multiPlayback = await client.evaluate(`({
    error: document.querySelector('#preview-video').error?.code ?? null,
    width: document.querySelector('#preview-video').videoWidth,
    height: document.querySelector('#preview-video').videoHeight
  })`);
  assert.equal(multiPlayback.error, null);
  assert.equal(multiPlayback.width, 540);
  assert.equal(multiPlayback.height, 720);

  rmSync(downloadDir, {recursive: true, force: true});
  mkdirSync(downloadDir, {recursive: true});
  rmSync(mergedPath, {force: true});
  await client.evaluate("document.querySelector('#export-button').click()");
  await waitForDownload(mergedPath);
  writeFileSync(multiTimelineExportPath, readFileSync(mergedPath));
  const multiParsed = parseMp4(new Uint8Array(readFileSync(multiTimelineExportPath)));
  const multiNals = extractNals(new Uint8Array(readFileSync(multiTimelineExportPath)), multiParsed.videoTrack);
  const finalReport = await client.evaluate("JSON.parse(document.querySelector('#report').textContent)");
  const multiStszSum = multiParsed.videoTrack.sampleSizes.sizes.reduce((total, value) => total + value, 0);
  const multiMdatLength = multiParsed.mdatRanges.reduce((total, box) => total + box.payloadEnd - box.payloadStart, 0);
  assert.equal(multiParsed.videoTrack.samples.length, finalReport.merge.mergedSamples);
  assert.equal(multiStszSum, multiMdatLength);
  assert.ok(multiParsed.videoTrack.samples.every((sample, index, samples) => index === 0 || sample.offset > samples[index - 1].offset));
  assert.deepEqual([...new Set(multiNals.filter(nal => nal.type === 5).map(nal => nal.sampleIndex))].slice(0, 1), [0]);
  assert.ok(multiNals.some(nal => nal.sampleIndex === 0 && nal.type === 5));
  const multiProbe = command('ffprobe', [
    '-v', 'error', '-select_streams', 'v:0', '-count_frames',
    '-show_entries', 'stream=codec_name,width,height,nb_read_frames', '-of', 'default=noprint_wrappers=1', multiTimelineExportPath,
  ], 'multi-timeline export probe');
  assert.match(multiProbe.stdout, /codec_name=h264/);
  assert.match(multiProbe.stdout, /width=540/);
  assert.match(multiProbe.stdout, /height=720/);
  assert.match(multiProbe.stdout, new RegExp(`nb_read_frames=${finalReport.merge.expectedDecodedFrames}`));
  command('ffmpeg', ['-v', 'error', '-i', multiTimelineExportPath, '-f', 'null', '-'], 'multi-timeline strict decode');
  console.log(`PASS full three-clip export decodes ${finalReport.merge.expectedDecodedFrames} frames at 540x720; Cut + Classic Mosh NAL sequence and preview are intact`);

  await client.send('Page.navigate', {url: 'http://127.0.0.1:4182/?nal-effects=1'});
  await client.waitFor("document.querySelector('#file-input-a') !== null && document.documentElement.dataset.appReady === 'true'", 10000);
  await client.setFile('#file-input-a', fixtures.effectA);
  await client.waitFor("document.querySelector('#status').textContent.includes('clip A')", 15000);
  await client.setFile('#file-input-b', fixtures.effectB);
  await client.waitFor("document.querySelector('#status').textContent.includes('samples') || !document.querySelector('#error').hidden", 30000);
  const applyEffect = async (method, value, options = {}) => {
    await client.evaluate(`(() => {
      document.querySelector('.connector').click();
      const radio = document.querySelector('#transition-dialog input[value="${method}"]');
      radio.checked = true;
      radio.dispatchEvent(new Event('change', {bubbles: true}));
      if (${JSON.stringify(method)} === 'melt' || ${JSON.stringify(method)} === 'loop') {
        const parameter = document.querySelector('#effect-parameter');
        parameter.value = '${value}';
        parameter.dispatchEvent(new Event('input', {bubbles: true}));
      }
      if ((${JSON.stringify(method)} === 'melt' || ${JSON.stringify(method)} === 'loop') && ${options.smooth !== undefined}) {
        const cadence = document.querySelector('#melt-cadence');
        cadence.value = '${options.smooth ? 'gentler' : 'original'}';
        cadence.dispatchEvent(new Event('change', {bubbles: true}));
      }
      if (${JSON.stringify(method)} !== 'cut' && ${options.durationFrames !== undefined}) {
        const duration = document.querySelector('#transition-duration');
        duration.value = '${options.durationFrames ?? 12}';
        duration.dispatchEvent(new Event('input', {bubbles: true}));
        const ending = document.querySelector('#transition-ending');
        ending.value = '${options.ending ?? 'continue'}';
        ending.dispatchEvent(new Event('change', {bubbles: true}));
      }
      if (${JSON.stringify(method)} === 'reset-pulse') {
        const interval = document.querySelector('#reset-interval');
        interval.value = '${options.interval ?? 6}';
        interval.dispatchEvent(new Event('input', {bubbles: true}));
        const repeat = document.querySelector('#reset-repeat');
        repeat.value = '${options.repeat ?? 2}';
        repeat.dispatchEvent(new Event('input', {bubbles: true}));
      }
      document.querySelector('#transition-apply').click();
    })()`);
    await client.waitFor(`(() => {
      const node = document.querySelector('#report');
      if (!node.textContent) return false;
      const report = JSON.parse(node.textContent);
      return report.stage === 'merged'
        && report.transitions?.[0]?.method === '${method}'
        && report.merge?.effect?.smooth === ${options.smooth === true};
    })()`, 30000);
    return client.evaluate(`(() => {
      const report = JSON.parse(document.querySelector('#report').textContent);
      return {
        error: document.querySelector('#error').hidden ? null : document.querySelector('#error').textContent,
        mergedSamples: report.merge.mergedSamples,
        method: report.transitions[0].method,
        effect: report.merge.effect,
        resetPulse: report.merge.resetPulse,
        patchedSamples: report.merge.frameAlignment.patchedSamples,
        previewEnabled: !document.querySelector('#show-modified').disabled,
      };
    })()`);
  };
  const meltUi = await applyEffect('melt', 2, {durationFrames: 12, ending: 'continue'});
  assert.equal(meltUi.error, null, meltUi.error);
  assert.equal(meltUi.method, 'melt');
  assert.equal(meltUi.mergedSamples, 105);
  assert.equal(meltUi.effect.repeat, 2);
  assert.equal(meltUi.effect.window.windowOutputSamples, 12);
  assert.equal(meltUi.effect.window.tail.donorStartSample, 7);
  assert.equal(meltUi.effect.scheduledSourceSamples.length, 80);
  assert.equal(meltUi.patchedSamples, 78);
  assert.equal(meltUi.previewEnabled, true);
  const gentleUi = await applyEffect('melt', 2, {durationFrames: 12, ending: 'continue', smooth: true});
  assert.equal(gentleUi.error, null, gentleUi.error);
  assert.equal(gentleUi.method, 'melt');
  assert.equal(gentleUi.mergedSamples, 99);
  assert.equal(gentleUi.effect.repeat, 2);
  assert.equal(gentleUi.effect.smooth, true);
  assert.equal(gentleUi.effect.window.releaseOutputIndex, 9);
  assert.deepEqual(gentleUi.effect.window.scheduledSourceSamples, [1, 1, 2, 2, 3, 3, 4, 6, 8, 10, 11, 12]);
  assert.equal(gentleUi.effect.window.tail.donorStartSample, 13);
  assert.equal(gentleUi.effect.scheduledSourceSamples.length, 74);
  assert.equal(gentleUi.patchedSamples, 72);
  assert.equal(gentleUi.previewEnabled, true);
  const loopUi = await applyEffect('loop', 4, {durationFrames: 12, ending: 'continue'});
  assert.equal(loopUi.error, null, loopUi.error);
  assert.equal(loopUi.method, 'loop');
  assert.equal(loopUi.mergedSamples, 99);
  assert.deepEqual(loopUi.effect.loopWindow, [1, 2]);
  assert.deepEqual(loopUi.effect.loopSecondWindow, []);
  assert.equal(loopUi.effect.window.windowOutputSamples, 12);
  assert.equal(loopUi.effect.window.tail.donorStartSample, 13);
  assert.equal(loopUi.effect.scheduledSourceSamples.length, 74);
  assert.equal(loopUi.patchedSamples, 72);
  const gentleLoopUi = await applyEffect('loop', 4, {durationFrames: 12, ending: 'continue', smooth: true});
  assert.equal(gentleLoopUi.error, null, gentleLoopUi.error);
  assert.equal(gentleLoopUi.method, 'loop');
  assert.equal(gentleLoopUi.mergedSamples, 99);
  assert.equal(gentleLoopUi.effect.smooth, true);
  assert.deepEqual(gentleLoopUi.effect.loopSchedule.positions, [0, 1, 0, 1, 0, 1, 3, 5, 7, 9, 10, 11]);
  assert.deepEqual(gentleLoopUi.effect.window.scheduledSourceSamples, [1, 2, 1, 2, 1, 2, 4, 6, 8, 10, 11, 12]);
  assert.deepEqual(gentleLoopUi.effect.loopSchedule.bridges, [{outputStart: 6, label: 'tail', frames: 3, fromDonor: 1, toDonor: 7}]);
  assert.equal(gentleLoopUi.effect.window.tail.donorStartSample, 13);
  assert.equal(gentleLoopUi.patchedSamples, 72);
  assert.equal(gentleLoopUi.previewEnabled, true);
  console.log('PASS browser Gentler Loop bridges to the release tail with <=2 donor advances and decodes 99 samples');
  const resetUi = await applyEffect('reset-pulse', null, {durationFrames: 12, interval: 6, repeat: 2});
  assert.equal(resetUi.error, null, resetUi.error);
  assert.equal(resetUi.method, 'reset-pulse');
  assert.equal(resetUi.mergedSamples, 99);
  assert.deepEqual(resetUi.resetPulse.resetOutputPositions, [25, 31]);
  assert.deepEqual(resetUi.resetPulse.patchCounts, [5, 5]);
  assert.equal(resetUi.resetPulse.tail.donorStartSample, 13);
  assert.equal(resetUi.patchedSamples, 70);
  assert.equal(resetUi.previewEnabled, true);
  await client.evaluate("document.querySelector('#show-modified').click()");
  await client.waitFor("document.querySelector('#preview-video').readyState >= 2 || document.querySelector('#preview-video').error", 15000);
  const effectPlayback = await client.evaluate(`({
    error: document.querySelector('#preview-video').error?.code ?? null,
    width: document.querySelector('#preview-video').videoWidth,
    height: document.querySelector('#preview-video').videoHeight
  })`);
  assert.equal(effectPlayback.error, null);
  assert.equal(effectPlayback.width, 320);
  assert.equal(effectPlayback.height, 240);
  console.log('PASS browser Melt, Gentler Melt, Loop Release, and Reset Pulse produce 105-, 99-, 99-, and 99-sample decodable sequences');

  await client.send('Page.navigate', {url: 'http://127.0.0.1:4182/?normalize-effect=1'});
  await client.waitFor("document.querySelector('#file-input-a') !== null && document.documentElement.dataset.appReady === 'true'", 10000);
  await client.setFile('#file-input-a', fixtures.a);
  await client.waitFor("document.querySelector('#status').textContent.includes('clip A')", 15000);
  await client.setFile('#file-input-b', fixtures.bFrameB);
  await client.waitFor("document.querySelector('#status').textContent.includes('samples') || !document.querySelector('#error').hidden", 30000);
  const normalizedEffect = await applyEffect('melt', 4, {durationFrames: 12, ending: 'continue'});
  assert.equal(normalizedEffect.error, null, normalizedEffect.error);
  assert.equal(normalizedEffect.method, 'melt');
  assert.ok(normalizedEffect.mergedSamples > 49);
  const normalizedEffectSources = await client.evaluate(`(() => {
    const report = JSON.parse(document.querySelector('#report').textContent);
    return {
      a: report.sources.a.conversion?.mode ?? null,
      b: report.sources.b.conversion?.mode ?? null,
      aEncode: report.sources.a.conversion?.encodeEngine ?? null,
      bEncode: report.sources.b.conversion?.encodeEngine ?? null,
    };
  })()`);
  assert.equal(normalizedEffectSources.a, 'normalized');
  assert.equal(normalizedEffectSources.b, 'normalized');
  assert.equal(normalizedEffectSources.aEncode, 'WebCodecs');
  assert.equal(normalizedEffectSources.bEncode, 'WebCodecs');
  console.log('PASS selecting Melt on native B-frame clips auto-normalizes both sources before applying the NAL effect');

  await client.send('Page.navigate', {url: 'http://127.0.0.1:4182/?audio-merge=1'});
  await client.waitFor("document.querySelector('#file-input-a') !== null && document.documentElement.dataset.appReady === 'true'", 10000);
  await client.setFile('#file-input-a', fixtures.audioA);
  await client.waitFor("document.querySelector('#status').textContent.includes('clip A')", 30000);
  await client.setFile('#file-input-b', fixtures.audioB);
  await client.waitFor(`(() => {
    if (!document.querySelector('#error').hidden) return true;
    const node = document.querySelector('#report');
    if (!node.textContent) return false;
    try {
      const report = JSON.parse(node.textContent);
      return report.stage === 'merged' && report.merge?.audio?.included === true;
    } catch { return false; }
  })()`, 120000);
  const audioState = await client.evaluate(`(() => {
    const node = document.querySelector('#report');
    let report = null;
    try { report = node.textContent ? JSON.parse(node.textContent) : null; } catch {}
    return {
      error: document.querySelector('#error').hidden ? null : document.querySelector('#error').textContent,
      status: document.querySelector('#status').textContent,
      audio: report?.merge?.audio ?? null,
      aAudio: report?.sources?.a?.audio ?? null,
      bAudio: report?.sources?.b?.audio ?? null,
      mergedSamples: report?.merge?.mergedSamples ?? null,
    };
  })()`);
  assert.ok(audioState.audio, `audio merge report missing; status=${audioState.status}; error=${audioState.error}`);
  assert.equal(audioState.error, null, audioState.error);
  assert.equal(audioState.aAudio.hasAudio, true);
  assert.equal(audioState.bAudio.hasAudio, true);
  assert.equal(audioState.mergedSamples, 49);
  assert.equal(audioState.audio.included, true);
  assert.equal(audioState.audio.sampleRate, 48000);
  assert.equal(audioState.audio.channels, 2);
  assert.equal(audioState.audio.expectedSamples, 94080);
  assert.equal(audioState.audio.segments[1].dropFrames, 1);
  assert.equal(audioState.audio.segments[1].availableFrames, 24);
  const audioSupport = await client.evaluate(`(async () => (await AudioEncoder.isConfigSupported({codec: 'mp4a.40.2', sampleRate: 48000, numberOfChannels: 2, bitrate: 128000})).supported)()`);
  assert.equal(audioState.audio.encodeEngine, audioSupport ? 'WebCodecs' : 'ffmpeg.wasm');
  assert.equal(audioState.audio.muxEngine, 'ffmpeg.wasm');

  rmSync(mergedPath, {force: true});
  await client.evaluate("document.querySelector('#export-button').click()");
  await waitForDownload(mergedPath, 30000);
  writeFileSync(audioMergedPath, readFileSync(mergedPath));
  const audioProbe = command('ffprobe', [
    '-v', 'error', '-show_entries', 'stream=codec_type,codec_name,sample_rate,channels,duration,nb_read_frames:format=duration',
    '-count_frames', '-of', 'json', audioMergedPath,
  ], 'audio merge probe');
  const audioProbeJson = JSON.parse(audioProbe.stdout);
  const audioStream = audioProbeJson.streams.find(stream => stream.codec_type === 'audio');
  const videoStream = audioProbeJson.streams.find(stream => stream.codec_type === 'video');
  assert.equal(audioStream.codec_name, 'aac');
  assert.equal(Number(audioStream.sample_rate), 48000);
  assert.equal(audioStream.channels, 2);
  assert.ok(Math.abs(Number(audioStream.duration) - 1.96) < 0.002, audioStream.duration);
  assert.ok(Math.abs(Number(videoStream.duration) - 1.96) < 0.002, videoStream.duration);
  assert.equal(Number(audioProbeJson.format.duration), Number(videoStream.duration));
  command('ffmpeg', ['-v', 'error', '-i', audioMergedPath, '-map', '0:a:0', '-f', 'null', '-'], 'audio stream strict decode');
  console.log(`PASS audio merge exports AAC ${audioStream.sample_rate} Hz/${audioStream.channels}ch, 94080 expected samples, runtime-matched duration, encode=${audioState.audio.encodeEngine}, mux=${audioState.audio.muxEngine}`);

  await client.evaluate(`(() => {
    const sound = document.querySelector('#sound-toggle');
    sound.checked = false;
    sound.dispatchEvent(new Event('change', {bubbles: true}));
  })()`);
  await client.waitFor(`(() => {
    if (!document.querySelector('#error').hidden) return true;
    try {
      const report = JSON.parse(document.querySelector('#report').textContent);
      return report.stage === 'merged' && report.merge?.audio?.included === false;
    } catch { return false; }
  })()`, 120000);
  const soundOff = await client.evaluate(`(() => {
    const report = JSON.parse(document.querySelector('#report').textContent);
    return {
      error: document.querySelector('#error').hidden ? null : document.querySelector('#error').textContent,
      checked: document.querySelector('#sound-toggle').checked,
      muted: document.querySelector('#preview-video').muted,
      stored: localStorage.getItem('m4shlab-audio'),
      audio: report.merge.audio,
      reportAudio: report.audio,
    };
  })()`);
  assert.equal(soundOff.error, null, soundOff.error);
  assert.equal(soundOff.checked, false);
  assert.equal(soundOff.muted, true);
  assert.equal(soundOff.stored, 'false');
  assert.equal(soundOff.audio.included, false);
  assert.equal(soundOff.audio.enabled, false);
  assert.equal(soundOff.reportAudio, false);
  rmSync(mergedPath, {force: true});
  rmSync(audioDisabledPath, {force: true});
  await client.evaluate("document.querySelector('#export-button').click()");
  await waitForDownload(mergedPath, 30000);
  writeFileSync(audioDisabledPath, readFileSync(mergedPath));
  const soundOffProbe = JSON.parse(command('ffprobe', [
    '-v', 'error', '-show_entries', 'stream=codec_type', '-of', 'json', audioDisabledPath,
  ], 'sound-off export probe').stdout);
  assert.equal(soundOffProbe.streams.some(stream => stream.codec_type === 'audio'), false);
  assert.equal(soundOffProbe.streams.some(stream => stream.codec_type === 'video'), true);

  await client.send('Page.navigate', {url: 'http://127.0.0.1:4182/?sound-persisted=1'});
  await client.waitFor("document.documentElement.dataset.appReady === 'true'", 10000);
  const persistedSound = await client.evaluate(`({
    checked: document.querySelector('#sound-toggle').checked,
    muted: document.querySelector('#preview-video').muted,
    stored: localStorage.getItem('m4shlab-audio'),
  })`);
  assert.deepEqual(persistedSound, {checked: false, muted: true, stored: 'false'});
  await client.evaluate(`(() => {
    const sound = document.querySelector('#sound-toggle');
    sound.checked = true;
    sound.dispatchEvent(new Event('change', {bubbles: true}));
  })()`);
  assert.equal(await client.evaluate("localStorage.getItem('m4shlab-audio')"), 'true');
  console.log('PASS sound off skips audio assembly/muxing, exports a video-only MP4, mutes preview, and persists across reload');

  const audioFallbackScript = await client.send('Page.addScriptToEvaluateOnNewDocument', {
    source: "Object.defineProperty(globalThis, 'AudioEncoder', {value: undefined, configurable: true});",
  });
  await client.send('Page.navigate', {url: 'http://127.0.0.1:4182/?audio-fallback=1'});
  await client.waitFor("document.querySelector('#file-input-a') !== null && document.documentElement.dataset.appReady === 'true'", 10000);
  assert.equal(await client.evaluate("typeof AudioEncoder"), 'undefined');
  await client.setFile('#file-input-a', fixtures.audioA);
  await client.waitFor("document.querySelector('#status').textContent.includes('clip A')", 30000);
  await client.setFile('#file-input-b', fixtures.audioB);
  await client.waitFor(`(() => {
    if (!document.querySelector('#error').hidden) return true;
    const node = document.querySelector('#report');
    if (!node.textContent) return false;
    try {
      const report = JSON.parse(node.textContent);
      return report.stage === 'merged' && report.merge?.audio?.included === true;
    } catch { return false; }
  })()`, 120000);
  const audioFallback = await client.evaluate(`(() => {
    const node = document.querySelector('#report');
    let report = null;
    try { report = node.textContent ? JSON.parse(node.textContent) : null; } catch {}
    return {
      error: document.querySelector('#error').hidden ? null : document.querySelector('#error').textContent,
      audio: report?.merge?.audio ?? null,
    };
  })()`);
  assert.equal(audioFallback.error, null, audioFallback.error);
  assert.equal(audioFallback.audio.encodeEngine, 'ffmpeg.wasm');
  assert.equal(audioFallback.audio.muxEngine, 'ffmpeg.wasm');
  assert.equal(audioFallback.audio.expectedSamples, 94080);
  assert.ok(audioFallback.audio.encoderDelaySamples >= 0);
  console.log(`PASS AudioEncoder unavailable: PCM encoded in ffmpeg.wasm and merged audio reports delay=${audioFallback.audio.encoderDelaySamples} samples`);
  await client.send('Page.removeScriptToEvaluateOnNewDocument', {identifier: audioFallbackScript.identifier});

  await client.send('Page.navigate', {url: 'http://127.0.0.1:4182/?clip-speed=1'});
  await client.waitFor("document.querySelector('#file-input-a') !== null && document.documentElement.dataset.appReady === 'true'", 10000);
  await client.setFile('#file-input-a', fixtures.speed);
  await client.waitFor("document.querySelector('#status').textContent.includes('clip A')", 30000);
  await client.setFile('#file-input-b', fixtures.speed);
  await client.waitFor(`(() => {
    const node = document.querySelector('#report');
    if (!node.textContent) return false;
    try {
      const report = JSON.parse(node.textContent);
      return report.stage === 'merged' && report.sources?.clips?.length === 2;
    } catch { return false; }
  })()`, 60000);
  const speedAtOne = await client.evaluate(`(() => {
    const report = JSON.parse(document.querySelector('#report').textContent);
    return {
      speeds: report.sources.clips.map(clip => clip.speed),
      inputFrames: report.sources.clips.map(clip => clip.input_frames),
      outputFrames: report.sources.clips.map(clip => clip.output_frames),
      conversions: report.sources.clips.map(clip => clip.conversion),
      sliderCount: document.querySelectorAll('.clip-speed input[type="range"]').length,
      sliderStep: document.querySelector('.clip-speed input[type="range"]')?.step,
      resetLabels: [...document.querySelectorAll('.clip-speed button')].map(button => button.textContent),
    };
  })()`);
  assert.deepEqual(speedAtOne.speeds, [1, 1]);
  assert.deepEqual(speedAtOne.inputFrames, [60, 60]);
  assert.deepEqual(speedAtOne.outputFrames, [60, 60]);
  assert.deepEqual(speedAtOne.conversions, [null, null]);
  assert.equal(speedAtOne.sliderCount, 2);
  assert.equal(speedAtOne.sliderStep, '0.1');
  assert.deepEqual(speedAtOne.resetLabels, ['Reset', 'Reset']);

  const setClipSpeed = async (index, speed, outputFrames) => {
    await client.evaluate(`(() => {
      const card = document.querySelectorAll('.clip-card')[${index}];
      const input = card.querySelector('.clip-speed input[type="range"]');
      input.value = '${speed}';
      input.dispatchEvent(new Event('input', {bubbles: true}));
      input.dispatchEvent(new Event('change', {bubbles: true}));
    })()`);
    await client.waitFor(`(() => {
      const node = document.querySelector('#report');
      if (!node.textContent) return false;
      try {
        const report = JSON.parse(node.textContent);
        const clip = report.sources?.clips?.[${index}];
        return clip?.speed === ${speed} && clip?.speedReport?.outputFrames === ${outputFrames};
      } catch { return false; }
    })()`, 120000);
  };
  await setClipSpeed(0, 2, 30);
  await setClipSpeed(1, 0.5, 120);

  await client.evaluate(`(() => {
    document.querySelector('.connector').click();
    const cut = document.querySelector('#transition-dialog input[value="cut"]');
    cut.checked = true;
    cut.dispatchEvent(new Event('change', {bubbles: true}));
    document.querySelector('#transition-apply').click();
  })()`);
  await client.waitFor(`(() => {
    const node = document.querySelector('#report');
    if (!node.textContent) return false;
    try {
      const report = JSON.parse(node.textContent);
      return report.stage === 'merged' && report.transitions?.[0]?.method === 'cut' && report.merge?.mergedSamples === 150;
    } catch { return false; }
  })()`, 120000);
  const speedMerge = await client.evaluate(`(() => {
    const report = JSON.parse(document.querySelector('#report').textContent);
    return {
      error: document.querySelector('#error').hidden ? null : document.querySelector('#error').textContent,
      sources: report.sources.clips.map(clip => ({
        speed: clip.speed,
        inputFrames: clip.input_frames,
        outputFrames: clip.output_frames,
        speedReport: clip.speedReport,
        target: clip.conversion?.target,
        reason: clip.conversion?.reason,
      })),
      transition: report.transitions[0],
      mergedSamples: report.merge.mergedSamples,
      audio: report.merge.audio,
    };
  })()`);
  assert.equal(speedMerge.error, null, speedMerge.error);
  assert.deepEqual(speedMerge.sources.map(source => source.speed), [2, 0.5]);
  assert.deepEqual(speedMerge.sources.map(source => source.inputFrames), [60, 60]);
  assert.deepEqual(speedMerge.sources.map(source => source.outputFrames), [30, 120]);
  assert.equal(speedMerge.transition.speed, 0.5);
  assert.equal(speedMerge.transition.input_frames, 60);
  assert.equal(speedMerge.transition.output_frames, 120);
  assert.equal(speedMerge.mergedSamples, 150);
  assert.equal(speedMerge.audio.included, true);
  assert.equal(speedMerge.audio.expectedSamples, 150 * 1600);
  assert.ok(speedMerge.sources.every(source => source.reason === 'speed-normalization'));
  assert.ok(speedMerge.sources.every(source => source.target.width === 320 && source.target.height === 240));

  rmSync(downloadDir, {recursive: true, force: true});
  mkdirSync(downloadDir, {recursive: true});
  rmSync(speedMergedPath, {force: true});
  await client.evaluate("document.querySelector('#export-button').click()");
  await waitForDownload(join(downloadDir, 'm4shlab-merge.mp4'), 30000);
  writeFileSync(speedMergedPath, readFileSync(join(downloadDir, 'm4shlab-merge.mp4')));
  const speedProbe = command('ffprobe', [
    '-v', 'error', '-count_frames',
    '-show_entries', 'stream=codec_type,avg_frame_rate,nb_read_frames,duration:format=duration',
    '-of', 'json', speedMergedPath,
  ], 'speed merge probe');
  const speedProbeJson = JSON.parse(speedProbe.stdout);
  const speedVideo = speedProbeJson.streams.find(stream => stream.codec_type === 'video');
  const speedAudio = speedProbeJson.streams.find(stream => stream.codec_type === 'audio');
  assert.equal(speedVideo.avg_frame_rate, '30/1');
  assert.equal(Number(speedVideo.nb_read_frames), 150);
  assert.ok(speedAudio);
  assert.ok(Math.abs(Number(speedAudio.duration) - 5) < 0.002, speedAudio.duration);
  command('ffmpeg', ['-v', 'error', '-i', speedMergedPath, '-f', 'null', '-'], 'speed merge strict decode');
  console.log(`PASS 2× + 0.5× clips merge to 150/150 frames and ${speedMerge.audio.expectedSamples} exact audio samples at 30 fps`);

  await client.send('Page.navigate', {url: 'http://127.0.0.1:4182/?fractional-speed=1'});
  await client.waitFor("document.querySelector('#file-input-a') !== null && document.documentElement.dataset.appReady === 'true'", 10000);
  await client.setFile('#file-input-a', fixtures.speed);
  await client.waitFor("document.querySelector('#status').textContent.includes('clip A')", 30000);
  await client.evaluate(`(() => {
    const input = document.querySelector('.clip-card .clip-speed input[type="range"]');
    input.value = '1.7';
    input.dispatchEvent(new Event('input', {bubbles: true}));
    input.dispatchEvent(new Event('change', {bubbles: true}));
  })()`);
  await client.waitFor("document.querySelector('.clip-card .clip-speed')?.title.startsWith('60 → 35 frames')", 120000);
  await client.waitFor("document.querySelector('#preview-video').readyState >= 2 || document.querySelector('#preview-video').error", 30000);
  const fractionalSpeed = await client.evaluate(`({
    title: document.querySelector('.clip-card .clip-speed').title,
    error: document.querySelector('#preview-video').error?.code ?? null,
    readyState: document.querySelector('#preview-video').readyState,
    width: document.querySelector('#preview-video').videoWidth,
    height: document.querySelector('#preview-video').videoHeight,
  })`);
  assert.match(fractionalSpeed.title, /^60 → 35 frames · audio 35 frames/);
  assert.equal(fractionalSpeed.error, null);
  assert.ok(fractionalSpeed.readyState >= 2);
  assert.equal(fractionalSpeed.width, 320);
  assert.equal(fractionalSpeed.height, 240);
  console.log('PASS fractional 1.7× produces 35 decodable frames with a 35-frame audio timeline');
  await client.evaluate("document.querySelector('.clip-card .clip-speed button').click()");
  await client.waitFor("document.querySelector('.clip-card .clip-speed')?.title.startsWith('60 → 60 frames')", 120000);
  const resetSpeed = await client.evaluate(`({
    title: document.querySelector('.clip-card .clip-speed').title,
    value: document.querySelector('.clip-card .clip-speed output').textContent,
    disabled: document.querySelector('.clip-card .clip-speed button').disabled,
  })`);
  assert.match(resetSpeed.title, /^60 → 60 frames/);
  assert.equal(resetSpeed.value, '1.0×');
  assert.equal(resetSpeed.disabled, true);
  console.log('PASS per-clip Reset restores 1.0× with 60 input and 60 output frames');

  await client.send('Page.navigate', {url: 'http://127.0.0.1:4182/?speed-target=1'});
  await client.waitFor("document.querySelector('#file-input-a') !== null && document.documentElement.dataset.appReady === 'true'", 10000);
  await client.setFile('#file-input-a', fixtures.largeA);
  await client.waitFor("document.querySelector('#status').textContent.includes('clip A')", 30000);
  await client.evaluate(`(() => {
    const input = document.querySelector('.clip-card .clip-speed input[type="range"]');
    input.value = '2';
    input.dispatchEvent(new Event('input', {bubbles: true}));
    input.dispatchEvent(new Event('change', {bubbles: true}));
  })()`);
  await client.waitFor("document.querySelector('.clip-card .clip-speed')?.title.startsWith('25 → 15 frames')", 120000);
  await client.waitFor("document.querySelector('#preview-video').videoWidth === 540 && document.querySelector('#preview-video').videoHeight === 720", 30000);
  const targetSpeed = await client.evaluate(`({
    title: document.querySelector('.clip-card .clip-speed').title,
    width: document.querySelector('#preview-video').videoWidth,
    height: document.querySelector('#preview-video').videoHeight,
    resetDisabled: document.querySelector('.clip-speed button').disabled,
  })`);
  assert.match(targetSpeed.title, /^25 → 15 frames/);
  assert.equal(targetSpeed.width, 540);
  assert.equal(targetSpeed.height, 720);
  assert.equal(targetSpeed.resetDisabled, false);
  console.log('PASS single clip speed=2 and 720px normalization run in one 540×720 WebCodecs pass');

  await client.send('Page.navigate', {url: 'http://127.0.0.1:4182/?clip-looks=1'});
  await client.waitFor("document.querySelector('#file-input-a') !== null && document.documentElement.dataset.appReady === 'true'", 10000);
  await client.setFile('#file-input-a', fixtures.speed);
  await client.waitFor("document.querySelector('#status').textContent.includes('clip A')", 30000);
  await client.setFile('#file-input-b', fixtures.speed);
  await client.waitFor(`(() => {
    if (!document.querySelector('#error').hidden) return true;
    try { return JSON.parse(document.querySelector('#report').textContent).stage === 'merged'; } catch { return false; }
  })()`, 120000);
  const lookControls = await client.evaluate(`(() => ({
    count: document.querySelectorAll('.clip-look select').length,
    values: [...document.querySelectorAll('.clip-look select')].map(select => select.value),
    options: [...document.querySelector('.clip-look select').options].map(option => option.textContent),
    disabled: [...document.querySelectorAll('.clip-look select')].some(select => select.disabled),
  }))()`);
  assert.equal(lookControls.count, 2);
  assert.deepEqual(lookControls.values, ['original', 'original']);
  assert.deepEqual(lookControls.options, ['Original', 'Black & white', 'B&W negative', 'Color negative']);
  assert.equal(lookControls.disabled, false);

  const setClipLook = async (index, look) => {
    await client.evaluate(`(() => {
      const select = document.querySelectorAll('.clip-look select')[${index}];
      select.value = ${JSON.stringify(look)};
      select.dispatchEvent(new Event('change', {bubbles: true}));
    })()`);
    await client.waitFor(`(() => {
      if (!document.querySelector('#error').hidden) return true;
      try {
        const report = JSON.parse(document.querySelector('#report').textContent);
        return report.stage === 'merged' && report.sources?.clips?.[${index}]?.lookReport?.look === ${JSON.stringify(look)};
      } catch { return false; }
    })()`, 120000);
  };
  await setClipLook(0, 'black-white');
  await setClipLook(1, 'color-negative');
  const lookReport = await client.evaluate(`(() => {
    const report = JSON.parse(document.querySelector('#report').textContent);
    return {
      error: document.querySelector('#error').hidden ? null : document.querySelector('#error').textContent,
      looks: report.sources.clips.map(clip => clip.look),
      prepared: report.sources.clips.map(clip => clip.preparedLook),
      reports: report.sources.clips.map(clip => clip.lookReport),
      reasons: report.sources.clips.map(clip => clip.conversion?.reason),
      boundaryLooks: report.transitions.map(transition => transition.look),
      selectValues: [...document.querySelectorAll('.clip-look select')].map(select => select.value),
    };
  })()`);
  assert.equal(lookReport.error, null, lookReport.error);
  assert.deepEqual(lookReport.looks, ['black-white', 'color-negative']);
  assert.deepEqual(lookReport.prepared, ['black-white', 'color-negative']);
  assert.deepEqual(lookReport.reasons, ['look-normalization', 'look-normalization']);
  assert.deepEqual(lookReport.boundaryLooks, ['color-negative']);
  assert.deepEqual(lookReport.selectValues, ['black-white', 'color-negative']);
  assert.ok(lookReport.reports.every(report => report.encodePasses === 1));
  assert.notEqual(lookReport.reports[0].cacheKey, lookReport.reports[1].cacheKey);
  assert.match(lookReport.reports[0].cacheKey, /black-white$/);
  assert.match(lookReport.reports[1].cacheKey, /color-negative$/);

  await client.evaluate("document.querySelector('#undo-button').click()");
  await client.waitFor("document.querySelectorAll('.clip-look select')[1]?.value === 'original' && JSON.parse(document.querySelector('#report').textContent).sources?.clips?.[1]?.look === 'original'", 120000);
  await client.evaluate("document.querySelector('#redo-button').click()");
  await client.waitFor("document.querySelectorAll('.clip-look select')[1]?.value === 'color-negative' && JSON.parse(document.querySelector('#report').textContent).sources?.clips?.[1]?.look === 'color-negative'", 120000);

  rmSync(mergedPath, {force: true});
  rmSync(looksMergedPath, {force: true});
  await client.evaluate("document.querySelector('#export-button').click()");
  await waitForDownload(mergedPath, 30000);
  writeFileSync(looksMergedPath, readFileSync(mergedPath));
  const looksProbe = command('ffprobe', [
    '-v', 'error', '-select_streams', 'v:0', '-count_frames',
    '-show_entries', 'stream=codec_name,width,height,nb_read_frames', '-of', 'default=noprint_wrappers=1', looksMergedPath,
  ], 'looks merge probe');
  const looksFrames = Number(/nb_read_frames=(\d+)/.exec(looksProbe.stdout)?.[1] ?? 0);
  assert.ok(looksFrames > 0);
  rmSync(looksFramePath, {force: true});
  command('ffmpeg', ['-v', 'error', '-y', '-ss', '0.5', '-i', looksMergedPath, '-frames:v', '1', '-pix_fmt', 'rgb24', '-f', 'rawvideo', looksFramePath], 'looks frame extract');
  const lookedRgb = readFileSync(looksFramePath);
  let largestChannelDelta = 0;
  for (let offset = 0; offset + 2 < lookedRgb.byteLength; offset += 3) {
    const r = lookedRgb[offset];
    const g = lookedRgb[offset + 1];
    const b = lookedRgb[offset + 2];
    largestChannelDelta = Math.max(largestChannelDelta, r - Math.min(g, b), g - Math.min(r, b), b - Math.min(r, g));
  }
  assert.ok(largestChannelDelta <= 4, `B&W export channel delta ${largestChannelDelta}`);
  command('ffmpeg', ['-v', 'error', '-i', looksMergedPath, '-f', 'null', '-'], 'looks merge strict decode');
  console.log(`PASS looks re-encode duplicate clips in one WebCodecs pass with distinct cache keys; undo/redo works and the ${looksFrames}-frame export's B&W half has channel delta <=4`);

  await client.send('Page.navigate', {url: 'http://127.0.0.1:4182/?single-pair=1'});
  await client.waitFor("document.querySelector('#file-input-a') !== null && document.documentElement.dataset.appReady === 'true'", 10000);
  await client.setFile('#file-input-a', fixtures.a);
  await client.waitFor("document.querySelector('#status').textContent.includes('clip A')", 15000);
  await client.setFile('#file-input-b', fixtures.b);
  await client.waitFor("document.querySelector('#status').textContent.includes('samples') || !document.querySelector('#error').hidden", 120000);
  const state = await client.evaluate(`(() => {
    const reportNode = document.querySelector('#report');
    return {
      status: document.querySelector('#status').textContent,
      error: document.querySelector('#error').hidden ? null : document.querySelector('#error').textContent,
      compatibilityMarkup: document.querySelector('#compatibility-panel, #compatibility-status, .compatibility-table'),
      conversionStatus: document.querySelector('#conversion-status').textContent,
      modifiedEnabled: !document.querySelector('#show-modified').disabled,
      exportEnabled: !document.querySelector('#export-button').disabled,
      report: reportNode.textContent ? JSON.parse(reportNode.textContent) : null,
    };
  })()`);
  assert.equal(state.error, null, state.error);
  assert.equal(state.compatibilityMarkup, null, 'Compatibility UI must not exist');
  assert.equal(state.conversionStatus, 'normalized via WebCodecs');
  assert.equal(state.modifiedEnabled, true);
  assert.equal(state.exportEnabled, true);
  assert.equal(state.report.sources.a.mode, 'normalized via WebCodecs');
  assert.equal(state.report.sources.b.mode, 'normalized via WebCodecs');
  assert.ok(state.report.sources.a.conversion.elapsedMs >= 0);
  assert.ok(state.report.sources.b.conversion.elapsedMs >= 0);
  assert.equal(state.report.merge.frameAlignment.patchedSamples, 24);
  assert.equal(state.report.merge.mergedSamples, 49);
  assert.equal(state.report.merge.idrCount, 1);
  assert.equal(state.report.merge.startsWithSingleIdr, true);
  await client.waitFor("document.querySelector('#preview-video').readyState >= 2 || document.querySelector('#preview-video').error", 15000);
  await client.evaluate(`(() => {
    const video = document.querySelector('#preview-video');
    video.currentTime = 0.5;
    video.dispatchEvent(new Event('timeupdate'));
  })()`);
  const clipPreview = await client.evaluate(`({
    label: document.querySelector('#preview-label').textContent,
    time: document.querySelector('#preview-time').textContent,
    soundChecked: document.querySelector('#sound-toggle').checked,
    muted: document.querySelector('#preview-video').muted,
    expectedTime: document.querySelector('#preview-video').currentTime.toFixed(2) + ' / ' + document.querySelector('#preview-video').duration.toFixed(2) + ' s',
  })`);
  assert.equal(clipPreview.label, 'Clip preview · synthetic-b-a.mp4');
  assert.equal(clipPreview.time, clipPreview.expectedTime);
  assert.match(clipPreview.time, /^0\.50 \/ 0\.[0-9]{2} s$/);
  assert.equal(clipPreview.soundChecked, true);
  assert.equal(clipPreview.muted, false);
  await client.evaluate("document.querySelector('#show-modified').click()");
  await client.waitFor("document.querySelector('#preview-video').readyState >= 2 || document.querySelector('#preview-video').error", 15000);
  const assembledLabel = await client.evaluate("document.querySelector('#preview-label').textContent");
  assert.equal(assembledLabel, 'Assembled preview · all clips and transitions');
  console.log('PASS preview labels switch between filename clip view and assembled sequence; time readout tracks current/duration and sound defaults on');
  const playback = await client.evaluate(`({
    readyState: document.querySelector('#preview-video').readyState,
    error: document.querySelector('#preview-video').error?.code ?? null,
    width: document.querySelector('#preview-video').videoWidth,
    height: document.querySelector('#preview-video').videoHeight
  })`);
  assert.equal(playback.error, null);
  assert.equal(playback.width, 320);
  assert.equal(playback.height, 240);
  console.log(`PASS WebCodecs pair merged in the browser: ${state.report.merge.mergedSamples} samples, one leading IDR, preview ${playback.width}x${playback.height}`);

  rmSync(downloadDir, {recursive: true, force: true});
  mkdirSync(downloadDir, {recursive: true});
  rmSync(mergedPath, {force: true});
  await client.evaluate("document.querySelector('#export-button').click()");
  await waitForDownload(mergedPath);
  const mergedBytes = new Uint8Array(readFileSync(mergedPath));
  const mergedParsed = parseMp4(mergedBytes);
  const mergedNals = extractNals(mergedBytes, mergedParsed.videoTrack);
  assert.equal(mergedParsed.videoTrack.samples.length, 49);
  assert.equal(mergedNals.filter(nal => nal.type === 5).length, 1);
  assert.equal(mergedNals.filter(nal => nal.sampleIndex === 0 && nal.type === 5).length, 1);
  const stszSum = mergedParsed.videoTrack.sampleSizes.sizes.reduce((total, value) => total + value, 0);
  const mdatLength = mergedParsed.mdatRanges.reduce((total, box) => total + box.payloadEnd - box.payloadStart, 0);
  assert.equal(stszSum, mdatLength);
  assert.ok(mergedParsed.videoTrack.samples.every((sample, index, samples) => index === 0 || sample.offset > samples[index - 1].offset));

  const probe = command('ffprobe', [
    '-v', 'error', '-select_streams', 'v:0', '-count_frames',
    '-show_entries', 'stream=codec_name,pix_fmt,color_range,width,height,has_b_frames,avg_frame_rate,nb_read_frames',
    '-of', 'default=noprint_wrappers=1', mergedPath,
  ], 'WebCodecs merged export probe');
  assert.match(probe.stdout, /codec_name=h264/);
  assert.match(probe.stdout, /pix_fmt=yuv420p/);
  assert.match(probe.stdout, /color_range=tv/);
  assert.match(probe.stdout, /width=320/);
  assert.match(probe.stdout, /height=240/);
  assert.match(probe.stdout, /has_b_frames=0/);
  assert.match(probe.stdout, /avg_frame_rate=30\/1/);
  assert.match(probe.stdout, /nb_read_frames=49/);
  command('ffmpeg', ['-v', 'error', '-i', mergedPath, '-f', 'null', '-'], 'WebCodecs merged strict decode');
  const streamTypes = command('ffprobe', [
    '-v', 'error', '-show_entries', 'stream=codec_type', '-of', 'default=noprint_wrappers=1:nokey=1', mergedPath,
  ], 'WebCodecs merged stream inventory');
  assert.equal(streamTypes.stdout.trim(), 'video');
  console.log(`PASS merged export decodes: 49 frames, H.264 320x240 yuv420p/tv, SHA-256 ${sha256(mergedBytes)}`);

  let fallbackAssets = true;
  try {
    const response = await fetch('https://cdn.jsdelivr.net/npm/@ffmpeg/core@0.12.10/dist/esm/ffmpeg-core.wasm', {method: 'HEAD'});
    fallbackAssets = response.ok;
  } catch {
    fallbackAssets = false;
  }
  if (!fallbackAssets) {
    console.log('SKIP ffmpeg.wasm fallback browser check: CDN assets are unavailable offline.');
  } else {
    await client.send('Page.navigate', {url: 'http://127.0.0.1:4182/?hybrid=1'});
    await client.waitFor("document.querySelector('#file-input-a') !== null && document.documentElement.dataset.appReady === 'true'", 10000);
    await client.setFile('#file-input-a', join(projectRoot, 'testmedia', 'synthetic-hevc.mov'));
    await client.waitFor("document.querySelector('#status').textContent.includes('clip A') || /failed/i.test(document.querySelector('#conversion-status').textContent)", 180000);
    await client.setFile('#file-input-b', join(projectRoot, 'testmedia', 'synthetic-hevc-small.mov'));
    await client.waitFor("document.querySelector('#status').textContent.includes('samples') || !document.querySelector('#error').hidden", 300000);
    const hybrid = await client.evaluate(`(() => {
      const reportNode = document.querySelector('#report');
      return {
        conversionStatus: document.querySelector('#conversion-status').textContent,
        conversionMessage: document.querySelector('#conversion-message').textContent,
        error: document.querySelector('#error').hidden ? null : document.querySelector('#error').textContent,
        progressA: document.querySelector('#conversion-progress').value,
        progressB: document.querySelector('#conversion-progress-b').value,
        progressBHidden: document.querySelector('#conversion-progress-b-row').hidden,
        report: reportNode.textContent ? JSON.parse(reportNode.textContent) : null,
      };
    })()`);
    assert.equal(hybrid.error, null, hybrid.error || 'hybrid pair was not compatible');
    const sourceConversionA = hybrid.report.sources.a.conversion.origin ?? hybrid.report.sources.a.conversion;
    const sourceConversionB = hybrid.report.sources.b.conversion.origin ?? hybrid.report.sources.b.conversion;
    assert.equal(sourceConversionA.sourceCodec, 'HEVC');
    assert.equal(sourceConversionB.sourceCodec, 'HEVC');
    assert.ok(['WebCodecs (HEVC)', 'ffmpeg.wasm'].includes(sourceConversionA.decodeEngine));
    assert.ok(['WebCodecs (HEVC)', 'ffmpeg.wasm'].includes(sourceConversionB.decodeEngine));
    if (sourceConversionA.decodeEngine === 'ffmpeg.wasm') {
      assert.match(sourceConversionA.hevcWebCodecsFallbackReason, /HEVC configuration/i);
      assert.match(hybrid.conversionMessage, /decoded via ffmpeg\.wasm/);
    } else {
      assert.match(hybrid.conversionMessage, /decoded via WebCodecs \(HEVC\)/);
    }
    assert.equal(hybrid.report.normalization.engines[0].sourceCodec, 'HEVC');
    assert.equal(hybrid.report.normalization.engines[1].sourceCodec, 'HEVC');
    assert.equal(hybrid.report.normalization.engines[0].decode, sourceConversionA.decodeEngine);
    assert.equal(hybrid.report.normalization.engines[1].decode, sourceConversionB.decodeEngine);
    assert.equal(hybrid.report.normalization.autoNormalized, true);
    assert.equal(hybrid.report.normalization.parallel, true);
    assert.ok(Math.max(hybrid.report.normalization.target.width, hybrid.report.normalization.target.height) <= 720);
    assert.equal(hybrid.progressA, 1);
    assert.equal(hybrid.progressB, 1);
    assert.equal(hybrid.progressBHidden, false);
    rmSync(hybridExportPath, {force: true});
    const downloadedHybrid = join(downloadDir, 'm4shlab-merge.mp4');
    rmSync(downloadedHybrid, {force: true});
    await client.evaluate("document.querySelector('#export-button').click()");
    await waitForDownload(downloadedHybrid);
    writeFileSync(hybridExportPath, readFileSync(downloadedHybrid));
    const hybridProbe = command('ffprobe', [
      '-v', 'error', '-select_streams', 'v:0', '-count_frames',
      '-show_entries', 'stream=codec_name,width,height,nb_read_frames', '-of', 'default=noprint_wrappers=1', hybridExportPath,
    ], 'hybrid conversion export probe');
    assert.match(hybridProbe.stdout, /codec_name=h264/);
    assert.ok(Number(/nb_read_frames=(\d+)/.exec(hybridProbe.stdout)?.[1] ?? 0) > 0);
    console.log(`PASS HEVC import ran ${sourceConversionA.decodeEngine} decode plus WebCodecs H.264 encode at ${hybrid.report.normalization.target.width}x${hybrid.report.normalization.target.height}; both progress bars completed and export decoded`);

    const nativeChrome = await launchChrome({disableGpu: false});
    if (nativeChrome) {
      let nativeClient = null;
      try {
        nativeClient = await pageTarget(nativeChrome.endpoint);
        await nativeClient.send('Page.enable');
        await nativeClient.send('Runtime.enable');
        await nativeClient.send('DOM.enable');
        await nativeClient.send('Emulation.setDeviceMetricsOverride', {width: 1200, height: 1600, deviceScaleFactor: 1, mobile: false});
        await nativeClient.send('Page.navigate', {url: 'http://127.0.0.1:4182/?hevc-native=1'});
        await nativeClient.waitFor("document.querySelector('#file-input-a') !== null && document.documentElement.dataset.appReady === 'true'", 15000);
        await nativeClient.setFile('#file-input-a', join(projectRoot, 'testmedia', 'synthetic-hevc.mov'));
        await nativeClient.waitFor("document.querySelector('#status').textContent.includes('clip A') || !document.querySelector('#error').hidden", 60000);
        await nativeClient.setFile('#file-input-b', join(projectRoot, 'testmedia', 'synthetic-hevc.mov'));
        await nativeClient.waitFor("document.querySelector('#status').textContent.includes('samples') || !document.querySelector('#error').hidden", 120000);
        const nativeHevc = await nativeClient.evaluate(`(() => {
          const report = JSON.parse(document.querySelector('#report').textContent);
          const source = report.sources.a.conversion.origin ?? report.sources.a.conversion;
          return {
            error: document.querySelector('#error').hidden ? null : document.querySelector('#error').textContent,
            sourceCodec: source.sourceCodec,
            decodeEngine: source.decodeEngine,
            encodeEngine: source.encodeEngine,
            decoderCodec: source.decoderCodec,
            fallbackReason: source.hevcWebCodecsFallbackReason ?? null,
            status: document.querySelector('#conversion-status').textContent,
            message: document.querySelector('#conversion-message').textContent,
            mergedSamples: report.merge.mergedSamples,
          };
        })()`);
        assert.equal(nativeHevc.error, null, nativeHevc.error);
        if (nativeHevc.decodeEngine === 'WebCodecs (HEVC)') {
          assert.equal(nativeHevc.sourceCodec, 'HEVC');
          assert.equal(nativeHevc.encodeEngine, 'WebCodecs');
          assert.match(nativeHevc.decoderCodec, /^hvc1\.|^hev1\./);
          assert.equal(nativeHevc.fallbackReason, null);
          assert.match(nativeHevc.message, /decoded via WebCodecs \(HEVC\)/);
          assert.ok(nativeHevc.mergedSamples > 0);
          console.log(`PASS native HEVC decoded via WebCodecs and merged ${nativeHevc.mergedSamples} samples through the unchanged H.264 path`);
        } else {
          assert.equal(nativeHevc.decodeEngine, 'ffmpeg.wasm');
          assert.match(nativeHevc.fallbackReason, /HEVC configuration/i);
          console.log('SKIP native HEVC WebCodecs: this Chrome build exposed no HEVC decoder; the named ffmpeg.wasm path was verified.');
        }
      } finally {
        nativeClient?.close();
        nativeChrome.process.kill('SIGTERM');
        await new Promise(resolveWait => setTimeout(resolveWait, 250));
        try { rmSync(nativeChrome.profile, {recursive: true, force: true, maxRetries: 5, retryDelay: 100}); } catch {}
      }
    }

    await client.send('Page.addScriptToEvaluateOnNewDocument', {
      source: "Object.defineProperty(globalThis, 'VideoDecoder', {value: undefined, configurable: true}); Object.defineProperty(globalThis, 'VideoEncoder', {value: undefined, configurable: true});",
    });
    await client.send('Page.navigate', {url: 'http://127.0.0.1:4182/?hevc-fallback=1'});
    await client.waitFor("document.querySelector('#file-input-a') !== null && document.documentElement.dataset.appReady === 'true'", 10000);
    assert.equal(await client.evaluate("typeof VideoDecoder + '/' + typeof VideoEncoder"), 'undefined/undefined');
    await client.setFile('#file-input-a', join(projectRoot, 'testmedia', 'synthetic-hevc.mov'));
    await client.waitFor("document.querySelector('#status').textContent.includes('clip A') || !document.querySelector('#error').hidden", 300000);
    const forcedHevcFallback = await client.evaluate(`({
      error: document.querySelector('#error').hidden ? null : document.querySelector('#error').textContent,
      status: document.querySelector('#conversion-status').textContent,
      message: document.querySelector('#conversion-message').textContent,
      clipPath: document.querySelector('.clip-card .clip-detail')?.title ?? null,
    })`);
    assert.equal(forcedHevcFallback.error, null, forcedHevcFallback.error);
    assert.match(forcedHevcFallback.status, /ffmpeg\.wasm/);
    assert.match(forcedHevcFallback.message, /decoded via ffmpeg\.wasm/);
    assert.match(forcedHevcFallback.clipPath, /decoded via ffmpeg\.wasm/);
    console.log('PASS WebCodecs unavailable: HEVC import names the ffmpeg.wasm decode fallback and produces a playable converted clip');
    await client.send('Page.navigate', {url: 'http://127.0.0.1:4182/?fallback=1'});
    await client.waitFor("document.querySelector('#file-input-a') !== null && document.documentElement.dataset.appReady === 'true'", 10000);
    assert.equal(await client.evaluate("typeof VideoDecoder + '/' + typeof VideoEncoder"), 'undefined/undefined');
    await client.setFile('#file-input-a', fixtures.a);
    await client.waitFor("document.querySelector('#status').textContent.includes('clip A')", 15000);
    await client.setFile('#file-input-b', fixtures.b);
    await client.waitFor("document.querySelector('#status').textContent.includes('samples') || !document.querySelector('#error').hidden", 600000);
    const fallback = await client.evaluate(`(() => {
      const report = JSON.parse(document.querySelector('#report').textContent);
      return {
        conversionStatus: document.querySelector('#conversion-status').textContent,
        error: document.querySelector('#error').hidden ? null : document.querySelector('#error').textContent,
        sources: report.sources,
      };
    })()`);
    assert.equal(fallback.error, null, fallback.error);
    assert.equal(fallback.conversionStatus, 'normalized via ffmpeg.wasm');
    assert.equal(fallback.sources.a.mode, 'normalized via ffmpeg.wasm');
    assert.equal(fallback.sources.b.mode, 'normalized via ffmpeg.wasm');
    assert.equal(fallback.sources.a.conversion.encodeEngine, 'ffmpeg.wasm');
    assert.equal(fallback.sources.b.conversion.encodeEngine, 'ffmpeg.wasm');
    assert.ok(fallback.sources.a.conversion.elapsedMs > 0);
    assert.ok(fallback.sources.b.conversion.elapsedMs > 0);
    console.log('PASS WebCodecs stubbed unavailable: ffmpeg.wasm fallback ran and the report identifies it');
  }

  if (client.exceptions.length) throw new Error(`Browser exceptions:\n${client.exceptions.join('\n')}`);
} finally {
  client?.close();
  chrome?.process.kill('SIGTERM');
  server.kill('SIGTERM');
  await new Promise(resolveWait => setTimeout(resolveWait, 300));
  if (chrome?.profile) {
    try {
      rmSync(chrome.profile, {recursive: true, force: true, maxRetries: 5, retryDelay: 100});
    } catch {}
  }
}
