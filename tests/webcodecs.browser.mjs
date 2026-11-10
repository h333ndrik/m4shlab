import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {dirname, join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawn, spawnSync} from 'node:child_process';
import {parseMp4} from '../parser/mp4.js';
import {closeDialog as closeDialogShared} from './helpers/cdp-harness.mjs';
import {extractNals} from '../parser/nal.js';

const projectRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

const checkTally = {passed: 0, skipped: []};
const logLine = console.log.bind(console);
console.log = (...args) => {
  const first = typeof args[0] === 'string' ? args[0] : '';
  if (first.startsWith('PASS ')) checkTally.passed += 1;
  else if (first.startsWith('SKIP ')) checkTally.skipped.push(first.slice(5));
  logLine(...args);
};
let summaryPrinted = false;
function printSummary() {
  if (summaryPrinted) return;
  summaryPrinted = true;
  const skipped = checkTally.skipped.length;
  const allowed = process.env.M4SHLAB_ALLOW_SKIPS === '1';
  const state = skipped === 0 ? 'complete' : allowed ? 'INCOMPLETE, allowed by M4SHLAB_ALLOW_SKIPS=1' : 'INCOMPLETE - skipped checks did not run';
  logLine(`SUMMARY WebCodecs browser suite: passed ${checkTally.passed} / skipped ${skipped} (${state})${skipped ? ` :: ${checkTally.skipped.join(' | ')}` : ''}`);
}
process.on('exit', printSummary);

function skipExitCode() {
  return checkTally.skipped.length > 0 && process.env.M4SHLAB_ALLOW_SKIPS !== '1' ? 2 : 0;
}
const port = Number(process.env.WEBCODECS_TEST_PORT || 4182);
const baseUrl = `http://127.0.0.1:${port}/`;
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
  fragmented: join(projectRoot, 'testmedia', 'synthetic-fragmented.mp4'),
};
const normalizedPaths = {
  a: join(projectRoot, 'testmedia', 'webcodecs-browser-normalized-a.mp4'),
  b: join(projectRoot, 'testmedia', 'webcodecs-browser-normalized-b.mp4'),
};
const downloadDir = mkdtempSync(join(tmpdir(), 'm4shlab-webcodecs-downloads-'));
const mergedPath = join(downloadDir, 'm4shlab-merge.mp4');
const audioMergedPath = join(projectRoot, 'testmedia', 'webcodecs-audio-merged.mp4');
const speedMergedPath = join(projectRoot, 'testmedia', 'webcodecs-speed-merged.mp4');
const multiGopMergedPath = join(projectRoot, 'testmedia', 'webcodecs-browser-multigop-merged.mp4');
const multiGopMergeWindowPath = join(projectRoot, 'testmedia', 'webcodecs-browser-mosh-window.mp4');
const fallbackCadencePath = join(projectRoot, 'testmedia', 'webcodecs-fallback-cadence.mp4');
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
  printSummary();
  process.exit(skipExitCode());
}

