import assert from 'node:assert/strict';
import {existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawn, spawnSync} from 'node:child_process';
import {CdpClient, closeDialog, launchChrome, pageTarget} from './helpers/cdp-harness.mjs';

const projectRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const port = Number(process.env.ACCEPTANCE_TEST_PORT || 4187);
const baseUrl = `http://127.0.0.1:${port}/`;
const checklistPath = join(projectRoot, 'docs', 'release', 'v1.2-checklist.md');
const evidencePath = join(projectRoot, 'docs', 'release', 'v1.2-acceptance-automated.md');
const downloadDir = join(tmpdir(), 'm4shlab-acceptance-downloads');
const fixtures = {
  audioA: join(projectRoot, 'testmedia', 'synthetic-audio-a.mp4'),
  audioB: join(projectRoot, 'testmedia', 'synthetic-audio-b.mp4'),
  speed: join(projectRoot, 'testmedia', 'synthetic-speed-60.mp4'),
  silentB: join(projectRoot, 'testmedia', 'synthetic-audio-silent-b.mp4'),
};
const hasFfprobe = spawnSync('ffprobe', ['-version'], {encoding: 'utf8'}).status === 0;
const hasFfmpeg = spawnSync('ffmpeg', ['-version'], {encoding: 'utf8'}).status === 0;
let server = null;
let chrome = null;
let client = null;

function parseChecklist() {
  const source = readFileSync(checklistPath, 'utf8');
  const rows = [...source.matchAll(/^\|\s*(\d+)\s*\|\s*([^|]+?)\s*\|/gm)]
    .map(match => ({number: Number(match[1]), title: match[2].trim()}));
  assert.equal(rows.length, 22, `expected 22 checklist rows, parsed ${rows.length}`);
  assert.deepEqual(rows.map(row => row.number), Array.from({length: 22}, (_, index) => index + 1));
  return rows;
}

class Unverifiable extends Error {}

function command(program, args, label) {
  if (!hasFfprobe || !hasFfmpeg) throw new Unverifiable(`${program} is missing; export verification cannot run`);
  const result = spawnSync(program, args, {cwd: projectRoot, encoding: 'utf8'});
  if (result.error) throw new Unverifiable(`${program} could not start: ${result.error.message}`);
  if (result.status !== 0) throw new Error(`${label} failed (${result.status}): ${result.stderr || result.stdout}`);
  return result;
}

