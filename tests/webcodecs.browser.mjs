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
  poc0A: join(projectRoot, 'testmedia', 'synthetic-multigop-poc0-a.mp4'),
  poc0B: join(projectRoot, 'testmedia', 'synthetic-multigop-poc0-b.mp4'),
};
const normalizedPaths = {
  a: join(projectRoot, 'testmedia', 'webcodecs-browser-normalized-a.mp4'),
  b: join(projectRoot, 'testmedia', 'webcodecs-browser-normalized-b.mp4'),
};
const downloadDir = join(projectRoot, 'testmedia', 'webcodecs-browser-downloads');
const mergedPath = join(downloadDir, 'm4shlab-merge.mp4');
const multiGopMergedPath = join(projectRoot, 'testmedia', 'webcodecs-browser-multigop-merged.mp4');
const hybridExportPath = join(projectRoot, 'testmedia', 'webcodecs-hybrid-export.mp4');
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
    const response = await this.send('Runtime.evaluate', {expression: `document.querySelector(${JSON.stringify(selector)})`});
    await this.send('DOM.setFileInputFiles', {objectId: response.result.objectId, files: [path]});
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

async function launchChrome() {
  const chrome = chromeCandidates.find(candidate => existsSync(candidate));
  if (!chrome) return null;
  const profile = mkdtempSync(join(tmpdir(), 'm4shlab-webcodecs-'));
  const process = spawn(chrome, [
    '--headless=new',
    '--remote-debugging-port=0',
    `--user-data-dir=${profile}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-gpu',
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
  await client.waitFor("document.querySelector('#file-input-a') !== null", 10000);

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
  await client.waitFor("document.querySelector('#file-input-a') !== null", 10000);
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
  await client.waitFor("document.querySelector('#file-input-a') !== null", 10000);
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
  await client.waitFor("document.querySelector('#file-input-a') !== null", 10000);
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

  await client.send('Page.navigate', {url: 'http://127.0.0.1:4182/?single-pair=1'});
  await client.waitFor("document.querySelector('#file-input-a') !== null", 10000);
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
  await client.evaluate("document.querySelector('#show-modified').click()");
  await client.waitFor("document.querySelector('#preview-video').readyState >= 2 || document.querySelector('#preview-video').error", 15000);
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
    await client.waitFor("document.querySelector('#file-input-a') !== null", 10000);
    await client.setFile('#file-input-a', join(projectRoot, 'testmedia', 'synthetic-hevc.mov'));
    await client.waitFor("document.querySelector('#status').textContent.includes('clip A') || /failed/i.test(document.querySelector('#conversion-status').textContent)", 180000);
    await client.setFile('#file-input-b', join(projectRoot, 'testmedia', 'synthetic-hevc-small.mov'));
    await client.waitFor("document.querySelector('#status').textContent.includes('samples') || !document.querySelector('#error').hidden", 300000);
    const hybrid = await client.evaluate(`(() => {
      const reportNode = document.querySelector('#report');
      return {
        conversionStatus: document.querySelector('#conversion-status').textContent,
        error: document.querySelector('#error').hidden ? null : document.querySelector('#error').textContent,
        progressA: document.querySelector('#conversion-progress').value,
        progressB: document.querySelector('#conversion-progress-b').value,
        progressBHidden: document.querySelector('#conversion-progress-b-row').hidden,
        report: reportNode.textContent ? JSON.parse(reportNode.textContent) : null,
      };
    })()`);
    assert.equal(hybrid.error, null, hybrid.error || 'hybrid pair was not compatible');
    assert.match(hybrid.conversionStatus, /ffmpeg\.wasm \+ WebCodecs/);
    assert.equal(hybrid.report.sources.a.conversion.decodeEngine, 'ffmpeg.wasm');
    assert.equal(hybrid.report.sources.a.conversion.encodeEngine, 'WebCodecs');
    assert.equal(hybrid.report.sources.b.conversion.encodeEngine, 'WebCodecs');
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
    console.log(`PASS ffmpeg.wasm decode + WebCodecs encode: ${hybrid.report.normalization.target.width}x${hybrid.report.normalization.target.height}, both progress bars completed, export decoded`);

    await client.send('Page.addScriptToEvaluateOnNewDocument', {
      source: "Object.defineProperty(globalThis, 'VideoDecoder', {value: undefined, configurable: true}); Object.defineProperty(globalThis, 'VideoEncoder', {value: undefined, configurable: true});",
    });
    await client.send('Page.navigate', {url: 'http://127.0.0.1:4182/?fallback=1'});
    await client.waitFor("document.querySelector('#file-input-a') !== null", 10000);
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