const closeDialog = selector => closeDialogShared(client, selector);

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
    this.events = [];
    this.eventWaiters = [];
    this.socket.onmessage = event => {
      const message = JSON.parse(event.data);
      if (message.id) {
        const pending = this.pending.get(message.id);
        if (!pending) return;
        this.pending.delete(message.id);
        if (message.error) pending.reject(new Error(message.error.message));
        else pending.resolve(message.result);
      } else {
        this.events.push(message);
        if (message.method === 'Runtime.exceptionThrown') {
          this.exceptions.push(message.params.exceptionDetails.exception?.description ?? message.params.exceptionDetails.text);
        }
        for (const waiter of [...this.eventWaiters]) {
          if (waiter.method !== message.method) continue;
          this.eventWaiters.splice(this.eventWaiters.indexOf(waiter), 1);
          clearTimeout(waiter.timer);
          waiter.resolve(message);
        }
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
    const response = await this.send('Runtime.evaluate', {expression, awaitPromise: true, returnByValue: true, includeCommandLineAPI: true});
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

  waitForEvent(method, timeout = 5000) {
    const prior = this.events.find(event => event.method === method);
    if (prior) return Promise.resolve(prior);
    return new Promise((resolveEvent, rejectEvent) => {
      const timer = setTimeout(() => {
        this.eventWaiters = this.eventWaiters.filter(waiter => waiter.resolve !== resolveEvent);
        rejectEvent(new Error(`Timeout waiting for ${method}`));
      }, timeout);
      this.eventWaiters.push({method, resolve: resolveEvent, timer});
    });
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

function removeElementsScript(ids) {
  return `(() => {
    const targets = new Set(${JSON.stringify(ids)});
    const drop = node => {
      if (node && node.nodeType === 1 && node.id && targets.has(node.id)) node.remove();
    };
    new MutationObserver(records => {
      for (const record of records) {
        for (const node of record.addedNodes) {
          if (node.nodeType !== 1) continue;
          drop(node);
          for (const child of node.querySelectorAll('[id]')) drop(child);
        }
      }
    }).observe(document, {childList: true, subtree: true});
  })();`;
}

function consoleMessages(client, fromIndex) {
  return client.events.slice(fromIndex)
    .filter(event => event.method === 'Runtime.consoleAPICalled')
    .map(event => ({
      type: event.params.type,
      text: event.params.args.map(arg => arg.value ?? arg.description ?? '').join(' '),
    }));
}

function framePixels(path, index) {
  const result = spawnSync('ffmpeg', [
    '-v', 'error', '-i', path,
    '-vf', `select=eq(n\\,${index})`, '-vframes', '1',
    '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-',
  ], {cwd: projectRoot, maxBuffer: 64 * 1024 * 1024});
  if (result.status !== 0) throw new Error(`ffmpeg could not extract frame ${index} of ${path}: ${result.stderr}`);
  return result.stdout;
}

function toLumaRgb(buffer) {
  const output = Buffer.from(buffer);
  for (let index = 0; index + 2 < output.length; index += 3) {
    const luma = Math.round(0.299 * output[index] + 0.587 * output[index + 1] + 0.114 * output[index + 2]);
    output[index] = luma;
    output[index + 1] = luma;
    output[index + 2] = luma;
  }
  return output;
}

function meanAbsRgbDiff(left, right) {
  const length = Math.min(left.length, right.length);
  let total = 0;
  let channels = 0;
  for (let index = 0; index + 2 < length; index += 3) {
    total += Math.abs(left[index] - right[index])
      + Math.abs(left[index + 1] - right[index + 1])
      + Math.abs(left[index + 2] - right[index + 2]);
    channels += 3;
  }
  return channels ? total / channels : Number.NaN;
}

function meanChromaSpread(buffer) {
  let total = 0;
  let pixels = 0;
  for (let index = 0; index + 2 < buffer.length; index += 3) {
    total += Math.abs(buffer[index] - buffer[index + 1]) + Math.abs(buffer[index + 1] - buffer[index + 2]);
    pixels += 2;
  }
  return pixels ? total / pixels : Number.NaN;
}

function requiredFixturesExist() {
  return Object.values(fixtures).every(path => existsSync(path));
}

if (typeof WebSocket !== 'function') skip('this Node version has no built-in WebSocket client; run with Node 22+ or use Playwright.');
if (!requiredFixturesExist()) command('bash', ['testmedia/generate.sh'], 'fixture generation');

server = spawn(process.execPath, ['scripts/serve.mjs'], {
  cwd: projectRoot,
  env: {...process.env, PORT: String(port)},
  stdio: 'ignore',
});
try {
  const serverStarted = Date.now() + 5000;
  while (Date.now() < serverStarted) {
    try {
      const response = await fetch(baseUrl);
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
  await client.send('Page.navigate', {url: `${baseUrl}`});
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

  const emptyState = await client.evaluate(`(() => {
    const button = document.querySelector('#export-button');
    const style = getComputedStyle(button);
    return {
      time: document.querySelector('#preview-time').textContent,
      heading: document.querySelector('#source-heading').textContent,
      header: document.querySelector('header h1').textContent,
      tagline: document.querySelector('header p'),
      importLabel: document.querySelector('.file-actions .button').textContent.trim(),
      projectName: document.querySelector('#project-name')?.value,
      projectMaxLength: document.querySelector('#project-name')?.maxLength,
      projectAria: document.querySelector('#project-name')?.getAttribute('aria-label'),
      exportLabel: button.textContent.trim(),
      previewOrder: [...document.querySelector('.preview-options').children].map(node => node.id === 'preview-time' ? 'time' : node.classList.contains('sound-toggle') ? 'sound' : node.classList.contains('software-toggle') ? 'software' : node.id),
      sequenceOrder: [...document.querySelectorAll('.section-tools > *, .section-tools .history-tools > *')].map(node => node.id).filter(Boolean),
      footerActionOrder: [...document.querySelectorAll('.limits .actions button')].map(node => node.id),
      footer: document.querySelector('.limits p').textContent,
      legacyReport: document.querySelector('#report-panel, .report-panel'),
      bitstreamOpen: document.querySelector('#bitstream-report').open,
      bitstreamSummary: document.querySelector('#bitstream-report summary').textContent,
      bitstreamText: document.querySelector('#bitstream-report-json').textContent,
      saveDisabled: document.querySelector('#save-settings').disabled,
      loadDisabled: document.querySelector('#load-settings').disabled,
      disabled: button.disabled,
      background: style.backgroundColor,
      color: style.color,
      opacity: style.opacity,
      cursor: style.cursor,
    };
  })()`);
  assert.equal(emptyState.time, '0.00 / 0.00 s');
  assert.equal(emptyState.heading, 'Sequence');
  assert.equal(emptyState.header, 'm4shlab');
  assert.equal(emptyState.tagline, null);
  assert.equal(emptyState.importLabel, '+ Import videos');
  assert.equal(emptyState.projectName, 'Project');
  assert.equal(emptyState.projectMaxLength, 60);
  assert.equal(emptyState.projectAria, 'Project name');
  assert.equal(emptyState.exportLabel, 'Export MP4 ↗');
  assert.deepEqual(emptyState.previewOrder, ['sound', 'time', 'software', 'software-marker']);
  assert.deepEqual(emptyState.sequenceOrder, ['undo-button', 'redo-button', 'project-menu', 'sequence-label']);
  assert.deepEqual(emptyState.footerActionOrder, ['assemble-preview', 'export-button']);
  assert.equal(emptyState.footer, 'Real H.264 bitstream editing · max 720px · 30 fps · originals untouched');
  assert.equal(emptyState.legacyReport, null);
  assert.equal(emptyState.bitstreamOpen, false);
  assert.equal(emptyState.bitstreamSummary, 'BITSTREAM REPORT');
  assert.equal(emptyState.bitstreamText, 'Run an export to see the bitstream report.');
  assert.equal(emptyState.saveDisabled, true);
  assert.equal(emptyState.loadDisabled, false);
  assert.equal(emptyState.disabled, true);
  assert.equal(emptyState.background, 'rgb(226, 225, 221)');
  assert.equal(emptyState.color, 'rgb(119, 118, 112)');
  assert.equal(emptyState.opacity, '1');
  assert.match(emptyState.cursor, /m4-cursor-interactive\.svg/);
  assert.doesNotMatch(emptyState.cursor, /not-allowed/);
  console.log('PASS empty state shows the shell order, project name, 00.00 time, and a high-contrast disabled export button');

  const projectPersistence = await client.evaluate(`(async () => {
    const input = document.querySelector('#project-name');
    input.value = 'My / Project: "A"';
    input.dispatchEvent(new Event('input', {bubbles: true}));
    await new Promise(resolve => setTimeout(resolve, 350));
    return {stored: localStorage.getItem('m4shlab-project'), size: input.size};
  })()`);
  assert.equal(projectPersistence.stored, 'My / Project: "A"');
  assert.ok(projectPersistence.size > 7);
  await client.send('Page.navigate', {url: `${baseUrl}?project-restore=1`});
  await client.waitFor("document.querySelector('#file-input-a') !== null && document.documentElement.dataset.appReady === 'true'", 10000);
  assert.equal(await client.evaluate("document.querySelector('#project-name').value"), 'My / Project: "A"');
  await client.evaluate(`(() => {
    const input = document.querySelector('#project-name');
    input.value = 'Project';
    input.dispatchEvent(new Event('input', {bubbles: true}));
    localStorage.removeItem('m4shlab-project');
  })()`);
  await client.send('Page.navigate', {url: `${baseUrl}?project-reset=1`});
  await client.waitFor("document.querySelector('#file-input-a') !== null && document.documentElement.dataset.appReady === 'true'", 10000);
  assert.equal(await client.evaluate("document.querySelector('#project-name').value"), 'Project');
  console.log('PASS project name persists through reload and restores the default state');

  const shellLayout = await client.evaluate(`(() => {
    const rect = selector => document.querySelector(selector).getBoundingClientRect();
    const header = rect('header');
    const importButton = rect('.file-actions .button');
    const previewMeta = rect('.preview-meta');
    const previewLabel = rect('#preview-label');
    const previewOptions = rect('.preview-options');
    const section = rect('.section-label');
    const sectionHeading = rect('#source-heading');
    const sectionTools = rect('.section-tools');
    const projectSummary = rect('#project-menu summary');
    const sequenceLabel = rect('#sequence-label');
    const undo = rect('#undo-button');
    const redo = rect('#redo-button');
    const footer = rect('.limits');
    const limits = rect('.limits p');
    const actions = rect('.limits .actions');
    const assemble = rect('#assemble-preview');
    const exportButton = rect('#export-button');
    return {
      importRight: importButton.right <= header.right + 1 && importButton.left > header.left,
      previewLabelLeft: previewLabel.left < previewOptions.left,
      previewOptionsRight: Math.abs(previewOptions.right - previewMeta.right) < 2,
      sectionHeadingLeft: sectionHeading.left < sectionTools.left,
      sectionToolsRight: Math.abs(sectionTools.right - section.right) < 2,
      sequenceControlOrder: undo.left < redo.left && redo.left < projectSummary.left && projectSummary.left < sequenceLabel.left,
      limitsLeft: limits.left < actions.left,
      actionsRight: Math.abs(actions.right - footer.right) < 2,
      actionRow: Math.abs(assemble.top - exportButton.top) < 2 && assemble.left < exportButton.left,
    };
  })()`);
  assert.deepEqual(shellLayout, {
    importRight: true,
    previewLabelLeft: true,
    previewOptionsRight: true,
    sectionHeadingLeft: true,
    sectionToolsRight: true,
    sequenceControlOrder: true,
    limitsLeft: true,
    actionsRight: true,
    actionRow: true,
  });
  console.log('PASS shell placement keeps import right, preview readout right, sequence controls ordered right, and footer actions together');

  const fileDropTransfer = await client.evaluate(`(async () => {
    const bytes = await (await fetch('/testmedia/synthetic-b-a.mp4')).arrayBuffer();
    const dataTransfer = new DataTransfer();
    dataTransfer.items.add(new File([bytes], 'drag-import.mp4', {type: 'video/mp4'}));
    const zone = document.querySelector('#drop-zone');
    zone.dispatchEvent(new DragEvent('dragenter', {bubbles: true, cancelable: true, dataTransfer}));
    zone.dispatchEvent(new DragEvent('dragover', {bubbles: true, cancelable: true, dataTransfer}));
    zone.dispatchEvent(new DragEvent('drop', {bubbles: true, cancelable: true, dataTransfer}));
    return {types: [...dataTransfer.types], files: dataTransfer.files.length};
  })()`);
  assert.deepEqual(fileDropTransfer.types, ['Files']);
  assert.equal(fileDropTransfer.files, 1);
  await client.waitFor("document.querySelectorAll('.clip-card').length === 1", 30000);
  const fileDropState = await client.evaluate(`({
    names: [...document.querySelectorAll('.clip-card .clip-name')].map(node => node.textContent),
    error: document.querySelector('#error').hidden ? null : document.querySelector('#error').textContent,
  })`);
  assert.deepEqual(fileDropState.names, ['drag-import.mp4']);
  assert.equal(fileDropState.error, null, fileDropState.error);
  console.log('PASS file drag-and-drop import still loads a video and does not use clip-reorder payloads');
  await client.send('Page.navigate', {url: `${baseUrl}?post-drop=1`});
  await client.waitFor("document.querySelector('#file-input-a') !== null && document.documentElement.dataset.appReady === 'true'", 10000);

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
    const {mergeMoshH264, mergeEffectH264} = await import('./merge.js');
    const input = new Uint8Array(await (await fetch('/testmedia/synthetic-h264.mp4')).arrayBuffer());
    const target = {width: 320, height: 240};
    const a = await normalizeWithWebCodecs(input, {target});
    const b = await normalizeWithWebCodecs(input, {target, frameNumberBase: a.outputSamples - 1});
    const merged = await mergeMoshH264(a.bytes, b.bytes);
    const effect = await mergeEffectH264(a.bytes, b.bytes, undefined, undefined, {
      method: 'melt',
      repeat: 4,
      durationFrames: 60,
      ending: 'continue',
    });
    return {
      samples: a.outputSamples,
      keyframes: a.keyframes,
      idrCount: a.idrCount,
      mergeReport: merged.report,
      mergedBytes: Array.from(merged.output),
      effect: {
        samples: effect.report.mergedSamples,
        windowSamples: effect.report.effect.window.windowOutputSamples,
        aSamples: a.outputSamples,
        bytes: Array.from(effect.output),
      },
    };
  })()`);
  const cadenceEvidence = `keyframes=${JSON.stringify(longGop.keyframes)} idrCount=${longGop.idrCount}`;
  assert.equal(longGop.samples, 75);
  assert.ok(longGop.idrCount < 3, `a 75-frame normalized clip still emits ${longGop.idrCount} IDRs (${cadenceEvidence}); the encoder ignored or overrode the single-keyframe request`);
  assert.equal(longGop.keyframes[0], 1, `the normalized clip must still start with an IDR (${cadenceEvidence})`);
  assert.equal(longGop.mergeReport.mergedSamples, 149);
  assert.equal(longGop.mergeReport.bIdrCountRemaining, longGop.idrCount - 1, `only B's leading IDR may disappear (${cadenceEvidence})`);
  assert.equal(longGop.mergeReport.frameAlignment.applied, true);
  assert.ok(longGop.mergeReport.frameAlignment.nextIdrSample >= 60, `the merged prediction chain still resets after ${longGop.mergeReport.frameAlignment.nextIdrSample} samples (${cadenceEvidence}); a mosh window longer than 30 frames would be cut off`);
  writeFileSync(multiGopMergedPath, Uint8Array.from(longGop.mergedBytes));
  const longGopProbe = command('ffprobe', [
    '-v', 'error', '-select_streams', 'v:0', '-count_frames',
    '-show_entries', 'stream=nb_read_frames', '-of', 'default=noprint_wrappers=1', multiGopMergedPath,
  ], 'WebCodecs multi-GOP merge probe');
  assert.match(longGopProbe.stdout, /nb_read_frames=149/);
  command('ffmpeg', ['-v', 'error', '-i', multiGopMergedPath, '-f', 'null', '-'], 'WebCodecs multi-GOP strict decode');
  console.log(`PASS a 75-frame normalized clip emits ${longGop.idrCount} IDR (samples ${longGop.keyframes.join(', ')}; the old cadence emitted 3 at samples 1, 31, 61) and the merged chain decodes 149/149 frames`);

  const effectOutput = Uint8Array.from(longGop.effect.bytes);
  writeFileSync(multiGopMergeWindowPath, effectOutput);
  const effectParsed = parseMp4(effectOutput);
  const effectNals = extractNals(effectOutput, effectParsed.videoTrack);
  assert.equal(longGop.effect.windowSamples, 60);
  const windowIdrSamples = [...new Set(effectNals
    .filter(nal => nal.type === 5 && nal.sampleIndex >= longGop.effect.aSamples && nal.sampleIndex < longGop.effect.aSamples + 60)
    .map(nal => nal.sampleIndex))];
  assert.deepEqual(windowIdrSamples, [], `the 60-frame mosh window at merged samples ${longGop.effect.aSamples}-${longGop.effect.aSamples + 59} still contains IDRs at ${JSON.stringify(windowIdrSamples)}`);
  const effectProbe = command('ffprobe', [
    '-v', 'error', '-select_streams', 'v:0', '-count_frames',
    '-show_entries', 'stream=nb_read_frames', '-of', 'default=noprint_wrappers=1', multiGopMergeWindowPath,
  ], 'WebCodecs mosh window probe');
  assert.match(effectProbe.stdout, new RegExp(`nb_read_frames=${longGop.effect.samples}`));
  command('ffmpeg', ['-v', 'error', '-i', multiGopMergeWindowPath, '-f', 'null', '-'], 'WebCodecs mosh window strict decode');
  console.log(`PASS a 60-frame Melt window (merged samples ${longGop.effect.aSamples}-${longGop.effect.aSamples + 59}) carries ${windowIdrSamples.length} IDRs and decodes ${longGop.effect.samples}/${longGop.effect.samples} frames`);

  await client.send('Page.navigate', {url: `${baseUrl}?safari-poc0=1`});
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
      bitstreamText: document.querySelector('#bitstream-report-json').textContent,
      bitstreamOpen: document.querySelector('#bitstream-report').open,
    };
  })()`);
  assert.equal(poc0Pair.error, null, 'A successful merge must clear stale errors');
  assert.equal(poc0Pair.compatibilityMarkup, null, 'Compatibility UI must not exist');
  assert.equal(poc0Pair.cards, 2);
  assert.match(poc0Pair.connector, /m4sh/);
  assert.ok(!poc0Pair.reportText.includes('spsHash'), 'SPS/PPS hashes must not be rendered');
  assert.equal(poc0Pair.bitstreamText, poc0Pair.reportText);
  assert.equal(poc0Pair.bitstreamOpen, false);
  assert.equal(poc0Pair.report.compatibility.compatible, true);
  assert.equal(poc0Pair.report.merge.mergedSamples, 99);
  assert.equal(poc0Pair.report.merge.frameAlignment.applied, true);
  assert.equal(poc0Pair.report.merge.frameAlignment.picOrderCntType, 0);
  assert.equal(poc0Pair.report.merge.frameAlignment.pictureReordering.noReordering, true);
  console.log('PASS Safari-style POC type 0 multi-GOP pair merges in the browser and clears stale errors');

  await client.send('Emulation.setDeviceMetricsOverride', {width: 390, height: 1000, deviceScaleFactor: 1, mobile: true});
  await client.send('Emulation.setTouchEmulationEnabled', {enabled: true, maxTouchPoints: 5});
  await new Promise(resolve => setTimeout(resolve, 150));
  const mobileLayout = await client.evaluate(`(() => {
    const footer = document.querySelector('.limits').getBoundingClientRect();
    const actions = document.querySelector('.limits .actions').getBoundingClientRect();
    const assemble = document.querySelector('#assemble-preview').getBoundingClientRect();
    const exportButton = document.querySelector('#export-button').getBoundingClientRect();
    const controls = [...document.querySelectorAll('.section-tools > *, .section-tools .history-tools > *')]
      .map(node => node.getBoundingClientRect());
    const menu = document.querySelector('#project-menu');
    menu.open = true;
    const panel = document.querySelector('.project-menu-panel').getBoundingClientRect();
    const projectHeight = document.querySelector('#project-name').getBoundingClientRect().height;
    menu.open = false;
    return {
      headerDirection: getComputedStyle(document.querySelector('header')).flexDirection,
      previewDirection: getComputedStyle(document.querySelector('.preview-meta')).flexDirection,
      importHeight: document.querySelector('.file-actions .button').getBoundingClientRect().height,
      clipControlHeight: document.querySelector('.clip-controls button').getBoundingClientRect().height,
      timelineScrolls: document.querySelector('.timeline').scrollWidth > document.querySelector('.timeline').clientWidth,
      sequenceRow: controls.every(rect => Math.abs((rect.top + rect.height / 2) - (controls[0].top + controls[0].height / 2)) < 4),
      projectHeight,
      panelWithinViewport: panel.left >= 0 && panel.right <= innerWidth,
      footerActionsWidth: Math.abs(actions.width - footer.width) < 2,
      footerButtonsRow: Math.abs(assemble.top - exportButton.top) < 2 && assemble.width > 100 && exportButton.width > 100,
    };
  })()`);
  assert.equal(mobileLayout.headerDirection, 'row');
  assert.equal(mobileLayout.previewDirection, 'row');
  assert.ok(mobileLayout.importHeight >= 44);
  assert.ok(mobileLayout.clipControlHeight >= 44);
  assert.equal(mobileLayout.timelineScrolls, true);
  assert.equal(mobileLayout.sequenceRow, true);
  assert.ok(mobileLayout.projectHeight >= 44);
  assert.equal(mobileLayout.panelWithinViewport, true);
  assert.equal(mobileLayout.footerActionsWidth, true);
  assert.equal(mobileLayout.footerButtonsRow, true);
  console.log('PASS mobile layout keeps the reference header/meta/sequence rows, an in-viewport project panel, and side-by-side footer actions with 44px touch targets');
  await client.send('Emulation.setTouchEmulationEnabled', {enabled: false});
  await client.send('Emulation.setDeviceMetricsOverride', {width: 1200, height: 1600, deviceScaleFactor: 1, mobile: false});

  await client.send('Page.navigate', {url: `${baseUrl}?merge-error=1`});
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

  await client.send('Page.navigate', {url: `${baseUrl}?large-native=1`});
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
      conversionHidden: document.querySelector('#conversion-progress').hidden,
      conversionMessage: document.querySelector('#conversion-message'),
      progressBars: document.querySelectorAll('.conversion-progress progress').length,
      clipDetails: [...document.querySelectorAll('.clip-card .clip-detail')].map(node => node.textContent),
      report: reportNode.textContent ? JSON.parse(reportNode.textContent) : null,
    };
  })()`);
  assert.equal(largePair.error, null, largePair.error || 'large native pair did not normalize');
  assert.equal(largePair.compatibilityMarkup, null, 'Compatibility UI must not exist');
  assert.ok(largePair.states.some(state => /normalizing clips… \d of 2/.test(state)), 'UI never exposed the clip-count normalizing state');
  assert.equal(largePair.conversionHidden, true, 'conversion status must disappear when normalization finishes');
  assert.equal(largePair.conversionMessage, null, 'technical conversion copy must not be rendered');
  assert.equal(largePair.progressBars, 1, 'one indeterminate conversion bar is allowed');
  assert.ok(largePair.clipDetails.every(text => /^\d+\.\d{2} s$/.test(text)), `clip cards must not show conversion paths: ${largePair.clipDetails}`);
  assert.equal(largePair.report.normalization.autoNormalized, true);
  assert.equal(largePair.report.normalization.parallel, true);
  assert.deepEqual(largePair.report.normalization.target, {width: 540, height: 720});
  assert.equal(largePair.report.sources.a.conversion.mode, 'normalized');
  assert.equal(largePair.report.sources.b.conversion.mode, 'normalized');
  assert.equal(largePair.report.sources.a.conversion.encodeEngine, 'WebCodecs', largePair.report.sources.a.conversion.webcodecsFallbackReason || 'Clip A did not use WebCodecs');
  assert.equal(largePair.report.sources.b.conversion.encodeEngine, 'WebCodecs', largePair.report.sources.b.conversion.webcodecsFallbackReason || 'Clip B did not use WebCodecs');
  assert.ok(largePair.report.merge.mergedSamples > 0);
  console.log(`PASS large native mismatch auto-normalized to ${largePair.report.normalization.target.width}x${largePair.report.normalization.target.height}; the compact normalizing line disappeared and merge produced ${largePair.report.merge.mergedSamples} samples`);

  await client.send('Page.navigate', {url: `${baseUrl}?multi-timeline=1`});
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
  assert.ok(multiInitial.connectors.every(text => /m4sh/.test(text)));
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
      title: document.querySelector('#transition-title').textContent,
      subtitle: document.querySelector('#transition-subtitle').textContent,
      methodLabel: document.querySelector('label[for="transition-method"]').textContent,
      method: document.querySelector('#transition-method').value,
      methods: [...document.querySelectorAll('#transition-method option')].map(option => option.value),
      technicalNotes: document.querySelectorAll('#transition-dialog .mosh-control-note').length,
      classicHidden: document.querySelector('#classic-mosh-options').hidden,
      effectHidden: document.querySelector('#nal-effect-options').hidden,
      endingOptions: [...document.querySelectorAll('#transition-ending option')].map(option => option.textContent),
      ending: document.querySelector('#transition-ending').value,
      durationMax: Number(duration.max),
      durationValue: Number(duration.value),
      durationMode: document.querySelector('#transition-duration-mode').textContent,
      randomizeDisabled: document.querySelector('#transition-randomize').disabled,
      seed: document.querySelector('#transition-seed').value,
      seedPlaceholder: document.querySelector('#transition-seed').placeholder,
    };
  })()`);
  assert.equal(dialogMethods.open, true);
  assert.equal(dialogMethods.title, 'Transition');
  assert.match(dialogMethods.subtitle, /^.+ → .+$/);
  assert.equal(dialogMethods.methodLabel, 'Method');
  assert.equal(dialogMethods.method, 'classic-mosh');
  assert.deepEqual(dialogMethods.methods, ['cut', 'classic-mosh', 'melt', 'loop', 'reset-pulse']);
  assert.equal(dialogMethods.technicalNotes, 0);
  assert.equal(dialogMethods.classicHidden, false);
  assert.equal(dialogMethods.effectHidden, true);
  assert.deepEqual(dialogMethods.endingOptions, ['Restore clear image', 'Continue motion']);
  assert.equal(dialogMethods.ending, 'restore');
  assert.ok(dialogMethods.durationMax >= 1);
  assert.equal(dialogMethods.durationValue, dialogMethods.durationMax);
  assert.equal(dialogMethods.durationMode, 'full length');
  assert.equal(dialogMethods.randomizeDisabled, false);
  assert.equal(dialogMethods.seed, '');
  assert.equal(dialogMethods.seedPlaceholder, 'seed —');
  const typedSeed = await client.evaluate(`(() => {
    const input = document.querySelector('#transition-seed');
    input.value = '0123456789ABCDEF';
    input.dispatchEvent(new KeyboardEvent('keydown', {key: 'Enter', bubbles: true, cancelable: true}));
    return {
      value: input.value,
      method: document.querySelector('#transition-method').value,
      duration: Number(document.querySelector('#transition-duration').value),
      ending: document.querySelector('#transition-ending').value,
      mode: document.querySelector('#transition-duration-mode').textContent,
      errorHidden: document.querySelector('#transition-seed-error').hidden,
    };
  })()`);
  assert.equal(typedSeed.value, '0123456789abcdef');
  assert.ok(['classic-mosh', 'melt', 'loop', 'reset-pulse'].includes(typedSeed.method));
  assert.ok(typedSeed.duration >= 12 && typedSeed.duration <= dialogMethods.durationMax);
  assert.ok(typedSeed.ending === 'restore' || typedSeed.ending === 'continue');
  assert.equal(typedSeed.mode, 'randomized');
  assert.equal(typedSeed.errorHidden, true);
  await client.evaluate(`Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: {writeText: async text => { window.__copiedSeed = text; }},
  })`);
  await client.evaluate("document.querySelector('#copy-seed').click()");
  await client.waitFor("document.querySelector('#copy-seed').textContent === 'copied'", 2000);
  assert.equal(await client.evaluate('window.__copiedSeed'), '0123456789abcdef');
  const invalidSeed = await client.evaluate(`(() => {
    const input = document.querySelector('#transition-seed');
    const method = document.querySelector('#transition-method').value;
    const duration = document.querySelector('#transition-duration').value;
    input.value = 'not-a-seed';
    input.dispatchEvent(new KeyboardEvent('keydown', {key: 'Enter', bubbles: true, cancelable: true}));
    return {
      error: document.querySelector('#transition-seed-error').hidden ? null : document.querySelector('#transition-seed-error').textContent,
      method: document.querySelector('#transition-method').value,
      duration: document.querySelector('#transition-duration').value,
      previousMethod: method,
      previousDuration: duration,
    };
  })()`);
  assert.match(invalidSeed.error, /16 hexadecimal/i);
  assert.equal(invalidSeed.method, invalidSeed.previousMethod);
  assert.equal(invalidSeed.duration, invalidSeed.previousDuration);
  console.log('PASS typed seed normalizes, copy exposes the exact seed, and invalid input stays inline without changing controls');
  const randomizedUi = await client.evaluate(`(() => {
    const button = document.querySelector('#transition-randomize');
    button.click();
    const seeded = {
      seedText: document.querySelector('#transition-seed').value,
      method: document.querySelector('#transition-method').value,
      duration: Number(document.querySelector('#transition-duration').value),
      ending: document.querySelector('#transition-ending').value,
      mode: document.querySelector('#transition-duration-mode').textContent,
    };
    const duration = document.querySelector('#transition-duration');
    duration.dispatchEvent(new Event('input', {bubbles: true}));
    return {
      ...seeded,
      clearedSeedText: document.querySelector('#transition-seed').value,
      clearedSeedPlaceholder: document.querySelector('#transition-seed').placeholder,
    };
  })()`);
  assert.match(randomizedUi.seedText, /^[0-9a-f]{16}$/);
  assert.ok(['classic-mosh', 'melt', 'loop', 'reset-pulse'].includes(randomizedUi.method));
  assert.ok(randomizedUi.duration >= 12 && randomizedUi.duration <= dialogMethods.durationMax);
  assert.ok(randomizedUi.ending === 'restore' || randomizedUi.ending === 'continue');
  assert.equal(randomizedUi.mode, 'randomized');
  assert.equal(randomizedUi.clearedSeedText, '');
  assert.equal(randomizedUi.clearedSeedPlaceholder, 'seed —');
  const appliedRandomSeed = await client.evaluate(`(() => {
    document.querySelector('#transition-randomize').click();
    const seed = document.querySelector('#transition-seed').value;
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
    const method = document.querySelector('#transition-method');
    method.value = 'melt';
    method.dispatchEvent(new Event('change', {bubbles: true}));
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
    method.value = 'loop';
    method.dispatchEvent(new Event('change', {bubbles: true}));
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
    method.value = 'reset-pulse';
    method.dispatchEvent(new Event('change', {bubbles: true}));
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
    method.value = 'cut';
    method.dispatchEvent(new Event('change', {bubbles: true}));
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
    assembleEnabled: !document.querySelector('#assemble-preview').disabled,
  }))()`);
  assert.match(mixedTimeline.connectors[0], /^Cut\d+\.\d{2} s$/);
  assert.match(mixedTimeline.connectors[1], /^m4sh\d+\.\d{2} s · (restore|continue)$/);
  assert.doesNotMatch(mixedTimeline.connectors[1], /original|gentler/);
  assert.deepEqual(mixedTimeline.methods, ['cut', 'classic-mosh']);
  assert.ok(mixedTimeline.mergedSamples > 0);
  assert.equal(mixedTimeline.assembleEnabled, true);
  console.log(`PASS multi-file import normalized 3 clips to 540x720, exposed two Cut/m4sh boundary dialogs, and merged ${mixedTimeline.mergedSamples} samples`);

  const originalOrder = multiInitial.cards;
  await client.waitFor("[...document.querySelectorAll('.clip-card')].length === 3 && [...document.querySelectorAll('.clip-card')].every(card => card.draggable)", 10000);
  const firstDragVisual = await client.evaluate(`(() => {
    const cards = [...document.querySelectorAll('.clip-card')];
    const source = cards[0];
    const target = cards[2];
    const dataTransfer = new DataTransfer();
    source.dispatchEvent(new DragEvent('dragstart', {bubbles: true, cancelable: true, dataTransfer}));
    const rect = target.getBoundingClientRect();
    const clientX = rect.left + rect.width * 0.75;
    const clientY = rect.top + rect.height / 2;
    target.dispatchEvent(new DragEvent('dragover', {bubbles: true, cancelable: true, dataTransfer, clientX, clientY}));
    const visual = {
      payload: dataTransfer.getData('text/plain'),
      dragging: source.classList.contains('dragging'),
      opacity: getComputedStyle(source).opacity,
      dropTarget: target.classList.contains('drop-target'),
      outline: getComputedStyle(target).outlineColor,
    };
    target.dispatchEvent(new DragEvent('drop', {bubbles: true, cancelable: true, dataTransfer, clientX, clientY}));
    source.dispatchEvent(new DragEvent('dragend', {bubbles: true, cancelable: true, dataTransfer}));
    return visual;
  })()`);
  assert.match(firstDragVisual.payload, /^clip-/);
  assert.equal(firstDragVisual.dragging, true);
  assert.equal(firstDragVisual.opacity, '0.4');
  assert.equal(firstDragVisual.dropTarget, true);
  assert.equal(firstDragVisual.outline, 'rgb(37, 37, 37)');
  const afterFirstDrag = [originalOrder[1], originalOrder[2], originalOrder[0]];
  await client.waitFor(`JSON.stringify([...document.querySelectorAll('.clip-card .clip-name')].map(node => node.textContent)) === ${JSON.stringify(JSON.stringify(afterFirstDrag))} && (document.querySelector('#status').textContent.includes('samples') || !document.querySelector('#error').hidden)`, 30000);
  const firstDragState = await client.evaluate(`({
    cards: [...document.querySelectorAll('.clip-card .clip-name')].map(node => node.textContent),
    connectors: document.querySelectorAll('.connector').length,
    error: document.querySelector('#error').hidden ? null : document.querySelector('#error').textContent,
  })`);
  assert.deepEqual(firstDragState.cards, afterFirstDrag);
  assert.equal(firstDragState.connectors, 2);
  assert.equal(firstDragState.error, null, firstDragState.error);
  await client.evaluate("document.querySelector('#undo-button').click()");
  await client.waitFor(`JSON.stringify([...document.querySelectorAll('.clip-card .clip-name')].map(node => node.textContent)) === ${JSON.stringify(JSON.stringify(originalOrder))}`, 10000);

  await client.evaluate(`(() => {
    const cards = [...document.querySelectorAll('.clip-card')];
    const source = cards[2];
    const target = cards[0];
    const dataTransfer = new DataTransfer();
    source.dispatchEvent(new DragEvent('dragstart', {bubbles: true, cancelable: true, dataTransfer}));
    const rect = target.getBoundingClientRect();
    const clientX = rect.left + rect.width * 0.25;
    const clientY = rect.top + rect.height / 2;
    target.dispatchEvent(new DragEvent('dragover', {bubbles: true, cancelable: true, dataTransfer, clientX, clientY}));
    target.dispatchEvent(new DragEvent('drop', {bubbles: true, cancelable: true, dataTransfer, clientX, clientY}));
    source.dispatchEvent(new DragEvent('dragend', {bubbles: true, cancelable: true, dataTransfer}));
  })()`);
  const afterSecondDrag = [originalOrder[2], originalOrder[0], originalOrder[1]];
  await client.waitFor(`JSON.stringify([...document.querySelectorAll('.clip-card .clip-name')].map(node => node.textContent)) === ${JSON.stringify(JSON.stringify(afterSecondDrag))}`, 10000);
  await client.evaluate("document.querySelector('#undo-button').click()");
  await client.waitFor(`JSON.stringify([...document.querySelectorAll('.clip-card .clip-name')].map(node => node.textContent)) === ${JSON.stringify(JSON.stringify(originalOrder))}`, 10000);

  const selfDrop = await client.evaluate(`(() => {
    const cards = [...document.querySelectorAll('.clip-card')];
    const source = cards[1];
    const target = cards[1];
    const dataTransfer = new DataTransfer();
    source.dispatchEvent(new DragEvent('dragstart', {bubbles: true, cancelable: true, dataTransfer}));
    const rect = target.getBoundingClientRect();
    const clientX = rect.left + rect.width * 0.75;
    const clientY = rect.top + rect.height / 2;
    target.dispatchEvent(new DragEvent('dragover', {bubbles: true, cancelable: true, dataTransfer, clientX, clientY}));
    target.dispatchEvent(new DragEvent('drop', {bubbles: true, cancelable: true, dataTransfer, clientX, clientY}));
    source.dispatchEvent(new DragEvent('dragend', {bubbles: true, cancelable: true, dataTransfer}));
    return {
      dropTarget: target.classList.contains('drop-target'),
      cards: [...document.querySelectorAll('.clip-card .clip-name')].map(node => node.textContent),
      error: document.querySelector('#error').hidden ? null : document.querySelector('#error').textContent,
    };
  })()`);
  assert.equal(selfDrop.dropTarget, false);
  assert.deepEqual(selfDrop.cards, originalOrder);
  assert.equal(selfDrop.error, null, selfDrop.error);
  console.log('PASS clip drag-and-drop reorders in both directions, shows CSS feedback, self-drop is inert, and undo restores order');

  await client.send('Emulation.setTouchEmulationEnabled', {enabled: true, maxTouchPoints: 5});
  await client.send('Emulation.setDeviceMetricsOverride', {width: 390, height: 1000, deviceScaleFactor: 1, mobile: true});
  await new Promise(resolve => setTimeout(resolve, 300));
  const touchDragState = await client.evaluate(`({
    coarse: matchMedia('(pointer: coarse)').matches,
    maxTouchPoints: navigator.maxTouchPoints,
    cards: [...document.querySelectorAll('.clip-card')].map(card => ({
      draggable: card.draggable,
      leftDisabled: card.querySelectorAll('.clip-controls button')[0].disabled,
    })),
  })`);
  assert.ok(touchDragState.coarse || touchDragState.maxTouchPoints > 0, 'touch emulation must advertise a coarse/touch pointer');
  assert.ok(touchDragState.cards.every(card => !card.draggable), 'touch cards must not be draggable');
  assert.equal(touchDragState.cards[1].leftDisabled, false);
  await client.evaluate("document.querySelectorAll('.clip-card')[1].querySelectorAll('.clip-controls button')[0].click()");
  await client.waitFor(`JSON.stringify([...document.querySelectorAll('.clip-card .clip-name')].map(node => node.textContent)) === ${JSON.stringify(JSON.stringify([originalOrder[1], originalOrder[0], originalOrder[2]]))}`, 10000);
  await client.evaluate("document.querySelector('#undo-button').click()");
  await client.waitFor(`JSON.stringify([...document.querySelectorAll('.clip-card .clip-name')].map(node => node.textContent)) === ${JSON.stringify(JSON.stringify(originalOrder))}`, 10000);
  await client.send('Emulation.setTouchEmulationEnabled', {enabled: false});
  await client.send('Emulation.setDeviceMetricsOverride', {width: 1200, height: 1600, deviceScaleFactor: 1, mobile: false});
  await new Promise(resolve => setTimeout(resolve, 300));
  assert.equal(await client.evaluate("[...document.querySelectorAll('.clip-card')].every(card => card.draggable)"), true);
  console.log('PASS touch cards stay non-draggable while arrow reorder works; desktop drag returns after pointer reset');

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

  await client.evaluate("document.querySelector('#assemble-preview').click()");
  await client.waitFor("document.querySelector('#preview-video').readyState >= 2 || document.querySelector('#preview-video').error", 15000);
  const multiPlayback = await client.evaluate(`({
    error: document.querySelector('#preview-video').error?.code ?? null,
    width: document.querySelector('#preview-video').videoWidth,
    height: document.querySelector('#preview-video').videoHeight
  })`);
  assert.equal(multiPlayback.error, null);
  assert.equal(multiPlayback.width, 540);
  assert.equal(multiPlayback.height, 720);

  const sanitizedProjectExportName = await client.evaluate(`(() => {
    const input = document.querySelector('#project-name');
    input.value = 'My / Cut: "One"';
    input.dispatchEvent(new Event('input', {bubbles: true}));
    let filename = null;
    const originalClick = HTMLAnchorElement.prototype.click;
    HTMLAnchorElement.prototype.click = function() { filename = this.download; };
    document.querySelector('#export-button').click();
    HTMLAnchorElement.prototype.click = originalClick;
    input.value = 'Project';
    input.dispatchEvent(new Event('input', {bubbles: true}));
    return filename;
  })()`);
  assert.equal(sanitizedProjectExportName, 'My-Cut-One.mp4');
  console.log('PASS project name sanitizes to My-Cut-One.mp4 for export and resets to the default merge filename');

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
  console.log(`PASS full three-clip export decodes ${finalReport.merge.expectedDecodedFrames} frames at 540x720; Cut + m4sh NAL sequence and preview are intact`);

  await client.send('Page.navigate', {url: `${baseUrl}?nal-effects=1`});
  await client.waitFor("document.querySelector('#file-input-a') !== null && document.documentElement.dataset.appReady === 'true'", 10000);
  await client.setFile('#file-input-a', fixtures.effectA);
  await client.waitFor("document.querySelector('#status').textContent.includes('clip A')", 15000);
  await client.setFile('#file-input-b', fixtures.effectB);
  await client.waitFor("document.querySelector('#status').textContent.includes('samples') || !document.querySelector('#error').hidden", 30000);
  const applyEffect = async (method, value, options = {}) => {
    await client.evaluate(`(() => {
      document.querySelector('.connector').click();
      const methodSelect = document.querySelector('#transition-method');
      methodSelect.value = '${method}';
      methodSelect.dispatchEvent(new Event('change', {bubbles: true}));
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
        assembleEnabled: !document.querySelector('#assemble-preview').disabled,
        connector: document.querySelector('.connector').textContent,
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
  assert.equal(meltUi.assembleEnabled, true);
  assert.match(meltUi.connector, /^Melt\d+\.\d{2} s · continue$/);
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
  assert.equal(gentleUi.assembleEnabled, true);
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
  assert.equal(gentleLoopUi.assembleEnabled, true);
  assert.match(gentleLoopUi.connector, /^Loop Release\d+\.\d{2} s · 4f$/);
  console.log('PASS browser Gentler Loop bridges to the release tail with <=2 donor advances and decodes 99 samples');
  const resetUi = await applyEffect('reset-pulse', null, {durationFrames: 12, interval: 6, repeat: 2});
  assert.equal(resetUi.error, null, resetUi.error);
  assert.equal(resetUi.method, 'reset-pulse');
  assert.equal(resetUi.mergedSamples, 99);
  assert.deepEqual(resetUi.resetPulse.resetOutputPositions, [25, 31]);
  assert.deepEqual(resetUi.resetPulse.patchCounts, [5, 5]);
  assert.equal(resetUi.resetPulse.tail.donorStartSample, 13);
  assert.equal(resetUi.patchedSamples, 70);
  assert.equal(resetUi.assembleEnabled, true);
  assert.match(resetUi.connector, /^Reset Pulse\d+\.\d{2} s · 6f \/ 2×$/);
  await client.evaluate("document.querySelector('#assemble-preview').click()");
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

  await client.send('Page.navigate', {url: `${baseUrl}?normalize-effect=1`});
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

  await client.send('Page.navigate', {url: `${baseUrl}?audio-merge=1`});
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

  await client.send('Page.navigate', {url: `${baseUrl}?sound-persisted=1`});
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
  await client.send('Page.navigate', {url: `${baseUrl}?audio-fallback=1`});
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

  await client.send('Page.navigate', {url: `${baseUrl}?clip-speed=1`});
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
    const method = document.querySelector('#transition-method');
    method.value = 'cut';
    method.dispatchEvent(new Event('change', {bubbles: true}));
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

  rmSync(speedMergedPath, {force: true});
  rmSync(mergedPath, {force: true});
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

  await client.send('Page.navigate', {url: `${baseUrl}?fractional-speed=1`});
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

  await client.send('Page.navigate', {url: `${baseUrl}?speed-target=1`});
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

  await client.send('Page.navigate', {url: `${baseUrl}?clip-looks=1`});
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

  await client.send('Page.navigate', {url: `${baseUrl}?single-pair=1`});
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
      conversionHidden: document.querySelector('#conversion-progress').hidden,
      conversionMessage: document.querySelector('#conversion-message'),
      assembleEnabled: !document.querySelector('#assemble-preview').disabled,
      exportEnabled: !document.querySelector('#export-button').disabled,
      report: reportNode.textContent ? JSON.parse(reportNode.textContent) : null,
    };
  })()`);
  assert.equal(state.error, null, state.error);
  assert.equal(state.compatibilityMarkup, null, 'Compatibility UI must not exist');
  assert.equal(state.conversionHidden, true);
  assert.equal(state.conversionMessage, null);
  assert.equal(state.assembleEnabled, true);
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
  await client.evaluate("document.querySelector('#assemble-preview').click()");
  await client.waitFor("document.querySelector('#preview-video').readyState >= 2 || document.querySelector('#preview-video').error", 15000);
  const assembledLabel = await client.evaluate(`({
    label: document.querySelector('#preview-label').textContent,
    pressed: document.querySelector('#assemble-preview').getAttribute('aria-pressed'),
    selectedCards: document.querySelectorAll('.clip-card.is-previewing').length,
    oldToggle: document.querySelector('#show-original, #show-modified, .toggle'),
  })`);
  assert.equal(assembledLabel.label, 'Assembled preview · all clips and transitions');
  assert.equal(assembledLabel.pressed, 'true');
  assert.equal(assembledLabel.selectedCards, 0);
  assert.equal(assembledLabel.oldToggle, null);
  await client.evaluate("document.querySelectorAll('.clip-card')[1].click()");
  await client.waitFor("document.querySelector('#preview-label').textContent === 'Clip preview · synthetic-b-mismatch.mp4'", 10000);
  const selectedClipPreview = await client.evaluate(`({
    label: document.querySelector('#preview-label').textContent,
    pressed: document.querySelector('#assemble-preview').getAttribute('aria-pressed'),
    selectedCard: document.querySelector('.clip-card.is-previewing .clip-name')?.textContent ?? null,
  })`);
  assert.equal(selectedClipPreview.label, 'Clip preview · synthetic-b-mismatch.mp4');
  assert.equal(selectedClipPreview.pressed, 'false');
  assert.equal(selectedClipPreview.selectedCard, 'synthetic-b-mismatch.mp4');
  console.log('PASS clip-card and Assemble preview selection replace the removed A cut/merged toggle; time readout and sound defaults remain');
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
    await client.send('Page.navigate', {url: `${baseUrl}?hybrid=1`});
    await client.waitFor("document.querySelector('#file-input-a') !== null && document.documentElement.dataset.appReady === 'true'", 10000);
    await client.setFile('#file-input-a', join(projectRoot, 'testmedia', 'synthetic-hevc.mov'));
    await client.waitFor("document.querySelector('#status').textContent.includes('clip A') || /failed/i.test(document.querySelector('#conversion-status').textContent)", 180000);
    await client.setFile('#file-input-b', join(projectRoot, 'testmedia', 'synthetic-hevc-small.mov'));
    await client.waitFor("document.querySelector('#status').textContent.includes('samples') || !document.querySelector('#error').hidden", 300000);
    const hybrid = await client.evaluate(`(() => {
      const reportNode = document.querySelector('#report');
      return {
        conversionHidden: document.querySelector('#conversion-progress').hidden,
        conversionMessage: document.querySelector('#conversion-message'),
        error: document.querySelector('#error').hidden ? null : document.querySelector('#error').textContent,
        progressBars: document.querySelectorAll('.conversion-progress progress').length,
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
    }
    assert.equal(hybrid.conversionHidden, true);
    assert.equal(hybrid.conversionMessage, null);
    assert.equal(hybrid.progressBars, 1);
    assert.equal(hybrid.report.normalization.engines[0].sourceCodec, 'HEVC');
    assert.equal(hybrid.report.normalization.engines[1].sourceCodec, 'HEVC');
    assert.equal(hybrid.report.normalization.engines[0].decode, sourceConversionA.decodeEngine);
    assert.equal(hybrid.report.normalization.engines[1].decode, sourceConversionB.decodeEngine);
    assert.equal(hybrid.report.normalization.autoNormalized, true);
    assert.equal(hybrid.report.normalization.parallel, true);
    assert.ok(Math.max(hybrid.report.normalization.target.width, hybrid.report.normalization.target.height) <= 720);
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
    console.log(`PASS HEVC import ran ${sourceConversionA.decodeEngine} decode plus WebCodecs H.264 encode at ${hybrid.report.normalization.target.width}x${hybrid.report.normalization.target.height}; the compact conversion status completed and export decoded`);

    const nativeChrome = await launchChrome({disableGpu: false});
    if (nativeChrome) {
      let nativeClient = null;
      try {
        nativeClient = await pageTarget(nativeChrome.endpoint);
        await nativeClient.send('Page.enable');
        await nativeClient.send('Runtime.enable');
        await nativeClient.send('DOM.enable');
        await nativeClient.send('Emulation.setDeviceMetricsOverride', {width: 1200, height: 1600, deviceScaleFactor: 1, mobile: false});
        await nativeClient.send('Page.navigate', {url: `${baseUrl}?hevc-native=1`});
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
            conversionHidden: document.querySelector('#conversion-progress').hidden,
            mergedSamples: report.merge.mergedSamples,
          };
        })()`);
        assert.equal(nativeHevc.error, null, nativeHevc.error);
        if (nativeHevc.decodeEngine === 'WebCodecs (HEVC)') {
          assert.equal(nativeHevc.sourceCodec, 'HEVC');
          assert.equal(nativeHevc.encodeEngine, 'WebCodecs');
          assert.match(nativeHevc.decoderCodec, /^hvc1\.|^hev1\./);
          assert.equal(nativeHevc.fallbackReason, null);
          assert.equal(nativeHevc.conversionHidden, true);
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

    const settingsPath = join(downloadDir, 'Roundtrip-Set.m4settings');
    const mismatchPath = join(downloadDir, 'Roundtrip-Set-mismatch.m4settings');
    rmSync(settingsPath, {force: true});
    rmSync(mismatchPath, {force: true});
    await client.send('Emulation.setEmulatedMedia', {features: []});
    await client.send('Page.navigate', {url: `${baseUrl}?settings-roundtrip=1`});
    await client.waitFor("document.querySelector('#file-input-a') !== null && document.documentElement.dataset.appReady === 'true'", 10000);
    await client.evaluate(`(() => {
      const input = document.querySelector('#project-name');
      input.value = 'Roundtrip / Set';
      input.dispatchEvent(new Event('input', {bubbles: true}));
      const sound = document.querySelector('#sound-toggle');
      sound.checked = false;
      sound.dispatchEvent(new Event('change', {bubbles: true}));
    })()`);
    await client.setFiles('#file-input-a', [fixtures.a, fixtures.b]);
    await client.waitFor("document.querySelectorAll('.clip-card').length === 2", 30000);
    await client.waitFor("document.querySelector('#status').textContent.includes('samples') || !document.querySelector('#error').hidden", 120000);
    assert.equal(await client.evaluate("document.querySelector('#save-settings').disabled"), false);
    await client.evaluate(`(() => {
      document.querySelector('.connector').click();
      const seed = document.querySelector('#transition-seed');
      seed.value = 'FEDCBA9876543210';
      seed.dispatchEvent(new KeyboardEvent('keydown', {key: 'Enter', bubbles: true, cancelable: true}));
      document.querySelector('#transition-apply').click();
    })()`);
    await client.waitFor(`(() => {
      const node = document.querySelector('#report');
      if (!node.textContent) return false;
      try {
        const report = JSON.parse(node.textContent);
        return report.stage === 'merged' && report.transitions?.[0]?.random_seed === 'fedcba9876543210';
      } catch { return false; }
    })()`, 60000);
    const beforeSettingsSave = await client.evaluate(`(() => {
      const report = JSON.parse(document.querySelector('#report').textContent);
      const connector = document.querySelector('.connector');
      return {
        transition: report.transitions[0],
        connectorText: connector.textContent,
        connectorTitle: connector.title,
        project: document.querySelector('#project-name').value,
        sound: document.querySelector('#sound-toggle').checked,
      };
    })()`);
    assert.match(beforeSettingsSave.connectorTitle, /fedcba9876543210/);
    assert.doesNotMatch(beforeSettingsSave.connectorText, /fedcba9876543210/);
    assert.equal(beforeSettingsSave.project, 'Roundtrip / Set');
    assert.equal(beforeSettingsSave.sound, false);
    await client.evaluate("document.querySelector('#project-menu').open = true");
    await client.evaluate("document.querySelector('#save-settings').click()");
    await waitForDownload(settingsPath, 10000);
    const savedSettingsText = readFileSync(settingsPath, 'utf8');
    const savedSettings = JSON.parse(savedSettingsText);
    assert.equal(savedSettings.format, 'm4shlab-settings');
    assert.equal(savedSettings.version, 1);
    assert.equal(savedSettings.project, 'Roundtrip / Set');
    assert.equal(savedSettings.sound, false);
    assert.equal(savedSettings.clip_count, 2);
    assert.equal(savedSettings.clips.length, 2);
    assert.equal(savedSettings.transitions.length, 1);
    assert.equal(savedSettings.transitions[0].random_seed, 'fedcba9876543210');
    assert.equal(await client.evaluate("document.querySelector('#status').textContent"), 'Settings saved. Videos are not included.');
    assert.equal(await client.evaluate("document.querySelector('#project-menu').open"), false);
    assert.ok(!savedSettingsText.includes('data:'));
    assert.ok(!savedSettingsText.includes('blob:'));

    await client.send('Page.navigate', {url: `${baseUrl}?settings-reimport=1`});
    await client.waitFor("document.querySelector('#file-input-a') !== null && document.documentElement.dataset.appReady === 'true'", 10000);
    assert.equal(await client.evaluate("document.querySelector('#project-name').value"), 'Roundtrip / Set');
    await client.setFiles('#file-input-a', [fixtures.a, fixtures.b]);
    await client.waitFor("document.querySelectorAll('.clip-card').length === 2", 30000);
    await client.waitFor("document.querySelector('#status').textContent.includes('samples') || !document.querySelector('#error').hidden", 120000);
    await client.evaluate(`(() => {
      const input = document.querySelector('#project-name');
      input.value = 'Temporary';
      input.dispatchEvent(new Event('input', {bubbles: true}));
      const sound = document.querySelector('#sound-toggle');
      sound.checked = true;
      sound.dispatchEvent(new Event('change', {bubbles: true}));
    })()`);
    await client.waitFor("document.querySelector('#status').textContent.includes('samples') || !document.querySelector('#error').hidden", 120000);
    await client.evaluate("document.querySelector('#project-menu').open = true");
    await client.setFile('#settings-input', settingsPath);
    await client.waitFor("document.querySelector('#status').textContent === 'Settings loaded for 1 boundaries.'", 120000);
    const loadedSettings = await client.evaluate(`(() => {
      const report = JSON.parse(document.querySelector('#report').textContent);
      return {
        transition: report.transitions[0],
        source0: report.sources.clips[0],
        project: document.querySelector('#project-name').value,
        sound: document.querySelector('#sound-toggle').checked,
        menuOpen: document.querySelector('#project-menu').open,
        bitstreamText: document.querySelector('#bitstream-report-json').textContent,
        hiddenReport: document.querySelector('#report').textContent,
      };
    })()`);
    assert.equal(loadedSettings.project, 'Roundtrip / Set');
    assert.equal(loadedSettings.sound, false);
    assert.equal(loadedSettings.menuOpen, false);
    assert.equal(loadedSettings.bitstreamText, loadedSettings.hiddenReport);
    assert.equal(loadedSettings.transition.method, savedSettings.transitions[0].method);
    assert.equal(loadedSettings.transition.durationFrames, savedSettings.transitions[0].duration_frames);
    assert.equal(loadedSettings.transition.ending, savedSettings.transitions[0].ending);
    assert.equal(loadedSettings.transition.repeat, savedSettings.transitions[0].repeat);
    assert.equal(loadedSettings.transition.loopFrames, savedSettings.transitions[0].loop_frames);
    assert.equal(loadedSettings.transition.resetInterval, savedSettings.transitions[0].reset_interval);
    assert.equal(loadedSettings.transition.smooth, savedSettings.transitions[0].smooth);
    assert.equal(loadedSettings.transition.random_seed, savedSettings.transitions[0].random_seed);
    assert.equal(loadedSettings.transition.speed, savedSettings.clips[1].speed);
    assert.equal(loadedSettings.transition.look, savedSettings.clips[1].look);
    assert.equal(loadedSettings.source0.speed, savedSettings.clips[0].speed);
    assert.equal(loadedSettings.source0.look, savedSettings.clips[0].look);

    const timelineSnapshotExpression = `(() => {
      return {
        cards: document.querySelectorAll('.clip-card').length,
        names: [...document.querySelectorAll('.clip-card .clip-name')].map(node => node.textContent),
        connectors: [...document.querySelectorAll('.connector')].map(node => node.textContent),
        // mosh_visibility is filled in asynchronously by its own check, so the
        // snapshot compares the merge report without that block.
        report: (() => {
          const text = document.querySelector('#report').textContent;
          try {
            const parsed = JSON.parse(text);
            delete parsed.mosh_visibility;
            return JSON.stringify(parsed);
          } catch {
            return text;
          }
        })(),
        project: document.querySelector('#project-name').value,
        sound: document.querySelector('#sound-toggle').checked,
      };
    })()`;
    const beforeMismatch = await client.evaluate(timelineSnapshotExpression);
    writeFileSync(mismatchPath, JSON.stringify({...savedSettings, clip_count: 3}, null, 2));
    await client.setFile('#settings-input', mismatchPath);
    await client.waitFor("!document.querySelector('#error').hidden && /Settings are for 3 clips/.test(document.querySelector('#error').textContent)", 5000);
    const afterMismatch = await client.evaluate(timelineSnapshotExpression);
    assert.equal(afterMismatch.cards, 2);
    assert.equal(beforeMismatch.cards, 2);
    const {cards: afterCards, ...afterRest} = afterMismatch;
    const {cards: beforeCards, ...beforeRest} = beforeMismatch;
    assert.equal(afterCards, beforeCards);
    assert.deepEqual(afterRest, beforeRest);
    assert.match(await client.evaluate("document.querySelector('#error').textContent"), /settings are for 3 clips/i);

    await client.evaluate("document.querySelector('#project-menu').open = true");
    await client.evaluate("document.body.click()");
    assert.equal(await client.evaluate("document.querySelector('#project-menu').open"), false);
    await client.evaluate("document.querySelector('#project-menu').open = true");
    await client.evaluate("document.dispatchEvent(new KeyboardEvent('keydown', {key: 'Escape', bubbles: true}))");
    assert.equal(await client.evaluate("document.querySelector('#project-menu').open"), false);
    console.log('PASS settings save/load round-trips project, sound, seed and boundary values; clip-count mismatch leaves the timeline unchanged');

    const auditSettingsPath = join(downloadDir, 'Audit.m4settings');
    const invalidLaterPath = join(downloadDir, 'Audit-invalid-later.m4settings');
    const invalidEnginePath = join(downloadDir, 'Audit-invalid-engine.m4settings');
    const invalidCountPath = join(downloadDir, 'Audit-invalid-count.m4settings');
    for (const path of [auditSettingsPath, invalidLaterPath, invalidEnginePath, invalidCountPath]) rmSync(path, {force: true});
    await client.send('Page.navigate', {url: `${baseUrl}?settings-transactional=1`});
    await client.waitFor("document.querySelector('#file-input-a') !== null && document.documentElement.dataset.appReady === 'true'", 10000);
    await client.evaluate(`(() => {
      const input = document.querySelector('#project-name');
      input.value = 'Audit';
      input.dispatchEvent(new Event('input', {bubbles: true}));
    })()`);
    await client.setFiles('#file-input-a', [fixtures.a, fixtures.b, fixtures.a]);
    await client.waitFor("document.querySelectorAll('.clip-card').length === 3", 30000);
    await client.waitFor("document.querySelector('#status').textContent.includes('samples') || !document.querySelector('#error').hidden", 120000);
    await client.evaluate("document.querySelector('#project-menu').open = true");
    await client.evaluate("document.querySelector('#save-settings').click()");
    await waitForDownload(auditSettingsPath, 10000);
    const auditSettings = JSON.parse(readFileSync(auditSettingsPath, 'utf8'));
    assert.equal(auditSettings.clip_count, 3);
    assert.equal(auditSettings.transitions.length, 2);

    const auditSnapshotExpression = `(() => {
      const reportText = document.querySelector('#report').textContent;
      const report = JSON.parse(reportText);
      return {
        cards: document.querySelectorAll('.clip-card').length,
        names: [...document.querySelectorAll('.clip-card .clip-name')].map(node => node.textContent),
        connectors: [...document.querySelectorAll('.connector')].map(node => node.textContent),
        project: document.querySelector('#project-name').value,
        sound: document.querySelector('#sound-toggle').checked,
        clips: report.sources.clips.map(clip => ({name: clip.name, speed: clip.speed, look: clip.look, frames: clip.output_frames})),
        transitions: report.transitions.map(transition => ({
          method: transition.method,
          durationFrames: transition.durationFrames,
          ending: transition.ending,
          repeat: transition.repeat,
          loopFrames: transition.loopFrames,
          resetInterval: transition.resetInterval,
          smooth: transition.smooth,
          speed: transition.speed,
          look: transition.look,
          random_seed: transition.random_seed,
        })),
        normalization: report.normalization ? {
          autoNormalized: report.normalization.autoNormalized ?? null,
          target: report.normalization.target ?? null,
          engines: (report.normalization.engines ?? []).map(item => item.path ?? item.engine ?? null),
        } : null,
        compatibility: report.compatibility?.compatible ?? null,
        reportText,
      };
    })()`;
    const auditBefore = await client.evaluate(auditSnapshotExpression);
    assert.equal(auditBefore.cards, 3);

    const loadSettingsAttempt = async (path, expectation) => {
      await client.evaluate("document.querySelector('#project-menu').open = true");
      await client.setFile('#settings-input', path);
      await client.waitFor(expectation, 120000);
      await new Promise(resolveWait => setTimeout(resolveWait, 250));
      return client.evaluate(auditSnapshotExpression);
    };
    const assertSnapshotUnchanged = (before, after, label) => {
      const changed = Object.keys(before).filter(key => JSON.stringify(before[key]) !== JSON.stringify(after[key]));
      assert.deepEqual(changed, [], `${label}: changed ${changed.map(key => `${key}=${JSON.stringify(after[key])} (expected ${JSON.stringify(before[key])})`).join('; ')}`);
      assert.deepEqual(after, before, label);
    };

    writeFileSync(invalidLaterPath, JSON.stringify({
      ...auditSettings,
      transitions: [
        {...auditSettings.transitions[0], duration_frames: 7, ending: 'continue'},
        {...auditSettings.transitions[1], method: 'loop', loop_frames: 1},
      ],
    }, null, 2));
    const afterInvalidLater = await loadSettingsAttempt(
      invalidLaterPath,
      "!document.querySelector('#error').hidden && /Transition 2 has invalid Loop frames/.test(document.querySelector('#error').textContent)",
    );
    assertSnapshotUnchanged(auditBefore, afterInvalidLater, 'invalid later boundary');
    assert.equal(afterInvalidLater.reportText, auditBefore.reportText);
    assert.match(await client.evaluate("document.querySelector('#error').textContent"), /Transition 2 has invalid Loop frames/);
    console.log('PASS settings load rejects an invalid parameter in the later boundary and leaves names, connectors, report, project and sound untouched');

    writeFileSync(invalidEnginePath, JSON.stringify({
      ...auditSettings,
      transitions: [
        {...auditSettings.transitions[0], duration_frames: 7, ending: 'continue'},
        {
          method: 'reset-pulse',
          duration_frames: 30,
          ending: 'restore',
          repeat: 2,
          loop_frames: null,
          reset_interval: 48,
          smooth: false,
          random_seed: null,
        },
      ],
    }, null, 2));
    const afterInvalidEngine = await loadSettingsAttempt(
      invalidEnginePath,
      "!document.querySelector('#error').hidden && /Reset interval 48/.test(document.querySelector('#error').textContent) && document.querySelector('#status').textContent.includes('samples')",
    );
    // Connector text is re-rendered during the rollback merge, so it can pick up the
    // normalized 30 fps timeline while the pre-load DOM still showed the source fps.
    // The settings state itself (report transitions, clips, project, sound) must match.
    const {
      reportText: ignoredEngineReport,
      connectors: ignoredEngineConnectors,
      ...engineBefore
    } = auditBefore;
    const {
      reportText: ignoredEngineAfter,
      connectors: engineAfterConnectors,
      ...engineAfter
    } = afterInvalidEngine;
    assert.notEqual(ignoredEngineReport.length, 0);
    assert.notEqual(ignoredEngineAfter.length, 0);
    assert.deepEqual(engineAfterConnectors, ['m4sh0.80 s · restore', 'm4sh0.80 s · restore']);
    assertSnapshotUnchanged(engineBefore, engineAfter, 'engine rollback');
    console.log('PASS a boundary the merge engine rejects rolls the whole settings load back; timeline, report and project are byte-identical');

    writeFileSync(invalidCountPath, JSON.stringify({...auditSettings, clip_count: 2}, null, 2));
    const afterInvalidCount = await loadSettingsAttempt(
      invalidCountPath,
      "!document.querySelector('#error').hidden && /Settings are for 2 clips/.test(document.querySelector('#error').textContent)",
    );
    assertSnapshotUnchanged(afterInvalidEngine, afterInvalidCount, 'clip_count mismatch');
    console.log('PASS a clip_count mismatch against a 3-clip timeline errors out and leaves the timeline, report and project untouched');

    const skeletonFixtures = ['skeleton-a.mov', 'skeleton-b.mov', 'skeleton-c.mov']
      .map(name => join(downloadDir, name));
    for (const path of skeletonFixtures) copyFileSync(join(projectRoot, 'testmedia', 'synthetic-hevc-small.mov'), path);
    await client.send('Emulation.setEmulatedMedia', {features: [{name: 'prefers-reduced-motion', value: 'reduce'}]});
    await client.send('Page.navigate', {url: `${baseUrl}?skeleton-import=1`});
    await client.waitFor("document.querySelector('#file-input-a') !== null && document.documentElement.dataset.appReady === 'true'", 10000);
    await client.evaluate(`(() => {
      window.__skeletonStates = [];
      window.__skeletonObserver = new MutationObserver(() => {
        const states = [...document.querySelectorAll('.clip-skeleton .skeleton-status')].map(node => node.textContent);
        if (states.length) window.__skeletonStates.push(states);
      });
      window.__skeletonObserver.observe(document.querySelector('#source-tiers'), {childList: true, subtree: true, characterData: true});
    })()`);
    await client.setFiles('#file-input-a', skeletonFixtures);
    await client.waitFor("document.querySelectorAll('.clip-skeleton').length === 3", 10000);
    const skeletonState = await client.evaluate(`(() => {
      const cards = [...document.querySelectorAll('.clip-skeleton')];
      const rect = cards[0].getBoundingClientRect();
      const shimmer = cards[0].querySelector('.skeleton-shimmer');
      return {
        count: cards.length,
        width: rect.width,
        height: rect.height,
        statuses: cards.map(card => card.querySelector('.skeleton-status').textContent),
        reducedMotionAnimation: getComputedStyle(shimmer, '::after').animationName,
      };
    })()`);
    assert.equal(skeletonState.count, 3);
    assert.equal(skeletonState.statuses.length, 3);
    assert.equal(skeletonState.reducedMotionAnimation, 'none');
    await client.waitFor("document.querySelectorAll('.clip-skeleton').length === 0 && document.querySelectorAll('.clip-card:not(.clip-skeleton)').length === 3", 180000);
    await client.waitFor("document.querySelector('#status').textContent.includes('samples') || !document.querySelector('#error').hidden", 180000);
    const resolvedSkeletons = await client.evaluate(`(() => {
      const cards = [...document.querySelectorAll('.clip-card:not(.clip-skeleton)')];
      const rect = cards[0].getBoundingClientRect();
      return {
        names: cards.map(card => card.querySelector('.clip-name').textContent),
        width: rect.width,
        height: rect.height,
        statuses: window.__skeletonStates,
        error: document.querySelector('#error').hidden ? null : document.querySelector('#error').textContent,
      };
    })()`);
    assert.deepEqual(resolvedSkeletons.names, ['skeleton-a.mov', 'skeleton-b.mov', 'skeleton-c.mov']);
    assert.equal(resolvedSkeletons.error, null, resolvedSkeletons.error);
    assert.equal(resolvedSkeletons.width, skeletonState.width, 'fine pointer: skeleton and card width must match exactly');
    assert.equal(resolvedSkeletons.height, skeletonState.height, 'fine pointer: skeleton and card height must match exactly');
    assert.ok(resolvedSkeletons.statuses.some(states => states.length === 3 && states.includes('waiting')));
    const fineVars = await client.evaluate(`(() => {
      const style = getComputedStyle(document.documentElement);
      return {
        width: style.getPropertyValue('--clip-card-w').trim(),
        height: style.getPropertyValue('--clip-card-h').trim(),
        control: style.getPropertyValue('--clip-control-min').trim(),
      };
    })()`);
    assert.equal(fineVars.width, '148px');
    assert.equal(fineVars.height, '211.5px');
    assert.equal(fineVars.control, '28px');
    assert.equal(`${parseFloat(fineVars.width)}`, `${skeletonState.width}`);
    assert.equal(`${parseFloat(fineVars.height)}`, `${skeletonState.height}`);
    await client.evaluate("window.__skeletonObserver?.disconnect()");
    console.log(`PASS fine pointer: skeleton and card both measure exactly ${skeletonState.width}x${skeletonState.height} from --clip-card-w/--clip-card-h`);

    await client.send('Emulation.setDeviceMetricsOverride', {width: 390, height: 900, deviceScaleFactor: 1, mobile: true});
    await client.send('Emulation.setTouchEmulationEnabled', {enabled: true, maxTouchPoints: 5});
    await client.send('Page.navigate', {url: `${baseUrl}?skeleton-coarse=1`});
    await client.waitFor("document.querySelector('#file-input-a') !== null && document.documentElement.dataset.appReady === 'true'", 10000);
    await client.setFiles('#file-input-a', skeletonFixtures);
    await client.waitFor("document.querySelectorAll('.clip-skeleton').length === 3", 15000);
    const coarseSkeleton = await client.evaluate(`(() => {
      const card = document.querySelector('.clip-skeleton');
      const rect = card.getBoundingClientRect();
      const button = card.querySelector('.clip-controls button').getBoundingClientRect();
      const style = getComputedStyle(document.documentElement);
      return {
        width: rect.width,
        height: rect.height,
        coarse: matchMedia('(pointer: coarse)').matches,
        controlWidth: Math.round(button.width),
        controlHeight: Math.round(button.height),
        cssWidth: style.getPropertyValue('--clip-card-w').trim(),
        cssHeight: style.getPropertyValue('--clip-card-h').trim(),
        cssControl: style.getPropertyValue('--clip-control-min').trim(),
      };
    })()`);
    assert.equal(coarseSkeleton.coarse, true);
    assert.equal(coarseSkeleton.controlWidth, 44);
    assert.equal(coarseSkeleton.controlHeight, 44);
    assert.equal(coarseSkeleton.cssControl, '44px');
    await client.waitFor("document.querySelectorAll('.clip-skeleton').length === 0 && document.querySelectorAll('.clip-card:not(.clip-skeleton)').length === 3", 180000);
    await client.waitFor("document.querySelector('#status').textContent.includes('samples') || !document.querySelector('#error').hidden", 180000);
    const coarseResolved = await client.evaluate(`(() => {
      const card = document.querySelectorAll('.clip-card:not(.clip-skeleton)')[0];
      const rect = card.getBoundingClientRect();
      return {width: rect.width, height: rect.height, error: document.querySelector('#error').hidden ? null : document.querySelector('#error').textContent};
    })()`);
    assert.equal(coarseResolved.error, null, coarseResolved.error);
    assert.equal(coarseResolved.width, coarseSkeleton.width, 'coarse pointer: skeleton and card width must match exactly');
    assert.equal(coarseResolved.height, coarseSkeleton.height, 'coarse pointer: skeleton and card height must match exactly');
    assert.equal(`${parseFloat(coarseSkeleton.cssWidth)}`, `${coarseSkeleton.width}`);
    assert.equal(`${parseFloat(coarseSkeleton.cssHeight)}`, `${coarseSkeleton.height}`);
    await client.send('Emulation.setTouchEmulationEnabled', {enabled: false, maxTouchPoints: 1});
    await client.send('Emulation.setDeviceMetricsOverride', {width: 1200, height: 1600, deviceScaleFactor: 1, mobile: false});
    await client.send('Emulation.setEmulatedMedia', {features: []});
    console.log(`PASS coarse pointer: skeleton and card both measure exactly ${coarseSkeleton.width}x${coarseSkeleton.height} (${coarseSkeleton.cssHeight}) with 44px controls`);

    const webCodecsStub = await client.send('Page.addScriptToEvaluateOnNewDocument', {
      source: "Object.defineProperty(globalThis, 'VideoDecoder', {value: undefined, configurable: true}); Object.defineProperty(globalThis, 'VideoEncoder', {value: undefined, configurable: true});",
    });
    await client.send('Page.navigate', {url: `${baseUrl}?hevc-fallback=1`});
    await client.waitFor("document.querySelector('#file-input-a') !== null && document.documentElement.dataset.appReady === 'true'", 10000);
    assert.equal(await client.evaluate("typeof VideoDecoder + '/' + typeof VideoEncoder"), 'undefined/undefined');
    await client.setFile('#file-input-a', join(projectRoot, 'testmedia', 'synthetic-hevc.mov'));
    await client.waitFor("document.querySelector('#status').textContent.includes('clip A') || !document.querySelector('#error').hidden", 300000);
    const forcedHevcFallback = await client.evaluate(`(() => {
      const report = JSON.parse(document.querySelector('#report').textContent);
      return {
        error: document.querySelector('#error').hidden ? null : document.querySelector('#error').textContent,
        conversionHidden: document.querySelector('#conversion-progress').hidden,
        conversionMessage: document.querySelector('#conversion-message'),
        clipDetail: document.querySelector('.clip-card .clip-detail')?.textContent ?? null,
        source: report.sources?.a?.conversion ?? null,
      };
    })()`);
    assert.equal(forcedHevcFallback.error, null, forcedHevcFallback.error);
    assert.equal(forcedHevcFallback.conversionHidden, true);
    assert.equal(forcedHevcFallback.conversionMessage, null);
    assert.match(forcedHevcFallback.clipDetail, /^\d+\.\d{2} s$/);
    assert.equal(forcedHevcFallback.source.decodeEngine, 'ffmpeg.wasm');
    console.log('PASS WebCodecs unavailable: HEVC import uses ffmpeg.wasm and reports it only in JSON');
    await client.send('Page.navigate', {url: `${baseUrl}?fallback=1`});
    await client.waitFor("document.querySelector('#file-input-a') !== null && document.documentElement.dataset.appReady === 'true'", 10000);
    assert.equal(await client.evaluate("typeof VideoDecoder + '/' + typeof VideoEncoder"), 'undefined/undefined');
    await client.setFile('#file-input-a', fixtures.a);
    await client.waitFor("document.querySelector('#status').textContent.includes('clip A')", 15000);
    await client.setFile('#file-input-b', fixtures.b);
    await client.waitFor("document.querySelector('#status').textContent.includes('samples') || !document.querySelector('#error').hidden", 600000);
    const fallback = await client.evaluate(`(() => {
      const report = JSON.parse(document.querySelector('#report').textContent);
      return {
        conversionHidden: document.querySelector('#conversion-progress').hidden,
        conversionMessage: document.querySelector('#conversion-message'),
        error: document.querySelector('#error').hidden ? null : document.querySelector('#error').textContent,
        sources: report.sources,
      };
    })()`);
    assert.equal(fallback.error, null, fallback.error);
    assert.equal(fallback.conversionHidden, true);
    assert.equal(fallback.conversionMessage, null);
    assert.equal(fallback.sources.a.mode, 'normalized via ffmpeg.wasm');
    assert.equal(fallback.sources.b.mode, 'normalized via ffmpeg.wasm');
    assert.equal(fallback.sources.a.conversion.encodeEngine, 'ffmpeg.wasm');
    assert.equal(fallback.sources.b.conversion.encodeEngine, 'ffmpeg.wasm');
    assert.ok(fallback.sources.a.conversion.elapsedMs > 0);
    assert.ok(fallback.sources.b.conversion.elapsedMs > 0);
    console.log('PASS WebCodecs stubbed unavailable: ffmpeg.wasm fallback ran and the report identifies it');
    const fallbackCadence = await client.evaluate(`(async () => {
      const {convertToH264} = await import('./converter.js');
      const {parseMp4} = await import('./parser/mp4.js');
      const {extractNals} = await import('./parser/nal.js');
      const input = new Uint8Array(await (await fetch('/testmedia/synthetic-h264.mp4')).arrayBuffer());
      const result = await convertToH264(input, {});
      const parsed = parseMp4(result.bytes);
      const nals = extractNals(result.bytes, parsed.videoTrack);
      const idrSamples = [...new Set(nals.filter(nal => nal.type === 5).map(nal => nal.sampleIndex))];
      return {
        engine: result.encodeEngine,
        hybrid: result.hybrid,
        samples: parsed.videoTrack.samples.length,
        keyframes: idrSamples.map(index => index + 1),
        bytes: Array.from(result.bytes),
      };
    })()`);
    assert.equal(fallbackCadence.engine, 'ffmpeg.wasm');
    assert.equal(fallbackCadence.hybrid, false);
    assert.equal(fallbackCadence.samples, 90, 'the 25 fps fixture must become 90 frames at the 30 fps normalization grid');
    assert.ok(
      fallbackCadence.keyframes.length < 3,
      `the ffmpeg.wasm fallback emitted ${fallbackCadence.keyframes.length} IDRs at samples ${fallbackCadence.keyframes.join(', ')} on a 90-frame clip; the fallback still resets the mosh chain`,
    );
    assert.equal(fallbackCadence.keyframes[0], 1, 'the fallback output must still start with an IDR');
    writeFileSync(fallbackCadencePath, Uint8Array.from(fallbackCadence.bytes));
    const fallbackProbe = command('ffprobe', [
      '-v', 'error', '-select_streams', 'v:0', '-count_frames',
      '-show_entries', 'stream=nb_read_frames,has_b_frames', '-of', 'default=noprint_wrappers=1', fallbackCadencePath,
    ], 'ffmpeg.wasm fallback cadence probe');
    assert.match(fallbackProbe.stdout, /nb_read_frames=90/);
    assert.match(fallbackProbe.stdout, /has_b_frames=0/);
    command('ffmpeg', ['-v', 'error', '-i', fallbackCadencePath, '-f', 'null', '-'], 'ffmpeg.wasm fallback cadence strict decode');
    console.log(`PASS ffmpeg.wasm fallback emits ${fallbackCadence.keyframes.length} IDR (samples ${fallbackCadence.keyframes.join(', ')}) on 90 frames and decodes 90/90`);
    // The stub replaced the global constructors, so drop the pre-script and reload before any later test.
    await client.send('Page.removeScriptToEvaluateOnNewDocument', {identifier: webCodecsStub.identifier});
    await client.send('Page.navigate', {url: `${baseUrl}?webcodecs-restored=1`});
    await client.waitFor("document.querySelector('#file-input-a') !== null && document.documentElement.dataset.appReady === 'true'", 10000);
    assert.equal(await client.evaluate("typeof VideoDecoder + '/' + typeof VideoEncoder"), 'function/function');
  }

  const missingProjectScript = await client.send('Page.addScriptToEvaluateOnNewDocument', {
    source: `new MutationObserver(() => {
      const input = document.querySelector('#project-name');
      if (input) input.remove();
    }).observe(document, {childList: true, subtree: true});`,
  });
  await client.send('Page.setInterceptFileChooserDialog', {enabled: true});
  await client.send('Page.navigate', {url: `${baseUrl}?missing-project-picker=1`});
  await client.waitFor("document.querySelector('#file-input-a') !== null && document.documentElement.dataset.appReady === 'true'", 10000);
  assert.equal(await client.evaluate("document.querySelector('#project-name') === null"), true);
  assert.deepEqual(await client.evaluate(`(() => {
    const listeners = getEventListeners(document.querySelector('#drop-zone'));
    return Object.fromEntries(Object.entries(listeners).map(([name, entries]) => [name, entries.length]));
  })()`), {dragenter: 1, dragover: 1, dragleave: 1, drop: 1});
  const importBox = await client.evaluate(`(() => {
    const rect = document.querySelector('.file-actions .button').getBoundingClientRect();
    return {x: rect.left + rect.width / 2, y: rect.top + rect.height / 2};
  })()`);
  await client.send('Input.dispatchMouseEvent', {type: 'mouseMoved', x: importBox.x, y: importBox.y});
  await client.send('Input.dispatchMouseEvent', {type: 'mousePressed', x: importBox.x, y: importBox.y, button: 'left', clickCount: 1});
  await client.send('Input.dispatchMouseEvent', {type: 'mouseReleased', x: importBox.x, y: importBox.y, button: 'left', clickCount: 1});
  const chooser = await client.waitForEvent('Page.fileChooserOpened');
  await client.send('DOM.setFileInputFiles', {files: [fixtures.a], backendNodeId: chooser.params.backendNodeId});
  await client.waitFor("document.querySelectorAll('.clip-card').length === 1", 30000);
  const pickerImport = await client.evaluate(`({
    name: document.querySelector('.clip-card .clip-name').textContent,
    error: document.querySelector('#error').hidden ? null : document.querySelector('#error').textContent,
  })`);
  assert.deepEqual(pickerImport, {name: 'synthetic-b-a.mp4', error: null});
  await client.send('Page.setInterceptFileChooserDialog', {enabled: false});
  await client.send('Page.navigate', {url: `${baseUrl}?missing-project-drop=1`});
  await client.waitFor("document.querySelector('#file-input-a') !== null && document.documentElement.dataset.appReady === 'true'", 10000);
  await client.evaluate(`(async () => {
    const bytes = await (await fetch('/testmedia/synthetic-b-a.mp4')).arrayBuffer();
    const dataTransfer = new DataTransfer();
    dataTransfer.items.add(new File([bytes], 'drop-missing-project.mp4', {type: 'video/mp4'}));
    const zone = document.querySelector('#drop-zone');
    for (const type of ['dragenter', 'dragover', 'drop']) {
      zone.dispatchEvent(new DragEvent(type, {bubbles: true, cancelable: true, dataTransfer}));
    }
  })()`);
  await client.waitFor("document.querySelectorAll('.clip-card').length === 1", 30000);
  const dropImport = await client.evaluate(`({
    name: document.querySelector('.clip-card .clip-name').textContent,
    error: document.querySelector('#error').hidden ? null : document.querySelector('#error').textContent,
  })`);
  assert.deepEqual(dropImport, {name: 'drop-missing-project.mp4', error: null});
  await client.send('Page.removeScriptToEvaluateOnNewDocument', {identifier: missingProjectScript.identifier});
  console.log('PASS missing optional project-name cannot kill picker or drag-and-drop import wiring');

  // Shell consistency guard: matching stamps, negative proof, required contract.
  const appSourceText = readFileSync(join(projectRoot, 'app.js'), 'utf8');
  const optionalRegistry = [.../const OPTIONAL_UI = \[([\s\S]*?)\];/.exec(appSourceText)[1]
    .matchAll(/'([^']+)'/g)].map(match => match[1]);
  assert.ok(optionalRegistry.length >= 5, 'OPTIONAL_UI registry must list the optional features');

  const matchEventsStart = client.events.length;
  const matchExceptionsStart = client.exceptions.length;
  await client.send('Page.navigate', {url: `${baseUrl}?shell-match=1`});
  await client.waitFor("document.documentElement.dataset.appReady === 'true'", 10000);
  const matchedShell = await client.evaluate(`({
    notice: document.getElementById('shell-notice'),
    build: document.documentElement.dataset.build,
    meta: document.querySelector('meta[name="m4shlab-build"]').content,
    optional: document.documentElement.dataset.optionalUi,
  })`);
  assert.equal(matchedShell.notice, null, 'matching build stamps must not render #shell-notice');
  assert.equal(matchedShell.build, matchedShell.meta);
  assert.deepEqual(matchedShell.optional.split(','), optionalRegistry);
  assert.deepEqual(consoleMessages(client, matchEventsStart), [], 'a matching shell must not log console noise');
  assert.equal(client.exceptions.length, matchExceptionsStart);
  console.log(`PASS matching build stamps (${matchedShell.build}) render no #shell-notice, register ${optionalRegistry.length} optional ids, and log nothing`);

  const stampScript = await client.send('Page.addScriptToEvaluateOnNewDocument', {
    source: `new MutationObserver(() => {
      const meta = document.querySelector('meta[name="m4shlab-build"]');
      if (meta) meta.setAttribute('content', 'v20');
    }).observe(document, {childList: true, subtree: true});`,
  });
  const shellGuardExport = join(downloadDir, 'Shell-Guard.mp4');
  rmSync(shellGuardExport, {force: true});
  try {
    const mismatchExceptionsStart = client.exceptions.length;
    await client.send('Page.navigate', {url: `${baseUrl}?shell-stamp-mismatch=1`});
    await client.waitFor("document.documentElement.dataset.appReady === 'true'", 10000);
    const noticeState = await client.evaluate(`(() => {
      const notice = document.getElementById('shell-notice');
      return {
        text: notice?.querySelector('.shell-notice-text')?.textContent ?? null,
        reload: notice?.querySelector('.shell-notice-reload')?.textContent ?? null,
        dismissLabel: notice?.querySelector('.shell-notice-dismiss')?.getAttribute('aria-label') ?? null,
        reloadDisabled: null,
        exportDisabled: document.querySelector('#export-button').disabled,
      };
    })()`);
    assert.equal(noticeState.text, 'This page mixes two m4shlab versions. Reload to get a consistent editor.');
    assert.equal(noticeState.reload, 'Reload');
    assert.equal(noticeState.dismissLabel, 'Dismiss version notice');
    assert.equal(noticeState.exportDisabled, true);
    await client.evaluate(`(() => {
      const input = document.querySelector('#project-name');
      input.value = 'Shell Guard';
      input.dispatchEvent(new Event('input', {bubbles: true}));
    })()`);
    await client.setFiles('#file-input-a', [fixtures.a]);
    await client.waitFor("document.querySelectorAll('.clip-card').length === 1", 30000);
    await client.evaluate(`(async () => {
      const bytes = await (await fetch('/testmedia/synthetic-b-a.mp4')).arrayBuffer();
      const dataTransfer = new DataTransfer();
      dataTransfer.items.add(new File([bytes], 'shell-guard-drop.mp4', {type: 'video/mp4'}));
      const zone = document.querySelector('#drop-zone');
      for (const type of ['dragenter', 'dragover', 'drop']) {
        zone.dispatchEvent(new DragEvent(type, {bubbles: true, cancelable: true, dataTransfer}));
      }
    })()`);
    await client.waitFor("document.querySelectorAll('.clip-card').length === 2", 30000);
    await client.waitFor("document.querySelector('#status').textContent.includes('samples') || !document.querySelector('#error').hidden", 120000);
    assert.equal(await client.evaluate("document.querySelector('#shell-notice') !== null"), true, 'the notice must stay visible through import and merge');
    await client.evaluate("document.querySelector('#export-button').click()");
    await waitForDownload(shellGuardExport, 20000);
    const shellExportBytes = readFileSync(shellGuardExport);
    assert.ok(shellExportBytes.byteLength > 0);
    assert.equal(parseMp4(shellExportBytes instanceof Uint8Array ? shellExportBytes : new Uint8Array(shellExportBytes)).videoTrack.samples.length > 0, true);
    assert.equal(await client.evaluate("document.documentElement.dataset.appReady"), 'true');
    await client.evaluate("document.querySelector('.shell-notice-dismiss').click()");
    assert.equal(await client.evaluate("document.getElementById('shell-notice') === null"), true);
    await client.setFiles('#file-input-a', [fixtures.a]);
    await client.waitFor("document.querySelectorAll('.clip-card').length === 3", 30000);
    assert.equal(client.exceptions.length, mismatchExceptionsStart, 'the notice must not raise uncaught exceptions');
    console.log(`PASS stamped mismatch shows the reload notice, keeps appReady true, imports by picker and drop, and exports ${shellExportBytes.byteLength} bytes while dismissible`);
  } finally {
    await client.send('Page.removeScriptToEvaluateOnNewDocument', {identifier: stampScript.identifier});
  }

  const requiredScript = await client.send('Page.addScriptToEvaluateOnNewDocument', {
    source: removeElementsScript(['source-tiers']),
  });
  try {
    const requiredEventsStart = client.events.length;
    const requiredExceptionsStart = client.exceptions.length;
    await client.send('Page.navigate', {url: `${baseUrl}?shell-required-missing=1`});
    await client.waitFor("document.getElementById('shell-notice') !== null", 10000);
    const requiredState = await client.evaluate(`({
      text: document.getElementById('shell-notice').querySelector('.shell-notice-text').textContent,
      ready: document.documentElement.dataset.appReady ?? null,
      timeline: document.getElementById('source-tiers') === null,
    })`);
    assert.equal(requiredState.text, 'This editor is incomplete. Reload the page.');
    assert.equal(requiredState.ready, null);
    assert.equal(requiredState.timeline, true);
    const requiredErrors = consoleMessages(client, requiredEventsStart).filter(message => message.type === 'error');
    assert.equal(requiredErrors.length, 1, JSON.stringify(requiredErrors));
    assert.match(requiredErrors[0].text, /source-tiers/);
    assert.equal(client.exceptions.length, requiredExceptionsStart);
    console.log('PASS a missing required element shows the incomplete notice, logs one error naming source-tiers, and does not throw');
  } finally {
    await client.send('Page.removeScriptToEvaluateOnNewDocument', {identifier: requiredScript.identifier});
  }

  const optionalCases = [...optionalRegistry.map(id => ({ids: [id], label: id})), {ids: optionalRegistry, label: 'all optional'}];
  for (const optionalCase of optionalCases) {
    const script = await client.send('Page.addScriptToEvaluateOnNewDocument', {
      source: removeElementsScript(optionalCase.ids),
    });
    try {
      const exceptionsStart = client.exceptions.length;
      await client.send('Page.navigate', {url: `${baseUrl}?optional-missing=${encodeURIComponent(optionalCase.label)}`});
      await client.waitFor("document.documentElement.dataset.appReady === 'true'", 10000);
      const missing = await client.evaluate(`${JSON.stringify(optionalCase.ids)}.filter(id => document.getElementById(id) !== null)`);
      assert.deepEqual(missing, [], `optional ids ${optionalCase.label} must really be removed`);
      await client.setFiles('#file-input-a', [fixtures.a]);
      await client.waitFor("document.querySelectorAll('.clip-card').length === 1", 30000);
      await client.evaluate(`(async () => {
        const bytes = await (await fetch('/testmedia/synthetic-b-a.mp4')).arrayBuffer();
        const dataTransfer = new DataTransfer();
        dataTransfer.items.add(new File([bytes], 'optional-drop.mp4', {type: 'video/mp4'}));
        const zone = document.querySelector('#drop-zone');
        for (const type of ['dragenter', 'dragover', 'drop']) {
          zone.dispatchEvent(new DragEvent(type, {bubbles: true, cancelable: true, dataTransfer}));
        }
      })()`);
      await client.waitFor("document.querySelectorAll('.clip-card').length === 2", 30000);
      const optionalState = await client.evaluate(`({
        cards: document.querySelectorAll('.clip-card').length,
        notices: document.querySelectorAll('#shell-notice').length,
        error: document.querySelector('#error').hidden ? null : document.querySelector('#error').textContent,
      })`);
      assert.equal(optionalState.cards, 2);
      assert.equal(optionalState.notices, 0);
      assert.equal(optionalState.error, null);
      assert.equal(client.exceptions.length, exceptionsStart, `removing ${optionalCase.label} raised an exception`);
      console.log(`PASS optional element "${optionalCase.label}" missing: appReady true, picker + drop import produce 2 clips, no exception`);
    } finally {
      await client.send('Page.removeScriptToEvaluateOnNewDocument', {identifier: script.identifier});
    }
  }

  // Reload race guard: the notice must not reload into the same stale shell.
  const reloadScenario = body => client.evaluate(`(async () => {
    const container = navigator.serviceWorker;
    const savedController = Object.getOwnPropertyDescriptor(container, 'controller');
    const setController = value => Object.defineProperty(container, 'controller', {value, configurable: true});
    try {
      ${body}
    } finally {
      if (savedController) Object.defineProperty(container, 'controller', savedController);
      else delete container.controller;
    }
  })()`);

  const hookScript = await client.send('Page.addScriptToEvaluateOnNewDocument', {
    source: `new MutationObserver(() => {
      document.documentElement.dataset.testHooks = 'true';
    }).observe(document, {childList: true, subtree: true});`,
  });
  const reloadExceptionsStart = client.exceptions.length;
  try {
    await client.send('Page.navigate', {url: `${baseUrl}?reload-guard-hooks=1`});
    await client.waitFor("document.documentElement.dataset.appReady === 'true'", 10000);
    assert.equal(await client.evaluate("typeof window.m4shlabTest?.reloadAfterControllerChange"), 'function');

    const controllerChangeCase = await reloadScenario(`
      setController({});
      let reloads = 0;
      const registration = new EventTarget();
      registration.update = async () => {};
      registration.installing = null;
      const cleanup = window.m4shlabTest.reloadAfterControllerChange({
        registration,
        onReload: () => { reloads += 1; },
        timeoutMs: 2000,
      });
      const before = reloads;
      container.dispatchEvent(new Event('controllerchange'));
      const after = reloads;
      await new Promise(resolve => setTimeout(resolve, 100));
      cleanup();
      return {before, after, final: reloads};
    `);
    assert.equal(controllerChangeCase.before, 0, 'the helper must wait for the controller change');
    assert.equal(controllerChangeCase.after, 1);
    assert.equal(controllerChangeCase.final, 1);
    console.log('PASS reloadAfterControllerChange reloads exactly once on controllerchange and never before the event');

    const timeoutCase = await reloadScenario(`
      setController({});
      let reloads = 0;
      const registration = new EventTarget();
      registration.update = async () => {};
      registration.installing = null;
      window.m4shlabTest.reloadAfterControllerChange({
        registration,
        onReload: () => { reloads += 1; },
        timeoutMs: 50,
      });
      await new Promise(resolve => setTimeout(resolve, 200));
      return {reloads};
    `);
    assert.equal(timeoutCase.reloads, 1);
    console.log('PASS reloadAfterControllerChange falls back to the 50 ms timeout and reloads exactly once');

    const doubleTriggerCase = await reloadScenario(`
      setController({});
      let reloads = 0;
      const registration = new EventTarget();
      registration.update = async () => {};
      registration.installing = null;
      window.m4shlabTest.reloadAfterControllerChange({
        registration,
        onReload: () => { reloads += 1; },
        timeoutMs: 50,
      });
      container.dispatchEvent(new Event('controllerchange'));
      await new Promise(resolve => setTimeout(resolve, 200));
      return {reloads};
    `);
    assert.equal(doubleTriggerCase.reloads, 1);
    console.log('PASS a controllerchange followed by the expiry of the timeout still reloads exactly once');

    const activatedCase = await reloadScenario(`
      setController({});
      let reloads = 0;
      const registration = new EventTarget();
      registration.update = async () => {};
      registration.installing = null;
      const cleanup = window.m4shlabTest.reloadAfterControllerChange({
        registration,
        onReload: () => { reloads += 1; },
        timeoutMs: 2000,
      });
      const installing = new EventTarget();
      installing.state = 'installing';
      registration.installing = installing;
      registration.dispatchEvent(new Event('updatefound'));
      const afterUpdateFound = reloads;
      installing.state = 'activated';
      installing.dispatchEvent(new Event('statechange'));
      const afterActivated = reloads;
      await new Promise(resolve => setTimeout(resolve, 100));
      cleanup();
      return {afterUpdateFound, afterActivated, final: reloads};
    `);
    assert.equal(activatedCase.afterUpdateFound, 0);
    assert.equal(activatedCase.afterActivated, 1);
    assert.equal(activatedCase.final, 1);
    console.log('PASS updatefound plus installing statechange "activated" reloads exactly once and never on installing');

    const noControllerCase = await reloadScenario(`
      setController(null);
      let reloads = 0;
      const registration = new EventTarget();
      registration.update = async () => { throw new Error('update must not run without a controller'); };
      const cleanup = window.m4shlabTest.reloadAfterControllerChange({
        registration,
        onReload: () => { reloads += 1; },
        timeoutMs: 50,
      });
      const immediate = reloads;
      await new Promise(resolve => setTimeout(resolve, 150));
      cleanup();
      return {immediate, final: reloads};
    `);
    assert.equal(noControllerCase.immediate, 1, 'without a controller the reload must be immediate');
    assert.equal(noControllerCase.final, 1, 'no timeout may be left behind');
    console.log('PASS no service worker controller reloads immediately and leaves no timer behind');

    const unregisterCase = await reloadScenario(`
      setController({});
      let reloads = 0;
      let unregistered = 0;
      const registration = new EventTarget();
      registration.update = async () => {};
      registration.installing = null;
      registration.waiting = null;
      registration.unregister = async () => { unregistered += 1; return true; };
      window.m4shlabTest.reloadAfterControllerChange({
        registration,
        onReload: () => { reloads += 1; },
        timeoutMs: 50,
      });
      await new Promise(resolve => setTimeout(resolve, 200));
      return {reloads, unregistered};
    `);
    assert.equal(unregisterCase.reloads, 1);
    assert.equal(unregisterCase.unregistered, 1, 'the timeout path must unregister before reloading');
    console.log('PASS the reload timeout unregisters the stale registration before reloading exactly once');

    const installingCase = await reloadScenario(`
      setController({});
      let reloads = 0;
      let unregistered = 0;
      const registration = new EventTarget();
      registration.update = async () => {};
      const installing = new EventTarget();
      installing.state = 'installing';
      registration.installing = installing;
      registration.waiting = null;
      registration.unregister = async () => { unregistered += 1; return true; };
      window.m4shlabTest.reloadAfterControllerChange({
        registration,
        onReload: () => { reloads += 1; },
        timeoutMs: 50,
      });
      await new Promise(resolve => setTimeout(resolve, 200));
      const afterTimeout = reloads;
      installing.state = 'activated';
      installing.dispatchEvent(new Event('statechange'));
      await new Promise(resolve => setTimeout(resolve, 50));
      return {afterTimeout, reloads, unregistered};
    `);
    assert.equal(installingCase.afterTimeout, 0, 'an in-flight install must defer the reload');
    assert.equal(installingCase.reloads, 1);
    assert.equal(installingCase.unregistered, 0, 'an in-flight install must not be unregistered');
    console.log('PASS a timeout during an in-flight install waits for the activated state without unregistering');

    const rejectingUnregisterCase = await reloadScenario(`
      setController({});
      let reloads = 0;
      const registration = new EventTarget();
      registration.update = async () => {};
      registration.installing = null;
      registration.waiting = null;
      registration.unregister = async () => { throw new Error('unregister refused'); };
      window.m4shlabTest.reloadAfterControllerChange({
        registration,
        onReload: () => { reloads += 1; },
        timeoutMs: 50,
      });
      await new Promise(resolve => setTimeout(resolve, 200));
      return {reloads};
    `);
    assert.equal(rejectingUnregisterCase.reloads, 1);
    console.log('PASS a rejecting unregister still reloads exactly once');

    const rejectedUpdateCase = await reloadScenario(`
      setController({});
      let reloads = 0;
      let unhandled = 0;
      const onUnhandled = () => { unhandled += 1; };
      window.addEventListener('unhandledrejection', onUnhandled);
      const registration = new EventTarget();
      registration.update = async () => { throw new Error('registry unavailable'); };
      registration.installing = null;
      window.m4shlabTest.reloadAfterControllerChange({
        registration,
        onReload: () => { reloads += 1; },
        timeoutMs: 50,
      });
      await new Promise(resolve => setTimeout(resolve, 200));
      window.removeEventListener('unhandledrejection', onUnhandled);
      return {reloads, unhandled};
    `);
    assert.equal(rejectedUpdateCase.reloads, 1);
    assert.equal(rejectedUpdateCase.unhandled, 0);
    assert.equal(client.exceptions.length, reloadExceptionsStart);
    console.log('PASS a rejecting registration.update() still reloads exactly once without an unhandled rejection');
  } finally {
    await client.send('Page.removeScriptToEvaluateOnNewDocument', {identifier: hookScript.identifier});
  }

  await client.send('Page.navigate', {url: `${baseUrl}?reload-guard-no-hooks=1`});
  await client.waitFor("document.documentElement.dataset.appReady === 'true'", 10000);
  assert.equal(await client.evaluate("typeof window.m4shlabTest"), 'undefined');
  assert.equal(await client.evaluate("document.documentElement.dataset.testHooks ?? null"), null);
  console.log('PASS window.m4shlabTest stays undefined without the data-test-hooks opt-in');

  const integrationHook = await client.send('Page.addScriptToEvaluateOnNewDocument', {
    source: `new MutationObserver(() => {
      document.documentElement.dataset.testHooks = 'true';
    }).observe(document, {childList: true, subtree: true});`,
  });
  const integrationStamp = await client.send('Page.addScriptToEvaluateOnNewDocument', {
    source: `new MutationObserver(() => {
      const meta = document.querySelector('meta[name="m4shlab-build"]');
      if (meta) meta.setAttribute('content', 'v21');
    }).observe(document, {childList: true, subtree: true});`,
  });
  try {
    await client.send('Page.navigate', {url: `${baseUrl}?reload-guard-button=1`});
    await client.waitFor("document.getElementById('shell-notice') !== null && document.documentElement.dataset.appReady === 'true'", 10000);
    await client.waitFor("navigator.serviceWorker?.controller !== null && navigator.serviceWorker?.controller !== undefined", 15000);
    const reloadButtonState = await client.evaluate(`(() => {
      const button = document.querySelector('.shell-notice-reload');
      return {disabledBefore: button.disabled, labelBefore: button.textContent};
    })()`);
    assert.deepEqual(reloadButtonState, {disabledBefore: false, labelBefore: 'Reload'});
    await client.evaluate("document.querySelector('.shell-notice-reload').click()");
    const busyState = await client.evaluate(`(() => {
      const button = document.querySelector('.shell-notice-reload');
      return {
        disabled: button.disabled,
        busy: button.getAttribute('aria-busy'),
        label: button.textContent,
        noticeStillVisible: document.getElementById('shell-notice') !== null,
        appReady: document.documentElement.dataset.appReady,
        hooks: typeof window.m4shlabTest?.reloadAfterControllerChange,
      };
    })()`);
    assert.equal(busyState.disabled, true);
    assert.equal(busyState.busy, 'true');
    assert.equal(busyState.label, 'Reloading…');
    assert.equal(busyState.noticeStillVisible, true);
    assert.equal(busyState.appReady, 'true');
    assert.equal(busyState.hooks, 'function');
    await client.evaluate("document.querySelector('.shell-notice-reload').click()");
    await client.setFiles('#file-input-a', [fixtures.a]);
    await client.waitFor("document.querySelectorAll('.clip-card').length === 1", 20000);
    const responsiveState = await client.evaluate(`({
      cards: document.querySelectorAll('.clip-card').length,
      error: document.querySelector('#error').hidden ? null : document.querySelector('#error').textContent,
      label: document.querySelector('.shell-notice-reload')?.textContent ?? null,
    })`);
    assert.equal(responsiveState.cards, 1);
    assert.equal(responsiveState.error, null);
    assert.equal(responsiveState.label, 'Reloading…');
    console.log('PASS the Reload button disables itself with aria-busy and "Reloading…" while the page still imports a clip');
  } finally {
    await client.send('Page.removeScriptToEvaluateOnNewDocument', {identifier: integrationHook.identifier});
    await client.send('Page.removeScriptToEvaluateOnNewDocument', {identifier: integrationStamp.identifier});
  }

  // Connector and clip-card durations must follow the normalized fps.
  await client.send('Emulation.setDeviceMetricsOverride', {width: 520, height: 900, deviceScaleFactor: 1, mobile: false});
  const parityExceptionsStart = client.exceptions.length;
  await client.send('Page.navigate', {url: `${baseUrl}?connector-parity=1`});
  await client.waitFor("document.querySelector('#file-input-a') !== null && document.documentElement.dataset.appReady === 'true'", 10000);
  assert.equal(await client.evaluate("typeof VideoDecoder + '/' + typeof VideoEncoder"), 'function/function');
  await client.setFiles('#file-input-a', [fixtures.a, fixtures.b, fixtures.a]);
  await client.waitFor("document.querySelectorAll('.clip-card').length === 3", 30000);
  await client.waitFor(`(() => {
    const node = document.querySelector('#report');
    if (!node.textContent) return false;
    try {
      return JSON.parse(node.textContent).stage === 'merged';
    } catch { return false; }
  })()`, 120000);

  const readDurations = `(() => {
    const report = JSON.parse(document.querySelector('#report').textContent);
    return {
      stage: report.stage,
      normalized: report.normalization !== null,
      boundaries: report.transitions.map(item => ({
        method: item.method,
        frames: item.durationFrames,
        seconds: item.durationSeconds,
        ending: item.ending,
      })),
      connectors: [...document.querySelectorAll('.connector')].map(node => node.lastElementChild?.textContent ?? ''),
      cards: [...document.querySelectorAll('.clip-card')].map(card => card.querySelector('.clip-detail')?.textContent ?? ''),
      sources: report.sources.clips.map(clip => ({frames: clip.output_frames, speed: clip.speed})),
    };
  })()`;

  const parity = await client.evaluate(readDurations);
  assert.equal(parity.stage, 'merged');
  assert.equal(parity.normalized, true, 'the mismatched pair must normalize automatically');
  assert.equal(parity.boundaries.length, 2);
  assert.equal(parity.connectors.length, 2);
  parity.boundaries.forEach((boundary, index) => {
    const rendered = parity.connectors[index];
    const expected = boundary.seconds.toFixed(2);
    assert.ok(
      rendered.startsWith(`${expected} s`),
      `connector ${index}: rendered "${rendered}" does not show the report value ${expected} s`,
    );
    assert.equal(
      Number(expected),
      Number((boundary.frames / 30).toFixed(2)),
      `connector ${index}: ${boundary.frames} frames at the normalized 30 fps is not ${expected} s`,
    );
    assert.notEqual(
      Number(expected),
      Number((boundary.frames / 25).toFixed(2)),
      `connector ${index}: "${rendered}" still divides by the 25 fps source rate`,
    );
  });
  parity.cards.forEach((detail, index) => {
    const expected = `${(parity.sources[index].frames / 30).toFixed(2)} s`;
    assert.equal(detail, expected, `clip card ${index}: rendered "${detail}" does not match ${parity.sources[index].frames} frames at 30 fps`);
  });
  console.log(`PASS all ${parity.connectors.length} connectors and ${parity.cards.length} clip cards already match the normalized 30 fps report right after auto-normalization`);

  const safetyBefore = await client.evaluate(`(() => {
    const tiers = document.querySelector('#source-tiers');
    tiers.scrollLeft = Math.min(40, Math.max(0, tiers.scrollWidth - tiers.clientWidth));
    const cards = [...document.querySelectorAll('.clip-card')];
    cards[1].click();
    document.querySelectorAll('.connector')[1].click();
    return {
      scrollLeft: tiers.scrollLeft,
      scrollable: tiers.scrollWidth > tiers.clientWidth,
      selected: document.querySelector('.clip-card[aria-current="true"]')?.dataset.clipName ?? document.querySelector('.clip-card[aria-current="true"] .clip-name')?.textContent ?? null,
      undoDisabled: document.querySelector('#undo-button').disabled,
      redoDisabled: document.querySelector('#redo-button').disabled,
      dialogOpen: document.querySelector('#transition-dialog').open,
      dialogFrames: Number(document.querySelector('#transition-duration').value),
    };
  })()`);
  assert.equal(safetyBefore.dialogOpen, true);
  assert.equal(safetyBefore.scrollable, true, 'the timeline must be scrollable for the scrollLeft check to mean anything');
  assert.ok(safetyBefore.scrollLeft > 0, `timeline scrollLeft must be non-zero, saw ${safetyBefore.scrollLeft}`);

  await client.evaluate(`(() => {
    const speed = document.querySelectorAll('.clip-card')[2].querySelector('.clip-speed input');
    speed.value = '2';
    speed.dispatchEvent(new Event('change', {bubbles: true}));
  })()`);
  await client.waitFor(`(() => {
    const node = document.querySelector('#report');
    if (!node.textContent) return false;
    try {
      const report = JSON.parse(node.textContent);
      return report.stage === 'merged' && report.sources.clips[2]?.speed === 2;
    } catch { return false; }
  })()`, 120000);

  const safetyAfter = await client.evaluate(`(() => {
    const report = JSON.parse(document.querySelector('#report').textContent);
    const boundary = report.transitions[1];
    const tiers = document.querySelector('#source-tiers');
    const cards = [...document.querySelectorAll('.clip-card')];
    return {
      scrollLeft: tiers.scrollLeft,
      selected: cards.find(card => card.getAttribute('aria-current') === 'true')?.querySelector('.clip-name')?.textContent ?? null,
      undoDisabled: document.querySelector('#undo-button').disabled,
      redoDisabled: document.querySelector('#redo-button').disabled,
      dialogOpen: document.querySelector('#transition-dialog').open,
      dialogFrames: Number(document.querySelector('#transition-duration').value),
      reportFrames: boundary.durationFrames,
      reportSeconds: boundary.durationSeconds,
      dialogText: document.querySelector('#transition-duration-value').textContent,
      hashes: [...document.querySelectorAll('.connector')].map(node => node.lastElementChild?.textContent ?? ''),
      cards: cards.map(card => card.querySelector('.clip-detail')?.textContent ?? ''),
      sources: report.sources.clips.map(clip => ({frames: clip.output_frames, speed: clip.speed})),
    };
  })()`);
  assert.equal(safetyAfter.scrollLeft, safetyBefore.scrollLeft, 'the automatic re-render must preserve the timeline scroll position');
  assert.equal(safetyAfter.selected, safetyBefore.selected, 'the automatic re-render must preserve the previewed clip');
  assert.equal(safetyAfter.undoDisabled, safetyBefore.undoDisabled, 're-render must not change undo availability');
  assert.equal(safetyAfter.redoDisabled, safetyBefore.redoDisabled, 're-render must not change redo availability');
  assert.equal(safetyAfter.dialogOpen, true);
  assert.equal(safetyAfter.dialogFrames, safetyAfter.reportFrames, 'the open transition dialog must follow the new frame budget');
  assert.ok(
    safetyAfter.dialogText.startsWith(`${safetyAfter.reportSeconds.toFixed(2)} s`),
    `open dialog shows "${safetyAfter.dialogText}" but the report says ${safetyAfter.reportSeconds.toFixed(2)} s`,
  );
  safetyAfter.cards.forEach((detail, index) => {
    const expected = `${(safetyAfter.sources[index].frames / 30).toFixed(2)} s`;
    assert.equal(detail, expected, `clip card ${index} after the 2.0x speed change: "${detail}" vs ${expected}`);
  });
  console.log(`PASS re-render after a 2.0x speed change keeps scrollLeft ${safetyAfter.scrollLeft}, the previewed clip, undo/redo availability, and the open dialog in sync (${safetyAfter.dialogFrames} frames)`);

  const beforeIdle = await client.evaluate(readDurations);
  await closeDialog('#transition-dialog');
  await client.evaluate("document.querySelectorAll('.clip-card')[0].click()");
  await client.waitFor("document.querySelectorAll('.clip-card')[0].getAttribute('aria-current') === 'true'", 5000);
  const afterPreview = await client.evaluate(readDurations);
  assert.deepEqual(afterPreview.connectors, beforeIdle.connectors, 'a preview click must not change connector durations');

  await client.evaluate(`(() => {
    const move = document.querySelectorAll('.clip-card')[0].querySelector('[aria-label$="right"]');
    move.click();
  })()`);
  await client.waitFor(`(() => {
    const node = document.querySelector('#report');
    if (!node.textContent) return false;
    try {
      return JSON.parse(node.textContent).stage === 'merged';
    } catch { return false; }
  })()`, 120000);
  const afterReorder = await client.evaluate(readDurations);
  assert.deepEqual(
    [...afterReorder.connectors].sort(),
    [...beforeIdle.connectors].sort(),
    'a clip reorder must keep the same connector durations',
  );
  afterReorder.boundaries.forEach((boundary, index) => {
    assert.equal(
      Number(boundary.seconds.toFixed(2)),
      Number((boundary.frames / 30).toFixed(2)),
      `connector ${index} drifted after the reorder`,
    );
  });
  assert.equal(client.exceptions.length, parityExceptionsStart);
  console.log('PASS a preview click and a clip reorder leave every connector duration unchanged');
  await client.send('Emulation.setDeviceMetricsOverride', {width: 1200, height: 1600, deviceScaleFactor: 1, mobile: false});

  // Frame-exact trimmer: model, one-pass preparation, budget, audio, settings.
  const trimExceptionsStart = client.exceptions.length;
  await client.send('Emulation.setDeviceMetricsOverride', {width: 1200, height: 1600, deviceScaleFactor: 1, mobile: false});
  await client.send('Page.navigate', {url: `${baseUrl}?trim=1`});
  await client.waitFor("document.querySelector('#file-input-a') !== null && document.documentElement.dataset.appReady === 'true'", 10000);
  await client.setFiles('#file-input-a', [fixtures.speed, fixtures.silentB]);
  await client.waitFor("document.querySelectorAll('.clip-card').length === 2", 30000);
  await client.waitFor(`(() => {
    const node = document.querySelector('#report');
    if (!node.textContent) return false;
    try { return JSON.parse(node.textContent).stage === 'merged'; } catch { return false; }
  })()`, 180000);

  const geometry = await client.evaluate(`(() => {
    const rect = document.querySelectorAll('.clip-card')[0].getBoundingClientRect();
    const controls = document.querySelectorAll('.clip-card')[0].querySelectorAll('.clip-controls button');
    return {width: rect.width, height: rect.height, buttons: controls.length, trimLabel: controls[controls.length - 1].getAttribute('aria-label')};
  })()`);
  assert.ok(Math.abs(geometry.width - 148) < 0.6, `clip card width drifted to ${geometry.width}`);
  assert.ok(Math.abs(geometry.height - 211.5) < 1, `clip card height drifted to ${geometry.height}`);
  assert.equal(geometry.buttons, 4);
  assert.equal(geometry.trimLabel, 'Trim synthetic-speed-60.mp4');
  console.log(`PASS the trim button fits the unchanged ${geometry.width}x${geometry.height} clip card with a "Trim <file>" label`);

  const applyTrim = async (index, startFrame, endFrame) => {
    await client.evaluate(`document.querySelectorAll('.clip-card')[${index}].querySelector('.clip-trim-button').click()`);
    await client.waitFor("document.querySelector('#trim-dialog')?.open === true", 5000);
    await client.evaluate(`(() => {
      const start = document.querySelector('#trim-start');
      const end = document.querySelector('#trim-end');
      start.value = '${startFrame}';
      start.dispatchEvent(new Event('input', {bubbles: true}));
      end.value = '${endFrame}';
      end.dispatchEvent(new Event('input', {bubbles: true}));
      document.querySelector('#trim-apply').click();
    })()`);
    await client.waitFor(`(() => {
      const node = document.querySelector('#report');
      if (!node.textContent) return false;
      try { return JSON.parse(node.textContent).stage === 'merged'; } catch { return false; }
    })()`, 180000);
  };

  const readTrimState = `(() => {
    const report = JSON.parse(document.querySelector('#report').textContent);
    return {
      stage: report.stage,
      sources: report.sources.clips.map(clip => ({
        name: clip.name,
        start: clip.start_frame,
        end: clip.end_frame,
        trimmed: clip.trimmed_frames,
        frames: clip.output_frames,
        speed: clip.speed,
        look: clip.look,
        encodePasses: clip.lookReport?.encodePasses ?? null,
        audio: clip.audio ? {frames: clip.audio.frames, hasAudio: clip.audio.hasAudio === true} : null,
      })),
      boundaries: report.transitions.map(item => ({
        method: item.method,
        frames: item.durationFrames,
        requested: item.requested_frames,
        effective: item.effective_frames,
        clamped: item.clamped,
        seconds: item.durationSeconds,
      })),
      connectors: [...document.querySelectorAll('.connector')].map(node => node.lastElementChild.textContent),
      cards: [...document.querySelectorAll('.clip-card .clip-detail')].map(node => node.textContent),
    };
  })()`;

  await applyTrim(0, 10, 40);
  const trimmedOnce = await client.evaluate(readTrimState);
  assert.deepEqual(
    {start: trimmedOnce.sources[0].start, end: trimmedOnce.sources[0].end, trimmed: trimmedOnce.sources[0].trimmed},
    {start: 10, end: 40, trimmed: 30},
  );
  assert.equal(trimmedOnce.sources[0].frames, 30);
  assert.match(trimmedOnce.cards[0], /trimmed/);
  console.log(`PASS trim 10–40 keeps 30 of 60 source frames, re-encodes once (${trimmedOnce.sources[0].frames} frames) and marks the card`);

  await client.evaluate("document.querySelector('#undo-button').click()");
  await client.waitFor(`(() => {
    const node = document.querySelector('#report');
    if (!node.textContent) return false;
    try {
      const report = JSON.parse(node.textContent);
      return report.stage === 'merged' && report.sources.clips[0]?.start_frame === 0 && report.sources.clips[0]?.end_frame === 60;
    } catch { return false; }
  })()`, 180000);
  const undone = await client.evaluate(readTrimState);
  assert.equal(undone.sources[0].trimmed, 60);
  assert.equal(undone.sources[0].frames, 60);
  assert.doesNotMatch(undone.cards[0], /trimmed/);
  console.log('PASS one undo after Apply trim restores the full 60-frame clip, its card text and the merge budget');

  await client.evaluate(`(() => {
    const card = document.querySelectorAll('.clip-card')[0];
    const look = card.querySelector('.clip-look select');
    look.value = 'black-white';
    look.dispatchEvent(new Event('change', {bubbles: true}));
    const speed = card.querySelector('.clip-speed input');
    speed.value = '1.7';
    speed.dispatchEvent(new Event('change', {bubbles: true}));
  })()`);
  await client.waitFor(`(() => {
    try {
      const report = JSON.parse(document.querySelector('#report').textContent);
      return report.stage === 'merged' && report.sources.clips[0]?.speed === 1.7 && report.sources.clips[0]?.look === 'black-white';
    } catch { return false; }
  })()`, 180000);
  await applyTrim(0, 10, 40);
  const combined = await client.evaluate(readTrimState);
  assert.equal(combined.sources[0].speed, 1.7);
  assert.equal(combined.sources[0].look, 'black-white');
  assert.equal(combined.sources[0].encodePasses, 1, 'trim, look and speed must share one encode pass');
  assert.equal(combined.sources[0].frames, 18, '30 trimmed frames at 1.7x must plan 18 outputs');
  assert.equal(combined.sources[0].audio.frames, 18);
  assert.equal(combined.sources[1].audio.hasAudio, false);
  assert.equal(combined.sources[1].audio.frames, combined.sources[1].frames);
  const speedReportDonors = await client.evaluate(`(() => {
    const report = JSON.parse(document.querySelector('#report').textContent);
    const speedReport = report.sources.clips[0]?.speedReport ?? null;
    return speedReport ? {donors: speedReport.donorIndexes, audioFrames: speedReport.audioFrames, audioSamples: speedReport.audioSamples} : null;
  })()`);
  assert.ok(Array.isArray(speedReportDonors.donors) && speedReportDonors.donors.every(index => index >= 10 && index < 40), JSON.stringify(speedReportDonors.donors));
  assert.equal(speedReportDonors.audioFrames, 18);
  assert.equal(speedReportDonors.audioSamples, 18 * 1600, 'trimmed 1.7x audio must be exactly outputFrames x 1600 samples');
  console.log('PASS trim + black & white + 1.7x prepares in one pass, keeps every donor inside [10,40) and sizes the audio to 18 frames');

  await client.evaluate("document.querySelector('.connector').click()");
  await client.waitFor("document.querySelector('#transition-dialog')?.open === true", 5000);
  await client.evaluate(`(() => {
    const slider = document.querySelector('#transition-duration');
    slider.value = slider.max;
    slider.dispatchEvent(new Event('input', {bubbles: true}));
    document.querySelector('#transition-apply').click();
  })()`);
  await client.waitFor(`(() => {
    try { return JSON.parse(document.querySelector('#report').textContent).stage === 'merged'; } catch { return false; }
  })()`, 180000);
  const beforeShrink = await client.evaluate(readTrimState);
  await applyTrim(1, 0, 10);
  const afterShrink = await client.evaluate(readTrimState);
  assert.equal(afterShrink.boundaries[0].clamped, true, 'the shrunk budget must clamp the stored duration');
  assert.ok(afterShrink.boundaries[0].requested > afterShrink.boundaries[0].effective);
  assert.equal(
    afterShrink.connectors[0],
    `${afterShrink.boundaries[0].seconds.toFixed(2)} s · restore`,
    'the connector must show the clamped value',
  );
  assert.ok(beforeShrink.boundaries[0].requested <= beforeShrink.boundaries[0].effective + 0);
  await client.evaluate("document.querySelector('.connector').click()");
  await client.waitFor("document.querySelector('#transition-dialog')?.open === true", 5000);
  const clampState = await client.evaluate(`({
    mode: document.querySelector('#transition-duration-mode').textContent,
    frames: Number(document.querySelector('#transition-duration').value),
    max: Number(document.querySelector('#transition-duration').max),
    text: document.querySelector('#transition-duration-value').textContent,
  })`);
  await closeDialog('#transition-dialog');
  assert.equal(clampState.mode, 'clamped');
  assert.equal(clampState.frames, afterShrink.boundaries[0].effective);
  assert.equal(clampState.max, afterShrink.boundaries[0].effective);
  assert.ok(clampState.text.startsWith(`${afterShrink.boundaries[0].seconds.toFixed(2)} s`));
  console.log(`PASS a trim that shrinks the budget re-clamps the connector to ${afterShrink.boundaries[0].effective} frames, marks the dialog "clamped" and reports requested ${afterShrink.boundaries[0].requested} vs effective ${afterShrink.boundaries[0].effective}`);

  const trimSettingsPath = join(downloadDir, 'Trim-Set.m4settings');
  const trimlessPath = join(downloadDir, 'Trim-Set-notrim.m4settings');
  const trimBeyondPath = join(downloadDir, 'Trim-Set-beyond.m4settings');
  for (const path of [trimSettingsPath, trimlessPath, trimBeyondPath]) rmSync(path, {force: true});
  await client.evaluate(`(() => {
    const input = document.querySelector('#project-name');
    input.value = 'Trim Set';
    input.dispatchEvent(new Event('input', {bubbles: true}));
    document.querySelector('#project-menu').open = true;
  })()`);
  await client.evaluate("document.querySelector('#save-settings').click()");
  await waitForDownload(trimSettingsPath, 10000);
  const savedTrimSettings = JSON.parse(readFileSync(trimSettingsPath, 'utf8'));
  assert.equal(savedTrimSettings.clips[0].start_frame, 10);
  assert.equal(savedTrimSettings.clips[0].end_frame, 40);
  assert.equal(savedTrimSettings.clips[0].speed, 1.7);
  assert.equal(savedTrimSettings.clips[0].look, 'black-white');
  assert.equal(savedTrimSettings.clips[1].start_frame, 0);
  assert.equal(savedTrimSettings.clips[1].end_frame, 10);

  await client.send('Page.navigate', {url: `${baseUrl}?trim-settings=1`});
  await client.waitFor("document.querySelector('#file-input-a') !== null && document.documentElement.dataset.appReady === 'true'", 10000);
  await client.setFiles('#file-input-a', [fixtures.speed, fixtures.silentB]);
  await client.waitFor("document.querySelectorAll('.clip-card').length === 2", 30000);
  await client.waitFor(`(() => {
    try { return JSON.parse(document.querySelector('#report').textContent).stage === 'merged'; } catch { return false; }
  })()`, 180000);
  await client.evaluate(`(() => {
    const input = document.querySelector('#project-name');
    input.value = 'Trim Load';
    input.dispatchEvent(new Event('input', {bubbles: true}));
  })()`);
  await client.evaluate("document.querySelector('#project-menu').open = true");
  await client.setFile('#settings-input', trimSettingsPath);
  await client.waitFor("document.querySelector('#status').textContent === 'Settings loaded for 1 boundaries.'", 180000);
  const loadedTrim = await client.evaluate(readTrimState);
  assert.equal(loadedTrim.sources[0].start, 10);
  assert.equal(loadedTrim.sources[0].end, 40);
  assert.equal(loadedTrim.sources[0].speed, 1.7);
  assert.equal(loadedTrim.sources[0].look, 'black-white');
  assert.equal(loadedTrim.sources[0].frames, 18);
  assert.equal(loadedTrim.sources[1].start, 0);
  assert.equal(loadedTrim.sources[1].end, 10);
  assert.equal(loadedTrim.sources[1].frames, 10);
  console.log('PASS settings round-trip restores both trims plus the 1.7x speed and black & white look after a reload');

  const trimlessSettings = JSON.parse(readFileSync(trimSettingsPath, 'utf8'));
  for (const clip of trimlessSettings.clips) {
    delete clip.start_frame;
    delete clip.end_frame;
  }
  writeFileSync(trimlessPath, JSON.stringify(trimlessSettings, null, 2));
  await client.evaluate("document.querySelector('#project-menu').open = true");
  await client.setFile('#settings-input', trimlessPath);
  await client.waitFor("document.querySelector('#status').textContent === 'Settings loaded for 1 boundaries.'", 180000);
  const trimlessState = await client.evaluate(readTrimState);
  assert.deepEqual(
    trimlessState.sources.map(clip => [clip.start, clip.end, clip.trimmed]),
    [[0, 60, 60], [0, 25, 25]],
    'files without trim fields must load as full-clip trims',
  );
  assert.equal(trimlessState.sources[0].speed, 1.7);
  console.log('PASS settings files without trim fields load as full-clip trims and keep speed/look');

  const beforeBadTrim = await client.evaluate(`(() => {
    const report = JSON.parse(document.querySelector('#report').textContent);
    return {
      names: [...document.querySelectorAll('.clip-card .clip-name')].map(node => node.textContent),
      sources: report.sources.clips.map(clip => [clip.name, clip.start_frame, clip.end_frame, clip.speed, clip.look]),
      transitions: report.transitions.map(item => [item.method, item.durationFrames, item.ending]),
      project: document.querySelector('#project-name').value,
      reportText: document.querySelector('#report').textContent,
    };
  })()`);
  const beyondSettings = JSON.parse(readFileSync(trimSettingsPath, 'utf8'));
  beyondSettings.clips[1].start_frame = 20;
  beyondSettings.clips[1].end_frame = 999;
  writeFileSync(trimBeyondPath, JSON.stringify(beyondSettings, null, 2));
  await client.evaluate("document.querySelector('#project-menu').open = true");
  await client.setFile('#settings-input', trimBeyondPath);
  await client.waitFor("!document.querySelector('#error').hidden && /is outside the 25 source frames/.test(document.querySelector('#error').textContent)", 10000);
  const afterBadTrim = await client.evaluate(`(() => {
    const report = JSON.parse(document.querySelector('#report').textContent);
    return {
      names: [...document.querySelectorAll('.clip-card .clip-name')].map(node => node.textContent),
      sources: report.sources.clips.map(clip => [clip.name, clip.start_frame, clip.end_frame, clip.speed, clip.look]),
      transitions: report.transitions.map(item => [item.method, item.durationFrames, item.ending]),
      project: document.querySelector('#project-name').value,
      reportText: document.querySelector('#report').textContent,
    };
  })()`);
  assert.deepEqual(afterBadTrim, beforeBadTrim, 'a trim beyond the clip must leave the timeline byte-identical');
  assert.equal(client.exceptions.length, trimExceptionsStart);
  console.log('PASS a settings trim beyond the clip length errors out and leaves names, trims, transitions and report untouched');

  // Trim hardening: seconds inputs, clamp preview, thumbnail in-point.
  const hardeningExceptionsStart = client.exceptions.length;
  await client.send('Emulation.setDeviceMetricsOverride', {width: 1200, height: 1600, deviceScaleFactor: 1, mobile: false});
  await client.send('Page.navigate', {url: `${baseUrl}?trim-hardening=1`});
  await client.waitFor("document.querySelector('#file-input-a') !== null && document.documentElement.dataset.appReady === 'true'", 10000);
  await client.setFiles('#file-input-a', [fixtures.speed, fixtures.silentB]);
  await client.waitFor("document.querySelectorAll('.clip-card').length === 2", 30000);
  await client.waitFor(`(() => {
    try { return JSON.parse(document.querySelector('#report').textContent).stage === 'merged'; } catch { return false; }
  })()`, 180000);

  await client.evaluate("document.querySelectorAll('.clip-card')[0].querySelector('.clip-trim-button').click()");
  await client.waitFor("document.querySelector('#trim-dialog')?.open === true", 5000);
  const secondsSync = await client.evaluate(`(() => {
    const startSeconds = document.querySelector('#trim-start-seconds');
    const endSeconds = document.querySelector('#trim-end-seconds');
    startSeconds.value = '1.0';
    startSeconds.dispatchEvent(new Event('input', {bubbles: true}));
    endSeconds.value = '1.5';
    endSeconds.dispatchEvent(new Event('input', {bubbles: true}));
    const typed = {start: document.querySelector('#trim-start').value, end: document.querySelector('#trim-end').value};
    const startFrames = document.querySelector('#trim-start');
    const endFrames = document.querySelector('#trim-end');
    startFrames.value = '12';
    startFrames.dispatchEvent(new Event('input', {bubbles: true}));
    endFrames.value = '42';
    endFrames.dispatchEvent(new Event('input', {bubbles: true}));
    const frameSeconds = {start: document.querySelector('#trim-start-seconds').value, end: document.querySelector('#trim-end-seconds').value};
    document.querySelector('#trim-start-seconds').dispatchEvent(new Event('input', {bubbles: true}));
    document.querySelector('#trim-end-seconds').dispatchEvent(new Event('input', {bubbles: true}));
    return {
      typed,
      frameSeconds,
      roundTrip: {start: document.querySelector('#trim-start').value, end: document.querySelector('#trim-end').value},
      inputModes: [startSeconds.getAttribute('inputmode'), endSeconds.getAttribute('inputmode')],
      step: startSeconds.getAttribute('step'),
      readout: document.querySelector('#trim-readout').textContent,
    };
  })()`);
  assert.deepEqual(secondsSync.typed, {start: '30', end: '45'}, '1.0 s and 1.5 s at 30 fps must map to frames 30 and 45');
  assert.deepEqual(secondsSync.frameSeconds, {start: '0.40', end: '1.40'});
  assert.deepEqual(secondsSync.roundTrip, {start: '12', end: '42'}, 'frames -> seconds -> frames must not drift');
  assert.deepEqual(secondsSync.inputModes, ['decimal', 'decimal']);
  assert.equal(secondsSync.step, '0.1');
  assert.match(secondsSync.readout, /30 frames · 1\.00 s at 30 fps · 1\.00 s at 30 fps/);
  console.log('PASS seconds inputs (inputmode decimal, step 0.1) map 1.0/1.5 s to frames 30/45 and round-trip 12/42 without drift');

  await closeDialog('#trim-dialog');
  await client.evaluate("document.querySelector('.connector').click()");
  await client.waitFor("document.querySelector('#transition-dialog')?.open === true", 5000);
  await client.evaluate(`(() => {
    const slider = document.querySelector('#transition-duration');
    slider.value = slider.max;
    slider.dispatchEvent(new Event('input', {bubbles: true}));
    document.querySelector('#transition-apply').click();
  })()`);
  await client.waitFor(`(() => {
    try {
      const report = JSON.parse(document.querySelector('#report').textContent);
      return report.stage === 'merged' && report.transitions[0]?.effective_frames > 9;
    } catch { return false; }
  })()`, 180000);
  const beforeClampPreview = await client.evaluate(`(() => {
    const report = JSON.parse(document.querySelector('#report').textContent);
    return {frames: report.transitions[0].effective_frames, seconds: report.transitions[0].durationSeconds};
  })()`);

  await client.evaluate("document.querySelectorAll('.clip-card')[1].querySelector('.clip-trim-button').click()");
  await client.waitFor("document.querySelector('#trim-dialog')?.open === true", 5000);
  const clampPreview = await client.evaluate(`(() => {
    const start = document.querySelector('#trim-start');
    const end = document.querySelector('#trim-end');
    start.value = '0';
    start.dispatchEvent(new Event('input', {bubbles: true}));
    end.value = '10';
    end.dispatchEvent(new Event('input', {bubbles: true}));
    const hint = document.querySelector('#trim-clamp');
    return {hidden: hint.hidden, text: hint.textContent};
  })()`);
  assert.equal(clampPreview.hidden, false, 'a shrinking trim must preview the clamp before Apply');
  assert.match(
    clampPreview.text,
    new RegExp(`^1 transition will clamp: ${beforeClampPreview.seconds.toFixed(2)} s → 0\\.30 s$`),
    `unexpected clamp preview: ${clampPreview.text}`,
  );
  await client.evaluate("document.querySelector('#trim-apply').click()");
  await client.waitFor(`(() => {
    try { return JSON.parse(document.querySelector('#report').textContent).stage === 'merged'; } catch { return false; }
  })()`, 180000);
  const afterClampPreview = await client.evaluate(`(() => {
    const report = JSON.parse(document.querySelector('#report').textContent);
    return {
      connector: document.querySelector('.connector').lastElementChild.textContent,
      frames: report.transitions[0].effective_frames,
      seconds: report.transitions[0].durationSeconds,
      clamped: report.transitions[0].clamped,
    };
  })()`);
  assert.equal(afterClampPreview.clamped, true);
  assert.equal(afterClampPreview.frames, 9);
  assert.equal(afterClampPreview.connector, `0.30 s · restore`);
  assert.ok(clampPreview.text.endsWith(`0.30 s`), 'the previewed value must equal the applied value');
  console.log(`PASS the trim dialog previews "${clampPreview.text}" before Apply and the connector lands on exactly ${afterClampPreview.connector}`);

  await closeDialog('#trim-dialog');
  const thumbBefore = await client.evaluate(`(async () => {
    const card = document.querySelectorAll('.clip-card')[0];
    const video = card.querySelector('.clip-thumb video');
    for (let i = 0; i < 60 && video.readyState < 2; i += 1) await new Promise(r => setTimeout(r, 100));
    const canvas = document.createElement('canvas');
    canvas.width = 32;
    canvas.height = 32;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(video, 0, 0, 32, 32);
    const data = ctx.getImageData(0, 0, 32, 32).data;
    let hash = 0;
    for (let i = 0; i < data.length; i += 4) hash = (Math.imul(hash, 31) + data[i] + data[i + 1] * 7 + data[i + 2] * 13) >>> 0;
    return {hash, time: video.currentTime, src: video.currentSrc || video.src};
  })()`);
  await client.evaluate("document.querySelectorAll('.clip-card')[0].querySelector('.clip-trim-button').click()");
  await client.waitFor("document.querySelector('#trim-dialog')?.open === true", 5000);
  await client.evaluate(`(() => {
    const start = document.querySelector('#trim-start');
    const end = document.querySelector('#trim-end');
    start.value = '10';
    start.dispatchEvent(new Event('input', {bubbles: true}));
    end.value = '40';
    end.dispatchEvent(new Event('input', {bubbles: true}));
    document.querySelector('#trim-apply').click();
  })()`);
  await client.waitFor(`(() => {
    try { return JSON.parse(document.querySelector('#report').textContent).stage === 'merged'; } catch { return false; }
  })()`, 180000);
  const thumbTrimmed = await client.evaluate(`(async () => {
    const card = document.querySelectorAll('.clip-card')[0];
    const video = card.querySelector('.clip-thumb video');
    for (let i = 0; i < 60 && video.readyState < 2; i += 1) await new Promise(r => setTimeout(r, 100));
    const canvas = document.createElement('canvas');
    canvas.width = 32;
    canvas.height = 32;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(video, 0, 0, 32, 32);
    const data = ctx.getImageData(0, 0, 32, 32).data;
    let hash = 0;
    for (let i = 0; i < data.length; i += 4) hash = (Math.imul(hash, 31) + data[i] + data[i + 1] * 7 + data[i + 2] * 13) >>> 0;
    return {hash, time: video.currentTime, src: video.currentSrc || video.src};
  })()`);
  assert.notEqual(thumbTrimmed.hash, thumbBefore.hash, 'the trimmed thumbnail must show the in-point frame');
  assert.ok(thumbTrimmed.src.includes('#t=0.33'), `thumbnail must seek to the in-point, saw ${thumbTrimmed.src}`);

  await client.evaluate("document.querySelectorAll('.clip-card')[0].querySelector('.clip-trim-button').click()");
  await client.waitFor("document.querySelector('#trim-dialog')?.open === true", 5000);
  await client.evaluate("document.querySelector('#trim-reset').click(); document.querySelector('#trim-apply').click();");
  await client.waitFor(`(() => {
    try { return JSON.parse(document.querySelector('#report').textContent).stage === 'merged'; } catch { return false; }
  })()`, 180000);
  const thumbReset = await client.evaluate(`(async () => {
    const card = document.querySelectorAll('.clip-card')[0];
    const video = card.querySelector('.clip-thumb video');
    for (let i = 0; i < 60 && video.readyState < 2; i += 1) await new Promise(r => setTimeout(r, 100));
    const canvas = document.createElement('canvas');
    canvas.width = 32;
    canvas.height = 32;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(video, 0, 0, 32, 32);
    const data = ctx.getImageData(0, 0, 32, 32).data;
    let hash = 0;
    for (let i = 0; i < data.length; i += 4) hash = (Math.imul(hash, 31) + data[i] + data[i + 1] * 7 + data[i + 2] * 13) >>> 0;
    return {hash, src: video.currentSrc || video.src};
  })()`);
  assert.equal(thumbReset.hash, thumbBefore.hash, 'Reset must bring the thumbnail back to frame 0');
  assert.ok(thumbReset.src.includes('#t=0.001'));
  assert.equal(client.exceptions.length, hardeningExceptionsStart);
  console.log('PASS the card thumbnail jumps to the trim in-point, differs from the untrimmed card and returns to frame 0 after Reset');

  // Regression for the dialog-close contract: close() and the reopen happen in
  // one task turn, so the queued `close` event lands after the dialog is open
  // again. That must not null the active index. A human cannot produce this
  // timing; a shortcut or a chained action can.
  const trimReopen = await client.evaluate(`(() => {
    const button = () => document.querySelectorAll('.clip-card')[0].querySelector('.clip-trim-button');
    button().click();
    const start = document.querySelector('#trim-start');
    start.value = '10';
    start.dispatchEvent(new Event('input', {bubbles: true}));
    document.querySelector('#trim-apply').click();
    button().click();
    return {open: document.querySelector('#trim-dialog').open, readout: document.querySelector('#trim-readout').textContent};
  })()`);
  assert.equal(trimReopen.open, true, 'the trim dialog did not reopen in the same task turn');
  await client.evaluate('new Promise(resolve => setTimeout(resolve, 100))');
  const trimInteractive = await client.evaluate(`(() => {
    const before = document.querySelector('#trim-readout').textContent;
    document.querySelector('#trim-reset').click();
    const after = document.querySelector('#trim-readout').textContent;
    document.querySelector('#trim-apply').click();
    return {before, after, closed: document.querySelector('#trim-dialog').open === false};
  })()`);
  assert.equal(trimInteractive.closed, true, 'Apply was ignored after the trim dialog was reopened in the same task turn (a stale close event nulled trimClipIndex)');
  assert.notEqual(trimInteractive.after, trimInteractive.before, `Reset did not update the readout after reopening (still "${trimInteractive.before}")`);
  await client.waitFor(`(() => { try { return JSON.parse(document.querySelector('#report').textContent).sources?.clips?.[0]?.start_frame === 0; } catch { return false; } })()`, 120000);

  const transitionReopen = await client.evaluate(`(() => {
    const connector = () => document.querySelectorAll('.connector')[0];
    connector().click();
    const method = document.querySelector('#transition-method');
    method.value = 'melt';
    method.dispatchEvent(new Event('change', {bubbles: true}));
    document.querySelector('#transition-apply').click();
    connector().click();
    return {open: document.querySelector('#transition-dialog').open};
  })()`);
  assert.equal(transitionReopen.open, true, 'the transition dialog did not reopen in the same task turn');
  await client.evaluate('new Promise(resolve => setTimeout(resolve, 100))');
  const transitionInteractive = await client.evaluate(`(() => {
    const method = document.querySelector('#transition-method');
    method.value = 'loop';
    method.dispatchEvent(new Event('change', {bubbles: true}));
    const effectVisible = document.querySelector('#nal-effect-options').hidden === false;
    document.querySelector('#transition-apply').click();
    return {effectVisible, closed: document.querySelector('#transition-dialog').open === false};
  })()`);
  assert.equal(transitionInteractive.effectVisible, true, 'the reopened transition dialog did not switch to the Loop controls');
  assert.equal(transitionInteractive.closed, true, 'Apply was ignored after the transition dialog was reopened in the same task turn (a stale close event nulled activeBoundary)');
  await client.waitFor(`(() => { try { return JSON.parse(document.querySelector('#report').textContent).transitions?.[0]?.method === 'loop'; } catch { return false; } })()`, 120000);
  console.log('PASS reopening the trim and transition dialogs in the same task turn keeps them interactive (Apply, Reset and readout still work)');

  // Task C: the look must land on the trimmed pixels, not on frame 0.
  const pixelsExportPath = join(downloadDir, 'Trim-Pixels.mp4');
  rmSync(pixelsExportPath, {force: true});
  await client.send('Page.navigate', {url: `${baseUrl}?trim-look-pixels=1`});
  await client.waitFor("document.querySelector('#file-input-a') !== null && document.documentElement.dataset.appReady === 'true'", 10000);
  await client.setFiles('#file-input-a', [fixtures.speed, fixtures.silentB]);
  await client.waitFor("document.querySelectorAll('.clip-card').length === 2", 30000);
  await client.waitFor(`(() => {
    try { return JSON.parse(document.querySelector('#report').textContent).stage === 'merged'; } catch { return false; }
  })()`, 180000);
  await client.evaluate(`(() => {
    document.querySelectorAll('.clip-card')[0].querySelector('.clip-look select').value = 'black-white';
    document.querySelectorAll('.clip-card')[0].querySelector('.clip-look select').dispatchEvent(new Event('change', {bubbles: true}));
  })()`);
  await client.waitFor(`(() => {
    try { return JSON.parse(document.querySelector('#report').textContent).sources.clips[0]?.look === 'black-white'; } catch { return false; }
  })()`, 180000);
  await client.evaluate("document.querySelectorAll('.clip-card')[0].querySelector('.clip-trim-button').click()");
  await client.waitFor("document.querySelector('#trim-dialog')?.open === true", 5000);
  await client.evaluate(`(() => {
    const start = document.querySelector('#trim-start');
    const end = document.querySelector('#trim-end');
    start.value = '10';
    start.dispatchEvent(new Event('input', {bubbles: true}));
    end.value = '40';
    end.dispatchEvent(new Event('input', {bubbles: true}));
    document.querySelector('#trim-apply').click();
  })()`);
  await client.waitFor(`(() => {
    const node = document.querySelector('#report');
    try {
      const report = JSON.parse(node.textContent);
      return report.stage === 'merged' && report.sources.clips[0]?.start_frame === 10 && report.sources.clips[0]?.look === 'black-white' && report.sources.clips[0]?.speed === 1;
    } catch { return false; }
  })()`, 180000);
  await client.evaluate("document.querySelector('.connector').click()");
  await client.waitFor("document.querySelector('#transition-dialog')?.open === true", 5000);
  await client.evaluate(`(() => {
    document.querySelector('#transition-method').value = 'cut';
    document.querySelector('#transition-method').dispatchEvent(new Event('change', {bubbles: true}));
    document.querySelector('#transition-apply').click();
  })()`);
  await client.waitFor(`(() => {
    try { return JSON.parse(document.querySelector('#report').textContent).transitions[0]?.method === 'cut'; } catch { return false; }
  })()`, 180000);
  await client.evaluate(`(() => {
    const input = document.querySelector('#project-name');
    input.value = 'Trim Pixels';
    input.dispatchEvent(new Event('input', {bubbles: true}));
  })()`);
  await client.evaluate("document.querySelector('#export-button').click()");
  await waitForDownload(pixelsExportPath, 30000);

  const mergedFrame = framePixels(pixelsExportPath, 0);
  const chromaSpread = meanChromaSpread(mergedFrame);
  const neighbours = [0, 8, 9, 10, 11, 12, 14].map(index => ({
    index,
    difference: meanAbsRgbDiff(mergedFrame, toLumaRgb(framePixels(fixtures.speed, index))),
  }));
  const best = neighbours.reduce((winner, entry) => (entry.difference < winner.difference ? entry : winner));
  const madInPoint = neighbours.find(entry => entry.index === 10).difference;
  const madFrameZero = neighbours.find(entry => entry.index === 0).difference;
  assert.equal(best.index, 10, `the exported frame matches source frame ${best.index} best, not the trim in-point 10`);
  assert.ok(madInPoint <= 16, `exported frame 0 differs from source frame 10 by ${madInPoint.toFixed(2)} (tolerance 16 for encoder loss)`);
  assert.ok(chromaSpread <= 2, `exported frame 0 is not neutral: mean chroma spread ${chromaSpread.toFixed(2)}`);
  assert.ok(madFrameZero >= 18, `the negative half must fail: frame 0 vs source frame 0 is only ${madFrameZero.toFixed(2)}`);
  assert.ok(madFrameZero > madInPoint + 4, `frame 0 vs source frame 0 (${madFrameZero.toFixed(2)}) must be clearly worse than vs the in-point (${madInPoint.toFixed(2)})`);
  console.log(`PASS black & white lands on the trimmed pixels: exported frame 0 matches source frame 10 best (MAD ${madInPoint.toFixed(2)} <= 16, chroma ${chromaSpread.toFixed(2)}) and misses source frame 0 (MAD ${madFrameZero.toFixed(2)} >= 18)`);

  // ── Software preview and ?debug=1 diagnostics ────────────────────────────
  await client.evaluate("localStorage.removeItem('m4shlab-software-preview'); true");
  await client.send('Page.navigate', {url: `${baseUrl}?software-preview-check=1`});
  await client.waitFor("document.documentElement.dataset.appReady === 'true'", 15000);
  const previewDefaults = await client.evaluate(`(() => {
    const order = [...document.querySelector('.preview-options').children].map(node => node.id || node.className);
    const toggle = document.querySelector('#software-preview');
    return {
      order,
      checked: toggle.checked,
      tooltip: toggle.closest('label')?.title ?? '',
      canvasHidden: document.querySelector('#preview-canvas').hidden,
      debugHidden: document.querySelector('#debug-panel').hidden,
      stored: localStorage.getItem('m4shlab-software-preview'),
    };
  })()`);
  assert.deepEqual(previewDefaults.order, ['sound-toggle', 'preview-time', 'software-toggle', 'software-marker'], `preview row order is ${JSON.stringify(previewDefaults.order)}`);
  assert.equal(previewDefaults.checked, false, 'software preview must default to off');
  assert.equal(previewDefaults.canvasHidden, true, 'the preview canvas must stay hidden while software preview is off');
  assert.equal(previewDefaults.debugHidden, true, 'the diagnostics overlay must stay hidden without ?debug=1');
  assert.equal(previewDefaults.stored, null, 'a fresh profile must not carry a stored software-preview preference');
  assert.match(previewDefaults.tooltip, /Audio is not played in software preview/, 'the software preview tooltip must state that audio is not played');
  console.log('PASS software preview defaults to off, sits next to the time readout, states the audio limit in its tooltip, and the diagnostics overlay stays hidden without ?debug=1');

  await client.setFiles('#file-input-a', [fixtures.effectA, fixtures.effectB]);
  await client.waitFor("document.querySelectorAll('.clip-card').length === 2", 60000);
  await client.waitFor("!document.querySelector('#assemble-preview').disabled", 180000);
  await client.evaluate("document.querySelector('#assemble-preview').click()");
  await new Promise(resolve => setTimeout(resolve, 400));
  await client.evaluate(`(() => {
    const toggle = document.querySelector('#software-preview');
    toggle.checked = true;
    toggle.dispatchEvent(new Event('change', {bubbles: true}));
  })()`);
  await client.waitFor("document.querySelector('#preview-canvas').hidden === false", 20000);
  await new Promise(resolve => setTimeout(resolve, 700));
  const softwareFirst = await client.evaluate(`(() => {
    const canvas = document.querySelector('#preview-canvas');
    const data = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data;
    let ink = 0;
    for (let index = 0; index < data.length; index += 4) if (data[index] + data[index + 1] + data[index + 2] > 40) ink += 1;
    return {
      width: canvas.width,
      height: canvas.height,
      ink,
      time: document.querySelector('#preview-time').textContent,
      videoHidden: document.querySelector('#preview-video').hidden,
      canvasHidden: canvas.hidden,
      stored: localStorage.getItem('m4shlab-software-preview'),
      error: document.querySelector('#error').hidden ? null : document.querySelector('#error').textContent,
      label: document.querySelector('#preview-label').textContent,
    };
  })()`);
  assert.equal(softwareFirst.error, null, softwareFirst.error || 'software preview reported an error');
  assert.equal(softwareFirst.videoHidden, true, 'the <video> element must step aside while software preview runs');
  assert.equal(softwareFirst.canvasHidden, false);
  assert.ok(softwareFirst.ink > 1000, `software preview canvas holds only ${softwareFirst.ink} lit pixels`);
  assert.ok(softwareFirst.width <= 720 && softwareFirst.height <= 720, `software preview canvas is ${softwareFirst.width}x${softwareFirst.height}, above the 720px cap`);
  assert.equal(softwareFirst.stored, 'true', 'the software preview preference must persist');
  assert.match(softwareFirst.label, /Assembled preview/, `preview label is ${softwareFirst.label}`);
  const softwareTimeStart = Number.parseFloat(softwareFirst.time);
  assert.ok(softwareTimeStart > 0, `software preview did not advance its clock (${softwareFirst.time})`);
  await new Promise(resolve => setTimeout(resolve, 800));
  const softwareTime = await client.evaluate("document.querySelector('#preview-time').textContent");
  assert.ok(Number.parseFloat(softwareTime) > softwareTimeStart, `software preview clock did not advance past ${softwareFirst.time} (now ${softwareTime})`);
  console.log(`PASS software preview decodes the assembled stream into the ${softwareFirst.width}x${softwareFirst.height} canvas (${softwareFirst.ink} lit pixels), advances ${softwareFirst.time} -> ${softwareTime}, hides the <video> and persists its preference`);

  await client.evaluate("window.VideoDecoder = class { constructor() { throw new Error('probe decoder failure'); } }; true");
  await client.evaluate(`(() => {
    const toggle = document.querySelector('#software-preview');
    toggle.checked = false;
    toggle.dispatchEvent(new Event('change', {bubbles: true}));
    toggle.checked = true;
    toggle.dispatchEvent(new Event('change', {bubbles: true}));
  })()`);
  await new Promise(resolve => setTimeout(resolve, 600));
  const softwareFallback = await client.evaluate(`(() => ({
    checked: document.querySelector('#software-preview').checked,
    videoHidden: document.querySelector('#preview-video').hidden,
    canvasHidden: document.querySelector('#preview-canvas').hidden,
    error: document.querySelector('#error').hidden ? null : document.querySelector('#error').textContent,
    stored: localStorage.getItem('m4shlab-software-preview'),
  }))()`);
  assert.equal(softwareFallback.error === null, false, 'a failing software decode must not stay silent');
  assert.match(softwareFallback.error, /Software preview could not decode this stream/, `fallback message is ${softwareFallback.error}`);
  assert.match(softwareFallback.error, /video element instead/, 'the fallback message must name the fallback path');
  assert.equal(softwareFallback.checked, false, 'a failing software decode must switch the toggle off');
  assert.equal(softwareFallback.stored, 'false', 'the switched-off preference must persist');
  assert.equal(softwareFallback.canvasHidden, true, 'the canvas must hide on fallback');
  assert.equal(softwareFallback.videoHidden, false, 'the <video> element must come back on fallback');
  console.log('PASS a failing software decode reports the reason, reverts to the <video> element and persists the switched-off state');

  await client.send('Page.navigate', {url: `${baseUrl}?debug=1`});
  await client.waitFor("document.documentElement.dataset.appReady === 'true'", 15000);
  await client.setFiles('#file-input-a', [fixtures.effectA, fixtures.effectB]);
  await client.waitFor("document.querySelectorAll('.clip-card').length === 2", 60000);
  await client.waitFor("!document.querySelector('#assemble-preview').disabled", 180000);
  await client.evaluate("document.querySelector('#assemble-preview').click()");
  await client.waitFor("document.querySelector('#debug-panel').hidden === false", 10000);
  await client.waitFor("document.querySelector('#debug-info').textContent.includes('sw.js VERSION')", 15000);
  await client.evaluate("document.querySelector('#debug-strip-modified').click()");
  await client.waitFor("document.querySelector('#debug-strip-status').textContent.startsWith('12/12 frames · modified stream')", 120000);
  const modified = await client.evaluate("document.querySelector('#debug-strip-status').textContent");
  await client.evaluate("document.querySelector('#debug-strip-cut').click()");
  await client.waitFor("document.querySelector('#debug-strip-status').textContent.startsWith('12/12 frames · cut control')", 120000);
  const cut = await client.evaluate("document.querySelector('#debug-strip-status').textContent");
  const diagnostics = await client.evaluate(`(() => {
    const canvas = document.querySelector('#debug-strip-canvas');
    const info = document.querySelector('#debug-info').textContent;
    const strip = document.querySelector('#debug-video-state').textContent;
    const data = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data;
    let ink = 0;
    for (let index = 0; index < data.length; index += 4) if (data[index] + data[index + 1] + data[index + 2] > 40) ink += 1;
    return {
      info,
      strip,
      ink,
      download: !document.querySelector('#debug-strip-download').hidden,
      href: document.querySelector('#debug-strip-download').getAttribute('href') || '',
    };
  })()`);
  assert.match(modified, /boundary sample 25/, `modified strip did not centre on the mosh boundary: ${modified}`);
  assert.match(diagnostics.info, /build\s+v\d+ \(page stamp\) · sw\.js VERSION v\d+/, 'diagnostics must name the page build and the sw.js VERSION');
  assert.match(diagnostics.info, /WebCodecs\s+VideoDecoder yes/, 'diagnostics must report WebCodecs support');
  assert.match(diagnostics.info, /decoder cfg\s+avc1\./, 'diagnostics must report isConfigSupported for the clip configuration');
  assert.match(diagnostics.info, /clip 1\s+.*·.*·.*·.*frames/, 'diagnostics must list the per-clip conversion path and frame count');
  assert.match(diagnostics.info, /video\s+error=.*readyState=.*networkState=.*/s, 'diagnostics must sample the <video> element state');
  assert.match(diagnostics.strip, /sha256 [0-9a-f]{32}/, `strip provenance line is ${diagnostics.strip}`);
  assert.ok(diagnostics.ink > 1000, `frame strip holds only ${diagnostics.ink} lit pixels`);
  assert.equal(diagnostics.download, true, 'the strip PNG download must be offered');
  assert.match(diagnostics.href, /^blob:/, `strip download href is ${diagnostics.href}`);
  console.log(`PASS ?debug=1 shows build/sw.js VERSION, WebCodecs verdict, per-clip paths and <video> state, and renders a 12-frame strip for the modified stream (${modified}) and the cut control (${cut}) with a PNG hash`);

  // ── Import resilience: watchdog, busy release, worker respawn ────────────
  // `synthetic-fragmented.mp4` cannot be parsed, so every import of it takes
  // the ffmpeg.wasm worker path — the fake Worker below therefore always deadlocks.
  const silentWorkerSource = `(() => {
    const apply = () => {
      document.documentElement.dataset.conversionWatchdogMs = '1500';
      document.documentElement.dataset.importStallMs = '20000';
    };
    if (document.documentElement) apply();
    else document.addEventListener('DOMContentLoaded', apply, {once: true});
    window.__realWorker = window.Worker;
    window.Worker = class SilentWorker extends EventTarget {
      postMessage() {}
      terminate() {}
    };
  })();`;
  const watchScript = await client.send('Page.addScriptToEvaluateOnNewDocument', {source: silentWorkerSource});
  await client.send('Page.navigate', {url: `${baseUrl}?resilience=watchdog`});
  await client.waitFor("document.documentElement.dataset.appReady === 'true'", 15000);
  await client.setFiles('#file-input-a', [fixtures.fragmented]);
  await client.waitFor("!document.querySelector('#error').hidden", 30000);
  const stalled = await client.evaluate(`(() => ({
    error: document.querySelector('#error').textContent,
    status: document.querySelector('#status').textContent,
    loadDisabled: document.querySelector('#load-settings').disabled,
    skeletons: document.querySelectorAll('.clip-skeleton').length,
    cards: document.querySelectorAll('.clip-card').length,
    progressHidden: document.querySelector('#conversion-progress').hidden,
  }))()`);
  assert.match(stalled.error, /Conversion did not respond\. Reload the page and try a shorter clip\./, `watchdog message is ${stalled.error}`);
  assert.equal(stalled.loadDisabled, false, 'the busy state must be released after a watchdog abort');
  assert.equal(stalled.skeletons, 0, `the watchdog left ${stalled.skeletons} skeleton cards behind`);
  assert.equal(stalled.cards, 0, 'a conversion that never answered must not add a clip');
  assert.equal(stalled.progressHidden, true, 'the conversion panel must close after a watchdog abort');
  await client.send('Page.removeScriptToEvaluateOnNewDocument', {identifier: watchScript.identifier});
  await client.evaluate('window.Worker = window.__realWorker; true');
  await client.setFiles('#file-input-a', [fixtures.effectA]);
  await client.waitFor("document.querySelectorAll('.clip-card').length === 1", 180000);
  const recovered = await client.evaluate("document.querySelector('#error').hidden ? null : document.querySelector('#error').textContent");
  assert.equal(recovered, null, `the import after a watchdog abort still reports: ${recovered}`);
  console.log('PASS a silent converter trips the watchdog with an actionable message, releases the busy state and the skeletons, and the next import succeeds');

  const failingWorkerSource = `(() => {
    const apply = () => {
      document.documentElement.dataset.conversionWatchdogMs = '60000';
      document.documentElement.dataset.importStallMs = '60000';
    };
    if (document.documentElement) apply();
    else document.addEventListener('DOMContentLoaded', apply, {once: true});
    window.__realWorker = window.Worker;
    window.Worker = class FailingWorker extends EventTarget {
      postMessage() {
        setTimeout(() => this.dispatchEvent(new ErrorEvent('error', {message: 'probe worker crashed', cancelable: true})), 10);
      }
      terminate() {}
    };
  })();`;
  const failScript = await client.send('Page.addScriptToEvaluateOnNewDocument', {source: failingWorkerSource});
  await client.send('Page.navigate', {url: `${baseUrl}?resilience=worker-error`});
  await client.waitFor("document.documentElement.dataset.appReady === 'true'", 15000);
  await client.setFiles('#file-input-a', [fixtures.fragmented]);
  await client.waitFor("!document.querySelector('#error').hidden", 30000);
  const workerError = await client.evaluate("document.querySelector('#error').textContent");
  assert.match(workerError, /probe worker crashed/, `a worker error must reach #error, got ${workerError}`);
  await client.send('Page.removeScriptToEvaluateOnNewDocument', {identifier: failScript.identifier});
  await client.evaluate('window.Worker = window.__realWorker; true');
  await client.setFiles('#file-input-a', [fixtures.effectA]);
  await client.waitFor("document.querySelectorAll('.clip-card').length === 1", 180000);
  console.log(`PASS a worker error event surfaces in #error ("${workerError}") and the next import respawns a fresh worker`);

  const stallSource = `(() => {
    const apply = () => {
      document.documentElement.dataset.conversionWatchdogMs = '60000';
      document.documentElement.dataset.importStallMs = '1200';
    };
    if (document.documentElement) apply();
    else document.addEventListener('DOMContentLoaded', apply, {once: true});
    window.__realWorker = window.Worker;
    window.Worker = class SilentWorker extends EventTarget {
      postMessage() {}
      terminate() {}
    };
  })();`;
  const stallScript = await client.send('Page.addScriptToEvaluateOnNewDocument', {source: stallSource});
  await client.send('Page.navigate', {url: `${baseUrl}?resilience=import-stall`});
  await client.waitFor("document.documentElement.dataset.appReady === 'true'", 15000);
  const before = Date.now();
  await client.setFiles('#file-input-a', [fixtures.fragmented]);
  await client.waitFor("document.querySelector('#status').textContent.startsWith('Import stopped')", 30000);
  const importStall = await client.evaluate(`(() => ({
    status: document.querySelector('#status').textContent,
    error: document.querySelector('#error').textContent,
    loadDisabled: document.querySelector('#load-settings').disabled,
  }))()`);
  const elapsed = Date.now() - before;
  assert.match(importStall.error, /Conversion did not respond/, `import-stall message is ${importStall.error}`);
  assert.equal(importStall.loadDisabled, false, 'the import-level stall must release the busy state too');
  assert.ok(elapsed < 20000, `the import-level watchdog took ${elapsed} ms`);
  await client.send('Page.removeScriptToEvaluateOnNewDocument', {identifier: stallScript.identifier});
  await client.evaluate('window.Worker = window.__realWorker; true');
  await client.setFiles('#file-input-a', [fixtures.effectA]);
  await client.waitFor("document.querySelectorAll('.clip-card').length === 1", 180000);
  console.log(`PASS an import whose pipeline never starts is abandoned after the stall window (${Math.round(elapsed)} ms in the test), reports the same actionable message and stays usable`);

  // ── Memory guard: frame lifecycle across source switches and pagehide ────
  const readPreviewDebug = () => client.evaluate(`(() => {
    const text = document.querySelector('#debug-info').textContent;
    const frames = /live VideoFrames ([0-9]+)/.exec(text);
    const conversions = /conversions this session ([0-9]+)/.exec(text);
    return {
      text,
      frames: frames ? Number(frames[1]) : -1,
      conversions: conversions ? Number(conversions[1]) : -1,
      time: Number.parseFloat(document.querySelector('#preview-time').textContent),
    };
  })()`);
  await client.send('Page.navigate', {url: `${baseUrl}?debug=1&memory=1`});
  await client.waitFor("document.documentElement.dataset.appReady === 'true'", 15000);
  await client.setFiles('#file-input-a', [fixtures.effectA, fixtures.effectB]);
  await client.waitFor("document.querySelectorAll('.clip-card').length === 2", 60000);
  await client.waitFor("!document.querySelector('#assemble-preview').disabled", 180000);
  await client.evaluate("document.querySelector('#assemble-preview').click()");
  await client.evaluate(`(() => {
    const toggle = document.querySelector('#software-preview');
    toggle.checked = true;
    toggle.dispatchEvent(new Event('change', {bubbles: true}));
  })()`);
  await client.waitFor("document.querySelector('#preview-canvas').hidden === false", 20000);
  await new Promise(resolve => setTimeout(resolve, 900));
  const playing = await readPreviewDebug();
  assert.ok(playing.frames > 0, `software preview reported ${playing.frames} live VideoFrames while playing`);
  assert.match(playing.text, /converter\s+workers none spawned|converter\s+workers alive/, 'the diagnostics panel must show the converter workers');
  assert.match(playing.text, /memory\s+live VideoFrames \d+ · conversions this session \d+ · heap /, 'the diagnostics panel must show the memory line');
  assert.ok(playing.conversions >= 0, `conversion counter is ${playing.conversions}`);

  const peaks = [];
  for (let round = 0; round < 4; round += 1) {
    await client.evaluate(`document.querySelectorAll('.clip-card')[${round % 2}].click()`);
    await new Promise(resolve => setTimeout(resolve, 800));
    peaks.push((await readPreviewDebug()).frames);
  }
  const peak = Math.max(...peaks);
  assert.ok(peaks.every(count => count >= 0), `live frame readings were ${JSON.stringify(peaks)}`);
  assert.ok(peak <= 60, `live VideoFrames peaked at ${peak} across four source switches (${JSON.stringify(peaks)}), which means frames from the previous source leak`);
  console.log(`PASS software preview closes the previous source's frames on every switch: live VideoFrames per switch ${JSON.stringify(peaks)}, peak ${peak} <= 60 (lookahead cap 45)`);

  const beforeHide = await readPreviewDebug();
  await client.evaluate("window.dispatchEvent(new PageTransitionEvent('pagehide')); true");
  await new Promise(resolve => setTimeout(resolve, 700));
  const afterHide = await readPreviewDebug();
  assert.equal(afterHide.frames, 0, `pagehide left ${afterHide.frames} decoded frames alive`);
  assert.ok(Math.abs(afterHide.time - beforeHide.time) < 1.2, `playback kept running after pagehide (${beforeHide.time} -> ${afterHide.time})`);
  await new Promise(resolve => setTimeout(resolve, 700));
  const stillHidden = await readPreviewDebug();
  assert.ok(Math.abs(stillHidden.time - afterHide.time) < 0.2, `the clock advanced after pagehide (${afterHide.time} -> ${stillHidden.time})`);
  await client.evaluate("document.querySelector('#preview-canvas').click()");
  await new Promise(resolve => setTimeout(resolve, 900));
  const resumed = await readPreviewDebug();
  assert.ok(resumed.frames > 0, 'the software preview did not resume after pagehide');
  assert.ok(resumed.time < afterHide.time + 1.5 && resumed.time > 0, `the resumed preview did not restart from frame 0 (${afterHide.time} -> ${resumed.time})`);
  console.log(`PASS pagehide releases all ${beforeHide.frames} decoded frames, pauses the clock and the next click replays from frame 0 (${resumed.time.toFixed(2)} s)`);

  // ── Mosh visibility check: auto-switch when the device hides the mosh ────
  const readMoshState = () => client.evaluate(`(() => {
    const text = document.querySelector('#debug-info').textContent;
    const line = /mosh check[^\\n]*/.exec(text);
    const report = document.querySelector('#report').textContent;
    let visibility = null;
    try { visibility = JSON.parse(report).mosh_visibility ?? null; } catch {}
    return {
      line: line ? line[0] : null,
      visibility,
      notice: document.querySelector('#mosh-notice').hidden ? null : document.querySelector('#mosh-notice').textContent,
      toggle: document.querySelector('#software-preview').checked,
      stored: localStorage.getItem('m4shlab-software-preview'),
    };
  })()`);

  // Each case starts without a stored software-preview preference so the
  // automatic switch is the only thing that can turn it on.
  const openMoshCase = async label => {
    await client.evaluate("localStorage.removeItem('m4shlab-software-preview'); true");
    await client.send('Page.navigate', {url: `${baseUrl}?debug=1&mosh=${label}`});
    await client.waitFor("document.documentElement.dataset.appReady === 'true'", 15000);
  };
  await openMoshCase('desktop');
  await client.setFiles('#file-input-a', [fixtures.effectA, fixtures.effectB]);
  await client.waitFor("document.querySelectorAll('.clip-card').length === 2", 60000);
  await client.waitFor("!document.querySelector('#assemble-preview').disabled", 180000);
  await client.evaluate("document.querySelector('#assemble-preview').click()");
  await client.waitFor("(() => { const t = document.querySelector('#debug-info').textContent; return /mosh check(?!   not run yet)/.test(t); })()", 60000);
  await new Promise(resolve => setTimeout(resolve, 600));
  const desktopMosh = await readMoshState();
  assert.ok(desktopMosh.visibility, 'the merge report must carry the mosh_visibility block');
  assert.equal(desktopMosh.visibility.hidden, false, `a desktop-like path must not switch, got ${JSON.stringify(desktopMosh.visibility)}`);
  assert.equal(desktopMosh.notice, null, `no notice expected, got "${desktopMosh.notice}"`);
  assert.equal(desktopMosh.toggle, false, 'software preview must stay off when the mosh is visible');
  assert.match(desktopMosh.line, /repeat [0-9.]+\s+· change [0-9.]+\s+· video-vs-software [0-9.]+\s+· visible/, `debug line is ${desktopMosh.line}`);
  assert.equal(desktopMosh.visibility.repeated_threshold, 2);
  assert.equal(desktopMosh.visibility.change_threshold, 6);
  console.log(`PASS the desktop path keeps <video>: ${desktopMosh.line.trim()} — no notice, software preview stays off, and the MAE record is in the merge report`);

  await openMoshCase('hidden');
  await client.evaluate("window.__m4shlabMoshMeasurement = () => ({repeatMae: 0.4, changeMae: 21, pathMae: 16}); true");
  await client.setFiles('#file-input-a', [fixtures.effectA, fixtures.effectB]);
  await client.waitFor("document.querySelectorAll('.clip-card').length === 2", 60000);
  await client.waitFor("!document.querySelector('#assemble-preview').disabled", 180000);
  await client.waitFor("document.querySelector('#software-preview').checked === true", 60000);
  const hiddenMosh = await readMoshState();
  assert.equal(hiddenMosh.notice, 'Device decoder hides the mosh — software preview enabled.', `notice is ${hiddenMosh.notice}`);
  assert.equal(hiddenMosh.toggle, true, 'the toggle must be on after an automatic switch');
  assert.equal(hiddenMosh.stored, 'true', 'the automatic switch must be persisted');
  assert.equal(hiddenMosh.visibility.hidden, true, 'the report must record the hidden decision');
  assert.equal(hiddenMosh.visibility.decision, 'video-repeats-frame-before-boundary');
  assert.equal(hiddenMosh.visibility.sample_before, null, 'injected measurements carry no sample indexes');
  await new Promise(resolve => setTimeout(resolve, 1200));
  const cached = await readMoshState();
  assert.equal(cached.notice, hiddenMosh.notice, 'the cached decision must not re-announce itself');
  console.log(`PASS a <video> that repeats the pre-boundary frame while the stream changes flips software preview on, persists it ("${hiddenMosh.notice}") and the decision is cached`);

  await openMoshCase('unmeasurable');
  await client.evaluate("window.__m4shlabMoshMeasurement = () => { throw new Error('probe decode produced no frames'); }; true");
  await client.setFiles('#file-input-a', [fixtures.effectA, fixtures.effectB]);
  await client.waitFor("document.querySelectorAll('.clip-card').length === 2", 60000);
  await client.waitFor("!document.querySelector('#assemble-preview').disabled", 180000);
  await client.waitFor("(() => /unmeasurable/.test(document.querySelector('#debug-info').textContent))()", 60000);
  const unmeasurable = await readMoshState();
  assert.equal(unmeasurable.notice, null, `an unmeasurable check must stay silent, got "${unmeasurable.notice}"`);
  assert.equal(unmeasurable.toggle, false, 'an unmeasurable check must not switch the preview');
  assert.match(unmeasurable.line, /unmeasurable: probe decode produced no frames/, `debug line is ${unmeasurable.line}`);
  console.log(`PASS an unmeasurable check leaves <video> in charge, shows no notice and logs "${unmeasurable.line.trim()}" only in ?debug=1`);

  // ── Coarse-pointer default and the SW marker ─────────────────────────────
  await client.send('Emulation.setTouchEmulationEnabled', {enabled: true, maxTouchPoints: 5});
  await client.send('Emulation.setDeviceMetricsOverride', {width: 390, height: 844, deviceScaleFactor: 1, mobile: true});
  await client.evaluate("localStorage.removeItem('m4shlab-software-preview'); true");
  await client.send('Page.navigate', {url: `${baseUrl}?debug=1&mobile-default=1`});
  await client.waitFor("document.documentElement.dataset.appReady === 'true'", 15000);
  const mobileDefault = await client.evaluate(`(() => ({
    coarse: matchMedia('(pointer: coarse)').matches,
    toggle: document.querySelector('#software-preview').checked,
    stored: localStorage.getItem('m4shlab-software-preview'),
    markerHidden: document.querySelector('#software-marker').hidden,
  }))()`);
  assert.equal(mobileDefault.coarse, true, 'touch emulation must report a coarse pointer');
  assert.equal(mobileDefault.toggle, true, 'a coarse-pointer first launch must default software preview on');
  assert.equal(mobileDefault.stored, 'true', 'the coarse-pointer default must be persisted');
  assert.equal(mobileDefault.markerHidden, true, 'the SW marker must stay hidden until the canvas actually runs');
  console.log('PASS a coarse-pointer first launch defaults software preview on and persists that choice, while the SW marker waits for the canvas');

  await client.setFiles('#file-input-a', [fixtures.effectA, fixtures.effectB]);
  await client.waitFor("document.querySelectorAll('.clip-card').length === 2", 60000);
  await client.waitFor("!document.querySelector('#assemble-preview').disabled", 180000);
  await client.evaluate("document.querySelector('#assemble-preview').click()");
  await client.waitFor("document.querySelector('#preview-canvas').hidden === false", 20000);
  await client.waitFor("document.querySelector('#software-marker').hidden === false", 20000);
  const markerOn = await client.evaluate("document.querySelector('#software-marker').textContent");
  await client.evaluate(`(() => {
    const toggle = document.querySelector('#software-preview');
    toggle.checked = false;
    toggle.dispatchEvent(new Event('change', {bubbles: true}));
  })()`);
  await new Promise(resolve => setTimeout(resolve, 300));
  const markerOff = await client.evaluate("document.querySelector('#software-marker').hidden");
  assert.equal(markerOn.trim(), 'SW');
  assert.equal(markerOff, true, 'the SW marker must disappear when software preview is switched off');
  console.log('PASS the "SW" marker appears next to the toggle only while the software canvas is drawing the preview');
  await client.send('Emulation.setTouchEmulationEnabled', {enabled: false, maxTouchPoints: 1});
  await client.send('Emulation.setDeviceMetricsOverride', {width: 1200, height: 900, deviceScaleFactor: 1, mobile: false});

  if (client.exceptions.length) throw new Error(`Browser exceptions:\n${client.exceptions.join('\n')}`);
} finally {
  printSummary();
  client?.close();
  chrome?.process.kill('SIGTERM');
  server.kill('SIGTERM');
  await new Promise(resolveWait => setTimeout(resolveWait, 300));
  if (chrome?.profile) {
    try {
      rmSync(chrome.profile, {recursive: true, force: true, maxRetries: 5, retryDelay: 100});
    } catch {}
  }
  try {
    rmSync(downloadDir, {recursive: true, force: true, maxRetries: 5, retryDelay: 100});
  } catch {}
}