async function waitForFile(path, timeout = 60000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (existsSync(path)) {
      const size = readFileSync(path).byteLength;
      if (size > 0) return size;
    }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(`download did not appear: ${path}`);
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

const results = new Map();
function setResult(row, mode, result, evidence) {
  results.set(row, {mode, result, evidence: String(evidence).replace(/\s+/g, ' ').trim()});
}
function pass(row, mode, evidence) { setResult(row, mode, 'PASS', evidence); }
function fail(row, mode, evidence) { setResult(row, mode, 'FAIL', evidence); }
function unverifiable(row, mode, reason) { setResult(row, mode, 'UNVERIFIABLE', reason); }
async function check(row, mode, fn) {
  try {
    pass(row, mode, await fn());
  } catch (error) {
    if (error instanceof Unverifiable) unverifiable(row, mode, error.message);
    else fail(row, mode, error instanceof Error ? error.message : String(error));
  }
}

async function navigate(path = '') {
  await client.send('Page.navigate', {url: `${baseUrl}${path}`});
  await client.waitFor("document.documentElement.dataset.appReady === 'true'", 15000);
  const error = await client.evaluate("document.querySelector('#error')?.hidden === false ? document.querySelector('#error').textContent : null");
  assert.equal(error, null, error ?? 'page reported an error');
}

async function importFiles(paths, expected = paths.length) {
  await client.setFiles('#file-input-a', paths);
  await client.waitFor(`document.querySelectorAll('.clip-card:not(.clip-skeleton)').length === ${expected}`, 60000);
  if (expected > 1) {
    await client.waitFor(`(() => {
      try { return JSON.parse(document.querySelector('#report').textContent).stage === 'merged'; }
      catch { return false; }
    })()`, 180000);
  } else {
    await client.waitFor("document.querySelector('#status').textContent.includes('clip A')", 60000);
  }
  const error = await client.evaluate("document.querySelector('#error').hidden ? null : document.querySelector('#error').textContent");
  assert.equal(error, null, error ?? 'import failed');
}

async function exportFile(name) {
  const path = join(downloadDir, name);
  const downloaded = join(downloadDir, 'm4shlab-merge.mp4');
  rmSync(path, {force: true});
  rmSync(downloaded, {force: true});
  await client.evaluate("document.querySelector('#export-button').click()");
  await waitForFile(downloaded, 90000);
  renameSync(downloaded, path);
  return path;
}

function probe(file) {
  return JSON.parse(command('ffprobe', [
    '-v', 'error', '-show_entries', 'stream=codec_type,codec_name:format=duration',
    '-of', 'json', file,
  ], `ffprobe ${file}`).stdout);
}

function decodeFile(file) {
  command('ffmpeg', ['-v', 'error', '-i', file, '-f', 'null', '-'], `strict decode ${file}`);
}

async function setSound(checked) {
  await client.evaluate(`(() => {
    const input = document.querySelector('#sound-toggle');
    input.checked = ${checked};
    input.dispatchEvent(new Event('change', {bubbles: true}));
  })()`);
  await client.waitFor(`(() => {
    try {
      const report = JSON.parse(document.querySelector('#report').textContent);
      return report.stage === 'merged' && report.audio === ${checked} && report.merge.audio.included === ${checked};
    } catch { return false; }
  })()`, 180000);
}

async function clickAt(selector) {
  const box = await client.evaluate(`(() => {
    const element = document.querySelector(${JSON.stringify(selector)});
    if (!element) return null;
    element.scrollIntoView({block: 'center'});
    const rect = element.getBoundingClientRect();
    return {x: rect.left + rect.width / 2, y: rect.top + rect.height / 2};
  })()`);
  if (!box) throw new Unverifiable(`element ${selector} is missing`);
  await client.send('Input.dispatchMouseEvent', {type: 'mouseMoved', x: box.x, y: box.y, button: 'none'});
  await client.send('Input.dispatchMouseEvent', {type: 'mousePressed', x: box.x, y: box.y, button: 'left', clickCount: 1});
  await client.send('Input.dispatchMouseEvent', {type: 'mouseReleased', x: box.x, y: box.y, button: 'left', clickCount: 1});
}

async function openTransition(row = 0) {
  const count = await client.evaluate("document.querySelectorAll('.connector').length");
  if (count <= row) throw new Unverifiable(`connector ${row} is missing`);
  await client.evaluate(`document.querySelectorAll('.connector')[${row}].click()`);
  await client.waitFor("document.querySelector('#transition-dialog').open === true", 5000);
}

async function closeTransition() {
  await closeDialog(client, '#transition-dialog');
}

async function openTrim(row = 0) {
  const count = await client.evaluate("document.querySelectorAll('.clip-trim-button').length");
  if (count <= row) throw new Unverifiable(`trim button ${row} is missing`);
  await client.evaluate(`document.querySelectorAll('.clip-trim-button')[${row}].click()`);
  await client.waitFor("document.querySelector('#trim-dialog').open === true", 5000);
}

async function closeTrim() {
  await closeDialog(client, '#trim-dialog');
}

async function waitForMerged() {
  await client.waitFor(`(() => {
    try { return JSON.parse(document.querySelector('#report').textContent).stage === 'merged'; }
    catch { return false; }
  })()`, 180000);
  const error = await client.evaluate("document.querySelector('#error').hidden ? null : document.querySelector('#error').textContent");
  assert.equal(error, null, error ?? 'merge failed');
}

async function waitForTrimStart(frame) {
  await client.waitFor(`(() => {
    try { return JSON.parse(document.querySelector('#report').textContent).sources?.clips?.[0]?.start_frame === ${frame}; }
    catch { return false; }
  })()`, 180000);
  const error = await client.evaluate("document.querySelector('#error').hidden ? null : document.querySelector('#error').textContent");
  assert.equal(error, null, error ?? 'trim merge failed');
}

const started = Date.now();
const rows = parseChecklist();
mkdirSync(downloadDir, {recursive: true});
server = spawn(process.execPath, ['scripts/serve.mjs'], {
  cwd: projectRoot,
  env: {...process.env, PORT: String(port)},
  stdio: 'ignore',
});
chrome = await launchChrome('m4shlab-acceptance-');
if (!chrome) {
  console.log('SKIP acceptance: Chrome/Chromium was not found. Set CHROME_BIN to run this test.');
  server.kill('SIGTERM');
  process.exit(0);
}

try {
  client = await pageTarget(chrome.endpoint);
  await client.send('Page.enable');
  await client.send('Runtime.enable');
  await client.send('DOM.enable');
  await client.send('Browser.setDownloadBehavior', {behavior: 'allow', downloadPath: downloadDir, eventsEnabled: true});
  await client.send('Emulation.setDeviceMetricsOverride', {width: 1200, height: 800, deviceScaleFactor: 1, mobile: false});
  await client.send('Emulation.setTouchEmulationEnabled', {enabled: false, maxTouchPoints: 1});
  await navigate('?acceptance=desktop');
  await importFiles([fixtures.audioA, fixtures.audioB]);

  await check(1, 'desktop', async () => {
    const state = await client.evaluate(`(() => {
      const viewer = document.querySelector('.viewer');
      const style = getComputedStyle(viewer);
      const active = [];
      const collect = (rules, media) => {
        for (const rule of rules) {
          if (!rule.selectorText && rule.cssRules) {
            collect(rule.cssRules, rule.conditionText || media);
            continue;
          }
          if (!rule.selectorText || !rule.style) continue;
          if (!rule.selectorText.split(',').some(part => part.trim() === '.viewer')) continue;
          if (media && !matchMedia(media).matches) continue;
          if (rule.style.height || rule.style.maxHeight) active.push({media, height: rule.style.height, maxHeight: rule.style.maxHeight});
        }
      };
      for (const sheet of document.styleSheets) {
        try { collect(sheet.cssRules, ''); } catch {}
      }
      return {height: viewer.getBoundingClientRect().height, computedHeight: style.height, maxHeight: style.maxHeight, active};
    })()`);
    assert.ok(Math.abs(state.height - 380) < 0.6, `viewer height ${state.height}px, expected 380px`);
    assert.ok(state.active.some(rule => rule.height === '380px'), 'the 380px .viewer rule is not active');
    assert.ok(state.active.some(rule => rule.maxHeight === '50vh'), 'the 50vh max-height rule is not active');
    assert.equal(state.maxHeight, `${800 * 0.5}px`);
    return `height ${state.height}px = min(50vh=${800 * 0.5}px, 380px); active rules ${JSON.stringify(state.active)}`;
  });

  let soundOffFile = null;
  let soundOnFile = null;
  await check(2, 'desktop', async () => {
    if (!hasFfprobe) throw new Unverifiable('ffprobe is missing; exported audio cannot be verified');
    await setSound(false);
    const mutedOff = await client.evaluate("document.querySelector('#preview-video').muted");
    soundOffFile = await exportFile('acceptance-sound-off.mp4');
    const offProbe = probe(soundOffFile);
    assert.equal(mutedOff, true, 'preview was not muted with Sound off');
    assert.equal(offProbe.streams.some(stream => stream.codec_type === 'audio'), false, 'Sound-off export still has an audio stream');
    assert.equal(offProbe.streams.some(stream => stream.codec_type === 'video'), true, 'Sound-off export has no video stream');
    await setSound(true);
    const mutedOn = await client.evaluate("document.querySelector('#preview-video').muted");
    soundOnFile = await exportFile('acceptance-sound-on.mp4');
    const onProbe = probe(soundOnFile);
    assert.equal(mutedOn, false, 'preview stayed muted with Sound on');
    assert.equal(onProbe.streams.some(stream => stream.codec_type === 'audio'), true, 'Sound-on export has no audio stream');
    return `off: muted=${mutedOff}, no audio stream; on: muted=${mutedOn}, audio stream present (${offProbe.streams.length} off streams, ${onProbe.streams.length} on streams)`;
  });

  await check(3, 'desktop', async () => {
    await client.evaluate("document.querySelectorAll('.clip-card')[0].click()");
    await client.waitFor("document.querySelector('#preview-video').readyState >= 1", 15000);
    const before = await client.evaluate("document.querySelector('#preview-time').textContent");
    assert.match(before, /^\d+\.\d{2} \/ \d+\.\d{2} s$/);
    await client.evaluate("(() => { const video = document.querySelector('#preview-video'); video.muted = true; return video.play().catch(() => false); })()");
    await sleep(700);
    const advanced = await client.evaluate(`({
      text: document.querySelector('#preview-time').textContent,
      currentTime: document.querySelector('#preview-video').currentTime,
    })`);
    assert.ok(advanced.currentTime > 0, 'currentTime did not advance after play');
    const beforeCurrent = Number(before.split(' / ')[0]);
    const afterCurrent = Number(advanced.text.split(' / ')[0]);
    assert.ok(afterCurrent > beforeCurrent, `time readout did not advance: ${before} -> ${advanced.text}`);
    await client.evaluate("document.querySelectorAll('.clip-card')[1].click()");
    await sleep(300);
    const reset = await client.evaluate("document.querySelector('#preview-time').textContent");
    assert.match(reset, /^0\.00 \/ \d+\.\d{2} s$/);
    await client.evaluate("(() => { const video = document.querySelector('#preview-video'); video.pause(); video.muted = false; })()");
    return `${before} -> ${advanced.text}; source change reset to ${reset}`;
  });

  await check(4, 'desktop', async () => {
    if (!hasFfprobe || !hasFfmpeg) throw new Unverifiable('ffprobe/ffmpeg is missing; export verification cannot run');
    assert.ok(soundOnFile, 'the Sound-on export from row 2 is missing');
    const bytes = readFileSync(soundOnFile).byteLength;
    assert.ok(bytes > 0, 'export is empty');
    const report = await client.evaluate("JSON.parse(document.querySelector('#report').textContent)");
    const probeJson = probe(soundOnFile);
    const video = probeJson.streams.find(stream => stream.codec_type === 'video');
    const audio = probeJson.streams.find(stream => stream.codec_type === 'audio');
    assert.equal(video?.codec_name, 'h264', `video codec is ${video?.codec_name}`);
    assert.ok(audio, 'Sound-on export has no audio stream');
    const duration = Number(probeJson.format?.duration);
    assert.ok(Number.isFinite(duration), 'ffprobe did not report a duration');
    assert.ok(Math.abs(duration - report.merge.mergedDurationSeconds) <= 1 / 30,
      `export duration ${duration}s differs from report ${report.merge.mergedDurationSeconds}s by more than one frame`);
    decodeFile(soundOnFile);
    return `${bytes} B, H.264 + ${audio.codec_name}, duration ${duration.toFixed(3)}s vs report ${report.merge.mergedDurationSeconds.toFixed(3)}s, strict decode passed`;
  });

  await check(9, 'desktop', async () => {
    const state = await client.evaluate(`(() => {
      const details = document.querySelector('#bitstream-report');
      details.open = true;
      const report = JSON.parse(document.querySelector('#report').textContent);
      const pre = document.querySelector('#bitstream-report-json');
      const connectors = [...document.querySelectorAll('.connector')].map(node => node.textContent);
      return {
        stage: report.stage,
        transitions: report.transitions,
        connectors,
        preScrolls: pre.scrollHeight > pre.clientHeight,
        preClientHeight: pre.clientHeight,
        preScrollHeight: pre.scrollHeight,
      };
    })()`);
    assert.equal(state.stage, 'merged');
    assert.equal(state.transitions.length, state.connectors.length);
    assert.equal(state.transitions.length, 1);
    const connectorSeconds = Number(/([0-9]+\.[0-9]{2}) s/.exec(state.connectors[0])?.[1]);
    assert.ok(Number.isFinite(connectorSeconds), `connector duration missing: ${state.connectors[0]}`);
    assert.ok(Math.abs(connectorSeconds - state.transitions[0].durationSeconds) < 0.001,
      `connector ${connectorSeconds}s vs report ${state.transitions[0].durationSeconds}s`);
    assert.equal(state.preScrolls, true, 'bitstream <pre> does not scroll');
    await client.evaluate("document.querySelector('#bitstream-report').open = false");
    return `JSON parseable; ${state.transitions.length} transition at ${connectorSeconds.toFixed(2)}s matches connector; pre ${state.preScrollHeight}px > ${state.preClientHeight}px`;
  });

  await navigate('?acceptance-sliders=1');
  await importFiles([fixtures.speed, fixtures.silentB]);

  await check(5, 'desktop', async () => {
    const speedState = await client.evaluate(`(async () => {
      const range = document.querySelector('.clip-card .clip-speed input[type="range"]');
      range.value = '1.1';
      range.dispatchEvent(new Event('input', {bubbles: true}));
      range.dispatchEvent(new Event('change', {bubbles: true}));
      await new Promise(resolve => setTimeout(resolve, 100));
      return {output: document.querySelector('.clip-card .clip-speed output')?.textContent};
    })()`);
    assert.match(speedState.output ?? '', /^1\.1×$/);
    await client.waitFor(`(() => {
      try {
        const report = JSON.parse(document.querySelector('#report').textContent);
        return report.stage === 'merged' && report.sources?.clips?.[0]?.speed === 1.1;
      } catch { return false; }
    })()`, 180000);
    await openTransition(0);
    const controls = await client.evaluate(`(() => {
      const method = document.querySelector('#transition-method');
      const duration = document.querySelector('#transition-duration');
      const repeat = document.querySelector('#effect-parameter');
      method.value = 'melt'; method.dispatchEvent(new Event('change', {bubbles: true}));
      duration.value = '12'; duration.dispatchEvent(new Event('input', {bubbles: true}));
      repeat.value = '5'; repeat.dispatchEvent(new Event('input', {bubbles: true}));
      const melt = {
        duration: document.querySelector('#transition-duration-value').textContent,
        repeat: document.querySelector('#effect-parameter-value').textContent,
      };
      method.value = 'loop'; method.dispatchEvent(new Event('change', {bubbles: true}));
      const loop = {
        label: document.querySelector('#effect-parameter-label').textContent,
        value: document.querySelector('#effect-parameter-value').textContent,
      };
      method.value = 'reset-pulse'; method.dispatchEvent(new Event('change', {bubbles: true}));
      const reset = {
        interval: document.querySelector('#reset-interval-value').textContent,
        repeat: document.querySelector('#reset-repeat-value').textContent,
      };
      method.value = 'classic-mosh'; method.dispatchEvent(new Event('change', {bubbles: true}));
      duration.value = '12'; duration.dispatchEvent(new Event('input', {bubbles: true}));
      return {melt, loop, reset};
    })()`);
    assert.match(controls.melt.duration, /12 frames/);
    assert.match(controls.melt.repeat, /5×/);
    assert.equal(controls.loop.label, 'loop frames');
    assert.match(controls.reset.interval, /\d+ frames/);
    assert.match(controls.reset.repeat, /\d+×/);
    await client.evaluate("document.querySelector('#transition-apply').click()");
    await client.waitFor(`(() => {
      try {
        const report = JSON.parse(document.querySelector('#report').textContent);
        return report.stage === 'merged' && report.transitions?.[0]?.method === 'classic-mosh' && report.transitions[0].durationFrames === 12;
      } catch { return false; }
    })()`, 180000);
    const classicConnector = await client.evaluate("document.querySelector('.connector').innerText");
    assert.match(classicConnector, /m4sh\s+0\.40 s · restore/);

    await openTransition(0);
    await client.evaluate(`(() => {
      const method = document.querySelector('#transition-method');
      method.value = 'loop'; method.dispatchEvent(new Event('change', {bubbles: true}));
      const group = document.querySelector('#effect-parameter');
      group.value = '4'; group.dispatchEvent(new Event('input', {bubbles: true}));
      document.querySelector('#transition-apply').click();
    })()`);
    await client.waitFor(`(() => {
      try { return JSON.parse(document.querySelector('#report').textContent).transitions?.[0]?.method === 'loop'; }
      catch { return false; }
    })()`, 180000);
    const loopConnector = await client.evaluate("document.querySelector('.connector').innerText");
    assert.match(loopConnector, /Loop Release\s+0\.40 s · 4f/);

    await openTransition(0);
    await client.evaluate(`(() => {
      const method = document.querySelector('#transition-method');
      method.value = 'reset-pulse'; method.dispatchEvent(new Event('change', {bubbles: true}));
      const interval = document.querySelector('#reset-interval');
      interval.value = '6'; interval.dispatchEvent(new Event('input', {bubbles: true}));
      const repeat = document.querySelector('#reset-repeat');
      repeat.value = '2'; repeat.dispatchEvent(new Event('input', {bubbles: true}));
      document.querySelector('#transition-apply').click();
    })()`);
    await client.waitFor(`(() => {
      try { return JSON.parse(document.querySelector('#report').textContent).transitions?.[0]?.method === 'reset-pulse'; }
      catch { return false; }
    })()`, 180000);
    const resetConnector = await client.evaluate("document.querySelector('.connector').innerText");
    assert.match(resetConnector, /Reset Pulse\s+0\.40 s · 6f \/ 2×/);
    return `speed ${speedState.output}; Melt ${controls.melt.duration}, repeat ${controls.melt.repeat}; Loop ${controls.loop.label}; Reset ${controls.reset.interval}/${controls.reset.repeat}; connectors "${classicConnector}", "${loopConnector}", "${resetConnector}"`;
  });

  await check(7, 'desktop', async () => {
    const snapshot = await client.evaluate(`JSON.stringify({
      cards: [...document.querySelectorAll('.clip-card')].map(card => card.dataset.clipId),
      connectors: [...document.querySelectorAll('.connector')].map(node => node.textContent),
      sequence: document.querySelector('#sequence-label').textContent,
    })`);
    const viewport = await client.evaluate("({width: innerWidth, height: innerHeight})");
    await openTransition(0);
    const transitionBox = await client.evaluate(`(() => {
      const box = document.querySelector('#transition-dialog').getBoundingClientRect();
      return {left: box.left, top: box.top, right: box.right, bottom: box.bottom};
    })()`);
    assert.ok(transitionBox.left >= 0 && transitionBox.top >= 0 && transitionBox.right <= viewport.width && transitionBox.bottom <= viewport.height,
      `transition dialog outside viewport: ${JSON.stringify(transitionBox)}`);
    await closeTransition();
    await openTrim(0);
    const trimBox = await client.evaluate(`(() => {
      const box = document.querySelector('#trim-dialog').getBoundingClientRect();
      return {left: box.left, top: box.top, right: box.right, bottom: box.bottom};
    })()`);
    assert.ok(trimBox.left >= 0 && trimBox.top >= 0 && trimBox.right <= viewport.width && trimBox.bottom <= viewport.height,
      `trim dialog outside viewport: ${JSON.stringify(trimBox)}`);
    await closeTrim();
    const after = await client.evaluate(`JSON.stringify({
      cards: [...document.querySelectorAll('.clip-card')].map(card => card.dataset.clipId),
      connectors: [...document.querySelectorAll('.connector')].map(node => node.textContent),
      sequence: document.querySelector('#sequence-label').textContent,
    })`);
    assert.equal(after, snapshot, 'closing dialogs changed the timeline');
    return `transition ${Math.round(transitionBox.right - transitionBox.left)}×${Math.round(transitionBox.bottom - transitionBox.top)} and trim ${Math.round(trimBox.right - trimBox.left)}×${Math.round(trimBox.bottom - trimBox.top)} fit ${viewport.width}×${viewport.height}; timeline unchanged`;
  });

  await check(10, 'desktop', async () => {
    await openTransition(0);
    const cursors = await client.evaluate(`(() => {
      const selectors = ['#preview-video', '.clip-speed input[type="range"]', '#export-button', '#transition-apply'];
      return Object.fromEntries(selectors.map(selector => [selector, getComputedStyle(document.querySelector(selector)).cursor]));
    })()`);
    for (const [selector, cursor] of Object.entries(cursors)) assert.match(cursor, /m4-cursor/, `${selector} cursor is ${cursor}`);
    await closeTransition();
    const box = await client.evaluate(`(() => {
      const element = document.querySelector('#bitstream-report summary');
      element.scrollIntoView({block: 'center'});
      const rect = element.getBoundingClientRect();
      return {x: rect.left + rect.width / 2, y: rect.top + rect.height / 2};
    })()`);
    await client.send('Input.dispatchMouseEvent', {type: 'mouseMoved', x: box.x, y: box.y, button: 'none'});
    await client.send('Input.dispatchMouseEvent', {type: 'mousePressed', x: box.x, y: box.y, button: 'left', clickCount: 1});
    await sleep(100);
    const pressed = await client.evaluate("getComputedStyle(document.querySelector('#bitstream-report summary')).cursor");
    await client.send('Input.dispatchMouseEvent', {type: 'mouseReleased', x: box.x, y: box.y, button: 'left', clickCount: 1});
    assert.match(pressed, /m4-cursor-pressed\.svg/, `pressed cursor is ${pressed}`);
    return `player/slider/button/dialog cursors use m4-cursor; pointerdown uses ${pressed.match(/m4-cursor-pressed\.svg/)?.[0]}`;
  });

  await check(11, 'manual-only', async () => {
    const cursors = await client.evaluate(`(() => ({
      video: getComputedStyle(document.querySelector('#preview-video')).cursor,
      select: getComputedStyle(document.querySelector('.clip-look select')).cursor,
    }))()`);
    throw new Unverifiable(`native video-control overlay and open select popup are browser/OS surfaces and cannot be inspected with CDP; host elements compute to ${cursors.video.includes('url(') ? 'custom' : 'system'} (video) and ${cursors.select.includes('url(') ? 'custom' : 'system'} (select), so this row needs a human check`);
  });

  await check(8, 'desktop', async () => {
    const settingsFile = join(downloadDir, 'Acceptance.m4settings');
    rmSync(settingsFile, {force: true});
    await client.evaluate(`(() => {
      document.querySelector('#project-menu').open = true;
      const input = document.querySelector('#project-name');
      input.value = 'Acceptance';
      input.dispatchEvent(new Event('input', {bubbles: true}));
    })()`);
    await sleep(500);
    const stored = await client.evaluate("localStorage.getItem('m4shlab-project')");
    assert.equal(stored, 'Acceptance');
    await client.evaluate("document.querySelector('#save-settings').click()");
    await waitForFile(settingsFile, 15000);
    const loadEnabled = await client.evaluate("document.querySelector('#load-settings').disabled === false");
    assert.equal(loadEnabled, true);
    await client.send('Page.navigate', {url: `${baseUrl}?acceptance-project-reload=1`});
    await client.waitFor("document.documentElement.dataset.appReady === 'true'", 15000);
    const restored = await client.evaluate("document.querySelector('#project-name').value");
    assert.equal(restored, 'Acceptance');
    await client.evaluate(`(() => {
      const input = document.querySelector('#project-name');
      input.value = 'Project';
      input.dispatchEvent(new Event('input', {bubbles: true}));
    })()`);
    await sleep(300);
    return `project name persisted through reload; ${readFileSync(settingsFile).byteLength} B settings download; Load enabled=${loadEnabled}`;
  });

  await check(6, 'desktop', async () => {
    await navigate('?acceptance-trim-seconds=1');
    await importFiles([fixtures.speed], 1);
    await openTrim(0);
    const state = await client.evaluate(`(async () => {
      const seconds = document.querySelector('#trim-end-seconds');
      const frames = document.querySelector('#trim-end');
      seconds.value = '1.5';
      seconds.dispatchEvent(new Event('input', {bubbles: true}));
      const first = {seconds: seconds.value, frames: frames.value};
      const roundTrips = [];
      for (const frame of [10, 20, 30, 40, 45]) {
        frames.value = String(frame);
        frames.dispatchEvent(new Event('input', {bubbles: true}));
        const mappedSeconds = seconds.value;
        seconds.value = mappedSeconds;
        seconds.dispatchEvent(new Event('input', {bubbles: true}));
        roundTrips.push({frame, mappedSeconds, returnedFrame: frames.value});
      }
      return {first, roundTrips, readout: document.querySelector('#trim-readout').textContent};
    })()`);
    assert.equal(state.first.frames, '45');
    for (const trip of state.roundTrips) {
      assert.equal(trip.returnedFrame, String(trip.frame), `frame ${trip.frame} drifted to ${trip.returnedFrame} via ${trip.mappedSeconds}s`);
    }
    await closeTrim();
    return `1.5s -> frame 45; ${state.roundTrips.length} frame/seconds round-trips without drift (${state.roundTrips.map(item => item.frame).join(',')})`;
  });

  await client.send('Emulation.setTouchEmulationEnabled', {enabled: true, maxTouchPoints: 5});
  await client.send('Emulation.setDeviceMetricsOverride', {width: 390, height: 844, deviceScaleFactor: 3, mobile: true});
  await navigate('?acceptance=mobile');
  await importFiles([fixtures.speed, fixtures.silentB], 2);

  await check(12, 'mobile-emulation', async () => {
    const before = await client.evaluate("document.querySelector('#preview-video').currentTime");
    await clickAt('#preview-video');
    await sleep(800);
    const after = await client.evaluate(`({
      currentTime: document.querySelector('#preview-video').currentTime,
      paused: document.querySelector('#preview-video').paused,
      duration: document.querySelector('#preview-video').duration,
    })`);
    assert.ok(after.currentTime > before, `currentTime did not advance after one click: ${before} -> ${after.currentTime}`);
    return `one click advanced currentTime ${before.toFixed(2)} -> ${after.currentTime.toFixed(2)}s (paused=${after.paused})`;
  });

  await check(13, 'mobile-emulation', async () => {
    const state = await client.evaluate(`(async () => {
      const timeline = document.querySelector('#source-tiers');
      const before = {scrollWidth: timeline.scrollWidth, clientWidth: timeline.clientWidth, scrollLeft: timeline.scrollLeft, pageY: window.scrollY};
      timeline.scrollLeft = 0;
      timeline.scrollBy({left: 120, behavior: 'instant'});
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      const after = {scrollLeft: timeline.scrollLeft, pageY: window.scrollY};
      window.scrollTo(0, 120);
      const pageYAfter = window.scrollY;
      window.scrollTo(0, 0);
      return {
        before, after, pageYAfter,
        overflowX: getComputedStyle(timeline).overflowX,
      };
    })()`);
    assert.ok(state.before.scrollWidth > state.before.clientWidth, `timeline does not overflow: ${state.before.scrollWidth} <= ${state.before.clientWidth}`);
    assert.ok(['auto', 'scroll'].includes(state.overflowX), `timeline overflow-x is ${state.overflowX}`);
    assert.ok(state.after.scrollLeft > 0, 'timeline did not scroll horizontally');
    assert.ok(state.pageYAfter > 0, 'vertical page scroll was locked');
    return `timeline ${state.before.scrollWidth}>${state.before.clientWidth}, overflow-x=${state.overflowX}, scrollLeft ${state.after.scrollLeft}px; page scrollY ${state.pageYAfter}px`;
  });

  await check(14, 'mobile-emulation', async () => {
    const controls = [];
    const collect = async label => {
      const measured = await client.evaluate(`(() => {
        const root = ${JSON.stringify(label)};
        const nodes = [...document.querySelectorAll(root + ' button, ' + root + ' input, ' + root + ' select, ' + root + ' textarea, ' + root + ' summary, ' + root + ' [role="button"], ' + root + ' a[href]')];
        return nodes.filter(node => {
          if (node.disabled) return false;
          const style = getComputedStyle(node);
          const box = node.getBoundingClientRect();
          return style.display !== 'none' && style.visibility !== 'hidden' && box.width > 0 && box.height > 0;
        }).map(node => {
          const box = node.getBoundingClientRect();
          return {tag: node.tagName.toLowerCase(), id: node.id, className: String(node.className || ''), label: node.getAttribute('aria-label') || node.textContent.trim().slice(0, 30), width: box.width, height: box.height};
        });
      })()`);
      controls.push(...measured);
    };
    await collect('#source-tiers');
    await openTransition(0);
    await collect('#transition-dialog');
    await closeTransition();
    await openTrim(0);
    await collect('#trim-dialog');
    await closeTrim();
    assert.ok(controls.length > 0, 'no interactive controls found');
    const small = controls.filter(control => control.width < 44 || control.height < 44);
    if (small.length > 0) {
      const summary = small.map(control => `${control.tag}${control.id ? `#${control.id}` : ''} "${control.label}" ${control.width.toFixed(1)}x${control.height.toFixed(1)}`).join('; ');
      throw new Error(`targets below 44x44: ${summary}`);
    }
    const key = controls.filter(control => control.id === 'transition-method' || /^Close (transition|trim) dialog$/.test(control.label));
    const keyText = key.map(control => `${control.id || control.label} ${control.width.toFixed(1)}x${control.height.toFixed(1)}`).join('; ');
    return `${controls.length} visible enabled controls in timeline and dialogs are >=44x44; ${keyText}; smallest ${Math.min(...controls.map(control => Math.min(control.width, control.height))).toFixed(1)}px`;
  });

  await check(16, 'mobile-emulation', async () => {
    const before = await client.evaluate("document.querySelector('.clip-thumb video').currentSrc || document.querySelector('.clip-thumb video').src");
    await openTrim(0);
    await client.evaluate(`(() => {
      const input = document.querySelector('#trim-start');
      input.value = '10';
      input.dispatchEvent(new Event('input', {bubbles: true}));
      document.querySelector('#trim-apply').click();
    })()`);
    await waitForTrimStart(10);
    const trimmed = await client.evaluate("document.querySelector('.clip-thumb video').currentSrc || document.querySelector('.clip-thumb video').src");
    assert.notEqual(trimmed, before, 'trimmed thumbnail source did not change');
    assert.match(trimmed, /#t=0\.33/, `trimmed thumbnail did not seek to the in-point: ${trimmed}`);
    await openTrim(0);
    await client.evaluate("document.querySelector('#trim-reset').click(); document.querySelector('#trim-apply').click();");
    await waitForTrimStart(0);
    const reset = await client.evaluate("document.querySelector('.clip-thumb video').currentSrc || document.querySelector('.clip-thumb video').src");
    assert.match(reset, /#t=0\.001/, `reset thumbnail did not return to frame 0: ${reset}`);
    return `thumbnail ${before.match(/#t=[0-9.]+/)?.[0] ?? 'untagged'} -> ${trimmed.match(/#t=[0-9.]+/)?.[0]}; Reset -> ${reset.match(/#t=[0-9.]+/)?.[0]}`;
  });

  await check(21, 'mobile-emulation', async () => {
    const states = [];
    const measure = async label => {
      const state = await client.evaluate(`({
        label: ${JSON.stringify(label)},
        scrollWidth: document.documentElement.scrollWidth,
        innerWidth: window.innerWidth,
      })`);
      states.push(state);
      assert.equal(state.scrollWidth, state.innerWidth, `${label} overflows horizontally: ${state.scrollWidth} > ${state.innerWidth}`);
    };
    await measure('initial');
    await openTransition(0);
    await measure('transition dialog open');
    await closeTransition();
    await openTrim(0);
    await measure('trim dialog open');
    await closeTrim();
    await client.evaluate("document.querySelector('#project-menu').open = true");
    await measure('project panel open');
    await client.evaluate("document.querySelector('#project-menu').open = false");
    return states.map(state => `${state.label} ${state.scrollWidth}/${state.innerWidth}`).join(', ');
  });

  unverifiable(15, 'manual-only', 'numeric keypad with decimal point is an OS keyboard surface and cannot be checked in headless Chromium');
  unverifiable(17, 'manual-only', 'a brief stale frame while scrubbing a 30 s+ clip needs a human eye on real decoder hardware; headless timing cannot judge it');
  unverifiable(18, 'manual-only', 'opening a downloaded video from the iOS Files app is an iOS surface and cannot be checked in headless Chromium');
  unverifiable(19, 'manual-only', 'the row requires a full app close and iOS storage persistence; a page reload is not equivalent and this half cannot be automated (page-reload settings round-trip is covered by test:webcodecs)');
  unverifiable(20, 'manual-only', '3–4 minutes of thermal behaviour on a physical device cannot be reproduced in headless Chromium');

  await check(22, 'mobile-emulation', async () => {
    const notice = await client.evaluate("document.querySelector('#shell-notice') === null");
    assert.equal(notice, true, '#shell-notice is present');
    assert.deepEqual(client.exceptions, [], `browser exceptions: ${client.exceptions.join(' | ')}`);
    assert.deepEqual(client.consoleErrors, [], `console errors: ${client.consoleErrors.join(' | ')}`);
    return `#shell-notice absent; ${client.exceptions.length} exceptions and ${client.consoleErrors.length} console errors`;
  });

  for (const row of rows) {
    if (!results.has(row.number)) unverifiable(row.number, 'manual-only', 'no automated check is mapped to this row');
  }

  const ordered = rows.map(row => ({...row, ...results.get(row.number)}));
  const counts = {
    PASS: ordered.filter(row => row.result === 'PASS').length,
    FAIL: ordered.filter(row => row.result === 'FAIL').length,
    UNVERIFIABLE: ordered.filter(row => row.result === 'UNVERIFIABLE').length,
  };
  const manualCount = ordered.filter(row => row.mode === 'manual-only').length;

  for (const row of ordered) {
    console.log(`[row ${row.number}] ${row.result} — ${row.title} — ${row.evidence}`);
  }
  console.log(`PASS ${counts.PASS} / FAIL ${counts.FAIL} / UNVERIFIABLE ${counts.UNVERIFIABLE} of 22`);
  for (const row of ordered.filter(item => item.result === 'UNVERIFIABLE')) {
    console.log(`UNVERIFIABLE [row ${row.number}] ${row.title}: ${row.evidence}`);
  }
  console.log(`Manual rows remaining: ${manualCount} of 22.`);

  const escape = value => String(value).replaceAll('|', '\\|').replaceAll('\n', ' ');
  const modeLabel = {desktop: 'automated', 'mobile-emulation': 'emulated', 'manual-only': 'manual'};
  const markdown = [
    '# m4shlab v1.2 — automated acceptance',
    '',
    `Generated ${new Date().toISOString()} by \`npm run test:acceptance\` in headless Chromium.`,
    `Summary: **PASS ${counts.PASS} / FAIL ${counts.FAIL} / UNVERIFIABLE ${counts.UNVERIFIABLE} of 22**.`,
    'This summary describes that single run on the generation timestamp above, not a property of the tree. A red row must be reproduced before it is treated as an app defect.',
    '',
    '| Row | Check | Mode | Result | Evidence |',
    '| ---: | --- | --- | --- | --- |',
    ...ordered.map(row => `| ${row.number} | ${escape(row.title)} | ${modeLabel[row.mode] ?? row.mode} | ${row.result} | ${escape(row.evidence)} |`),
    '',
    `Manual rows remaining: ${manualCount} of 22.`,
    '',
    'Manual-only rows require the maintainer on a physical device. UNVERIFIABLE is not PASS.',
    '',
    'Mode column: `automated` = checked by this runner on desktop, `emulated` = checked in mobile emulation, `manual` = needs a physical device or a human eye. Manual rows are 11 (native video/select surfaces), 15 (OS keypad), 17 (seeking on a long clip), 18 (iOS Files app), 19 (settings after a full app close) and 20 (thermal behaviour); their Pass/Fail cells stay with the maintainer.',
    '',
  ].join('\n');
  writeFileSync(evidencePath, markdown);
  console.log(`Wrote ${evidencePath}`);
  console.log(`Acceptance completed in ${((Date.now() - started) / 1000).toFixed(1)}s`);
  if (counts.FAIL > 0) process.exitCode = 1;
} finally {
  client?.close();
  chrome?.process.kill('SIGTERM');
  server?.kill('SIGTERM');
  await sleep(250);
  if (chrome?.profile) {
    try { rmSync(chrome.profile, {recursive: true, force: true, maxRetries: 5, retryDelay: 100}); } catch {}
  }
}
