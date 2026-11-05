import assert from 'node:assert/strict';
import {existsSync, readFileSync, rmSync} from 'node:fs';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawn} from 'node:child_process';
import {CdpClient, launchChrome, pageTarget} from './helpers/cdp-harness.mjs';

const projectRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const port = Number(process.env.CURSOR_TEST_PORT || 4185);
const baseUrl = `http://127.0.0.1:${port}/`;
let server = null;
let chrome = null;
let client = null;
const fixture = join(projectRoot, 'testmedia', 'synthetic-multigop-a.mp4');
const cursorDir = join(projectRoot, 'assets', 'cursor');
const cursorFiles = [
  {name: 'm4-cursor.svg', width: 19.7, height: 29.6, png: false},
  {name: 'm4-cursor.png', width: 20, height: 30, png: true},
  {name: 'm4-cursor-interactive.svg', width: 20.88, height: 31.38, png: false},
  {name: 'm4-cursor-interactive.png', width: 21, height: 31, png: true},
  {name: 'm4-cursor-pressed.svg', width: 21.28, height: 31.97, png: false},
  {name: 'm4-cursor-pressed.png', width: 21, height: 32, png: true},
];
const mandatory = {
  header: 'header',
  footer: 'footer',
  player: '#preview-video',
  clipCard: '.clip-card',
  connector: '.connector',
  speedSlider: '.clip-speed input[type="range"]',
  lookSelect: '.clip-look select',
  soundCheckbox: '#sound-toggle',
  soundLabel: '.sound-toggle',
  importLabel: 'header label.button',
  dropZone: '#drop-zone',
  assemble: '#assemble-preview',
  exportButton: '#export-button',
  undo: '#undo-button',
  redo: '#redo-button',
  projectSummary: '#project-menu summary',
  bitstreamSummary: '#bitstream-report summary',
  transitionDialog: '#transition-dialog',
  transitionMethod: '#transition-method',
  transitionDuration: '#transition-duration',
  transitionEnding: '#transition-ending',
  effectParameter: '#effect-parameter',
  resetInterval: '#reset-interval',
  randomize: '#transition-randomize',
  seed: '#transition-seed',
  trimDialog: '#trim-dialog',
};
function pngDimensions(path) {
  const bytes = readFileSync(path);
  assert.equal(bytes.subarray(0, 8).toString('hex'), '89504e470d0a1a0a', `${path} PNG signature`);
  return {width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20)};
}

function svgDimensions(path) {
  const source = readFileSync(path, 'utf8');
  const width = Number(/<svg[^>]*\bwidth="([0-9.]+)"/.exec(source)?.[1]);
  const height = Number(/<svg[^>]*\bheight="([0-9.]+)"/.exec(source)?.[1]);
  return {width, height};
}

const gridScan = `(async () => {
  const step = 24;
  const maxScroll = Math.max(0, document.documentElement.scrollHeight - innerHeight);
  const positions = [0];
  const stride = Math.max(step, Math.floor(innerHeight * 0.75));
  for (let y = stride; y < maxScroll; y += stride) positions.push(y);
  if (maxScroll > 0) positions.push(maxScroll);
  let total = 0;
  let hits = 0;
  const misses = [];
  for (const scroll of positions) {
    window.scrollTo(0, scroll);
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    for (let y = 12; y < innerHeight; y += step) {
      for (let x = 12; x < innerWidth; x += step) {
        const element = document.elementFromPoint(x, y);
        total += 1;
        if (!element) {
          misses.push({x, y, scroll, reason: 'no element'});
          continue;
        }
        const cursor = getComputedStyle(element).cursor;
        if (cursor.includes('url(')) hits += 1;
        else misses.push({x, y, scroll, tag: element.tagName.toLowerCase(), id: element.id,
          className: String(element.className || ''), cursor});
      }
    }
  }
  window.scrollTo(0, 0);
  return {positions: positions.length, total, hits, misses: misses.slice(0, 12)};
})()`;

const probeExpression = selectors => `(() => {
  const selectors = ${JSON.stringify(selectors)};
  const result = {};
  for (const [name, selector] of Object.entries(selectors)) {
    const element = document.querySelector(selector);
    if (!element) {
      result[name] = {missing: true, selector};
      continue;
    }
    const box = element.getBoundingClientRect();
    result[name] = {
      selector,
      tag: element.tagName.toLowerCase(),
      id: element.id,
      className: String(element.className || ''),
      cursor: getComputedStyle(element).cursor,
      width: box.width,
      height: box.height,
      draggable: element.draggable === true,
      disabled: element.disabled === true,
    };
  }
  return result;
})()`;

const winnerExpression = selector => `(() => {
  const element = document.querySelector(${JSON.stringify(selector)});
  if (!element) return {missing: true};
  const specificity = text => text.split(',').map(part => {
    const ids = (part.match(/#[\\w-]+/g) || []).length;
    const classes = (part.match(/\\.[\\w-]+|\\[[^\\]]+\\]|:(?!:)[\\w-]+/g) || []).length;
    const types = (part.replace(/#[\\w-]+|\\.[\\w-]+|\\[[^\\]]+\\]|::?[\\w-]+(?:\\([^)]*\\))?|\\*/g, ' ')
      .match(/[a-zA-Z][\\w-]*/g) || []).length;
    return [ids, classes, types];
  }).sort((a, b) => b[0] - a[0] || b[1] - a[1] || b[2] - a[2])[0];
  const matches = [];
  let order = 0;
  const collect = (rules, href) => {
    for (const rule of rules) {
      order += 1;
      if (!rule.selectorText && rule.cssRules) {
        if (rule.conditionText && !matchMedia(rule.conditionText).matches) continue;
        collect(rule.cssRules, href);
        continue;
      }
      if (!rule.selectorText || !rule.style) continue;
      const cursor = rule.style.getPropertyValue('cursor');
      if (!cursor) continue;
      let hit = false;
      try { hit = element.matches(rule.selectorText); } catch {}
      if (!hit) continue;
      matches.push({
        selector: rule.selectorText,
        cursor,
        important: rule.style.getPropertyPriority('cursor') === 'important',
        href,
        order,
        specificity: specificity(rule.selectorText),
      });
    }
  };
  for (const sheet of document.styleSheets) {
    try { collect(sheet.cssRules, sheet.href || ''); } catch {}
  }
  const ranked = [...matches].sort((a, b) => Number(b.important) - Number(a.important)
    || b.specificity[0] - a.specificity[0]
    || b.specificity[1] - a.specificity[1]
    || b.specificity[2] - a.specificity[2]
    || b.order - a.order);
  return {matches, winner: ranked[0] ?? null, computed: getComputedStyle(element).cursor};
})()`;

if (typeof WebSocket !== 'function') skip('this Node version has no built-in WebSocket client; run with Node 22+.');
const started = Date.now();
server = spawn(process.execPath, ['scripts/serve.mjs'], {
  cwd: projectRoot,
  env: {...process.env, PORT: String(port)},
  stdio: 'ignore',
});
chrome = await launchChrome('m4shlab-cursor-');
if (!chrome) skip('Chrome/Chromium was not found. Set CHROME_BIN to run this test.');

try {
  client = await pageTarget(chrome.endpoint);
  await client.send('Page.enable');
  await client.send('Runtime.enable');
  await client.send('DOM.enable');

  await client.send('Emulation.setDeviceMetricsOverride', {width: 1440, height: 900, deviceScaleFactor: 1, mobile: false});
  await client.send('Page.navigate', {url: `${baseUrl}?cursor-contract=desktop`});
  await client.waitFor("document.documentElement.dataset.appReady === 'true'", 15000);
  assert.ok(existsSync(fixture), `missing synthetic fixture ${fixture}`);
  await client.setFiles('#file-input-a', [fixture, fixture]);
  await client.waitFor("document.querySelectorAll('.clip-card').length === 2", 30000);
  await client.waitFor("document.querySelector('#status').textContent.includes('samples') || !document.querySelector('#error').hidden", 30000);
  const importError = await client.evaluate("document.querySelector('#error').hidden ? null : document.querySelector('#error').textContent");
  assert.equal(importError, null, importError || 'clip import failed');

  const scans = [];
  for (const width of [1440, 390, 320]) {
    await client.send('Emulation.setDeviceMetricsOverride', {width, height: 900, deviceScaleFactor: 1, mobile: false});
    await client.evaluate('window.scrollTo(0, 0)');
    await new Promise(resolveWait => setTimeout(resolveWait, 250));
    const scan = await client.evaluate(gridScan);
    scans.push({width, ...scan});
    assert.ok(scan.total > 0, `${width}px: grid scan produced no points`);
    assert.deepEqual(scan.misses, [], `${width}px: ${scan.misses.length} grid points without a url() cursor: ${JSON.stringify(scan.misses)}`);
  }
  console.log(`PASS hit test: ${scans.map(item => `${item.width}px ${item.hits}/${item.total} points across ${item.positions} scroll positions carry url()`).join(', ')}`);

  await client.send('Emulation.setDeviceMetricsOverride', {width: 1440, height: 900, deviceScaleFactor: 1, mobile: false});
  await client.evaluate('window.scrollTo(0, 0)');

  const probes = await client.evaluate(probeExpression(mandatory));
  for (const [name, probe] of Object.entries(probes)) {
    assert.ok(!probe.missing, `mandatory surface ${name} (${mandatory[name]}) is missing`);
    assert.ok(probe.cursor.includes('url('), `mandatory surface ${name} has cursor ${probe.cursor}`);
  }
  console.log(`PASS mandatory probes: ${Object.keys(probes).length} surfaces expose a cursor URL (player, timeline, sliders, checkbox, import, drop zone, export, undo/redo, dialogs, header, footer)`);

  const winners = {};
  for (const name of ['header', 'footer', 'player', 'clipCard', 'connector', 'speedSlider', 'lookSelect', 'soundCheckbox', 'importLabel', 'exportButton', 'undo']) {
    const result = await client.evaluate(winnerExpression(mandatory[name]));
    winners[name] = result;
    assert.ok(result.winner, `${name}: no CSS rule declared a cursor`);
    assert.equal(result.winner.important, true, `${name}: winning cursor rule is not !important: ${JSON.stringify(result.winner)}`);
    assert.ok(result.winner.href.endsWith('/styles.css'), `${name}: cursor winner comes from ${result.winner.href}`);
    assert.ok(result.winner.cursor.includes('var(--m4-cursor'), `${name}: foreign cursor rule wins: ${JSON.stringify(result.winner)}`);
    for (const rule of result.matches) {
      assert.ok(rule.href.endsWith('/styles.css'), `${name}: foreign cursor rule ${rule.selector} from ${rule.href}`);
      assert.ok(rule.cursor.includes('var(--m4-cursor'), `${name}: literal cursor rule ${rule.selector} -> ${rule.cursor}`);
    }
  }
  assert.ok(Object.values(winners).every(result => result.computed.includes('url(')));
  for (const [name, result] of Object.entries(winners)) {
    console.log(`INFO rule winner ${name}: ${result.winner.selector} -> ${result.winner.cursor} (${result.winner.href})`);
  }
  console.log(`PASS rule winners: all ${Object.keys(winners).length} probed surfaces resolve to the !important token cascade in styles.css`);

  const assetState = await client.evaluate(`(() => {
    const base = getComputedStyle(document.querySelector('header')).cursor;
    const interactive = getComputedStyle(document.querySelector('#export-button')).cursor;
    return {base, interactive};
  })()`);
  const urls = [...new Set((assetState.base + ' ' + assetState.interactive).match(/url\(["']?([^"')]+)["']?\)/g) || [])];
  assert.equal(urls.length, 4, `expected four distinct base/interactive asset references, got ${JSON.stringify(urls)}`);
  const loaded = await client.evaluate(`(async () => {
    const urls = ${JSON.stringify(urls.map(value => /url\(["']?([^"')]+)["']?\)/.exec(value)[1]))};
    return Promise.all(urls.map(url => new Promise(resolve => {
      const image = new Image();
      image.onload = () => resolve({url, status: 'loaded', width: image.naturalWidth, height: image.naturalHeight});
      image.onerror = () => resolve({url, status: 'error', width: 0, height: 0});
      image.src = url;
    })));
  })()`);
  const fetched = await client.evaluate(`(async () => {
    const urls = ${JSON.stringify(urls.map(value => /url\(["']?([^"')]+)["']?\)/.exec(value)[1]))};
    return Promise.all(urls.map(async url => ({url, status: (await fetch(url)).status})));
  })()`);
  for (const asset of loaded) {
    assert.equal(asset.status, 'loaded', `cursor asset failed to load: ${asset.url}`);
    assert.ok(asset.width > 0 && asset.height > 0, `cursor asset has no intrinsic size: ${JSON.stringify(asset)}`);
    assert.ok(asset.width <= 32 && asset.height <= 32, `cursor asset exceeds the 32px budget: ${JSON.stringify(asset)}`);
  }
  for (const asset of fetched) assert.equal(asset.status, 200, `cursor asset HTTP ${asset.status}: ${asset.url}`);
  console.log(`PASS assets: ${loaded.length} computed cursor URLs load with HTTP 200 and natural sizes ${loaded.map(item => `${item.width}x${item.height}`).join(', ')}`);

  for (const file of cursorFiles) {
    const path = join(cursorDir, file.name);
    assert.ok(existsSync(path), `missing cursor asset ${file.name}`);
    const size = file.png ? pngDimensions(path) : svgDimensions(path);
    assert.ok(size.width <= 32 && size.height <= 32, `${file.name} is ${size.width}x${size.height}, budget is 32px per dimension`);
    assert.ok(Math.abs(size.width - file.width) <= 0.6 && Math.abs(size.height - file.height) <= 0.6,
      `${file.name} dimensions ${size.width}x${size.height} drifted from ${file.width}x${file.height}`);
  }
  console.log(`PASS image budget: ${cursorFiles.length} cursor files stay within 32px (${cursorFiles.map(file => `${file.name} ${file.width}x${file.height}`).join(', ')})`);

  await client.evaluate("document.querySelector('#bitstream-report summary').scrollIntoView({block: 'center'})");
  await new Promise(resolveWait => setTimeout(resolveWait, 150));
  const pressBox = await client.evaluate(`(() => {
    const box = document.querySelector('#bitstream-report summary').getBoundingClientRect();
    return {x: box.left + box.width / 2, y: box.top + box.height / 2};
  })()`);
  await client.send('Input.dispatchMouseEvent', {type: 'mouseMoved', x: pressBox.x, y: pressBox.y, button: 'none'});
  await client.send('Input.dispatchMouseEvent', {type: 'mousePressed', x: pressBox.x, y: pressBox.y, button: 'left', clickCount: 1});
  await new Promise(resolveWait => setTimeout(resolveWait, 120));
  const pressedCursor = await client.evaluate("getComputedStyle(document.querySelector('#bitstream-report summary')).cursor");
  await client.send('Input.dispatchMouseEvent', {type: 'mouseReleased', x: pressBox.x, y: pressBox.y, button: 'left', clickCount: 1});
  assert.match(pressedCursor, /m4-cursor-pressed\.svg/, `pressed cursor is ${pressedCursor}`);
  assert.match(assetState.interactive, /m4-cursor-interactive\.svg/, `interactive cursor is ${assetState.interactive}`);
  const pressedRefs = [...new Set((pressedCursor.match(/url\(["']?([^"')]+)["']?\)/g) || []))];
  assert.equal(pressedRefs.length, 2, `expected SVG and PNG pressed references, got ${JSON.stringify(pressedRefs)}`);
  const pressedLoaded = await client.evaluate(`(async () => {
    const urls = ${JSON.stringify(pressedRefs.map(value => /url\(["']?([^"')]+)["']?\)/.exec(value)[1]))};
    return Promise.all(urls.map(url => new Promise(resolve => {
      const image = new Image();
      image.onload = () => resolve({url, status: 'loaded', width: image.naturalWidth, height: image.naturalHeight});
      image.onerror = () => resolve({url, status: 'error', width: 0, height: 0});
      image.src = url;
    })));
  })()`);
  for (const asset of pressedLoaded) {
    assert.equal(asset.status, 'loaded', `pressed cursor asset failed to load: ${asset.url}`);
    assert.ok(asset.width > 0 && asset.height > 0 && asset.width <= 32 && asset.height <= 32,
      `pressed cursor asset out of budget: ${JSON.stringify(asset)}`);
  }
  console.log(`PASS pressed: pointerdown reports ${pressedCursor.match(/m4-cursor-pressed\.svg/)?.[0]} instead of ${assetState.interactive.match(/m4-cursor-interactive\.svg/)?.[0]}; both pressed assets load (${pressedLoaded.map(item => `${item.width}x${item.height}`).join(', ')})`);

  const importButtonBox = await client.evaluate(`(() => {
    const box = document.querySelector('header label.button').getBoundingClientRect();
    return {x: box.left + box.width / 2, y: box.top + box.height / 2, width: box.width, height: box.height};
  })()`);
  assert.ok(importButtonBox.width > 0 && importButtonBox.height > 0);
  assert.equal((await client.evaluate("document.querySelector('#transition-dialog').open")), false);
  const closedDialog = await client.evaluate("getComputedStyle(document.querySelector('#transition-dialog')).cursor");
  assert.ok(closedDialog.includes('url('), `closed transition dialog cursor is ${closedDialog}`);
  await client.evaluate("document.querySelectorAll('.connector')[0].click()");
  await client.waitFor("document.querySelector('#transition-dialog').open === true", 5000);
  const openDialogProbes = await client.evaluate(probeExpression({
    dialog: '#transition-dialog',
    method: '#transition-method',
    duration: '#transition-duration',
    ending: '#transition-ending',
    effect: '#effect-parameter',
    interval: '#reset-interval',
    randomize: '#transition-randomize',
    seed: '#transition-seed',
    apply: '#transition-apply',
    close: '#transition-dialog button[value="cancel"]',
  }));
  for (const [name, probe] of Object.entries(openDialogProbes)) {
    assert.ok(!probe.missing, `open dialog surface ${name} is missing`);
    assert.ok(probe.cursor.includes('url('), `open dialog surface ${name} has cursor ${probe.cursor}`);
  }
  const dialogWinner = await client.evaluate(winnerExpression('#transition-apply'));
  assert.ok(dialogWinner.winner?.cursor.includes('var(--m4-cursor'), 'open dialog control lost the token cascade');
  await client.evaluate("document.querySelector('#transition-dialog').close()");
  await client.evaluate("document.querySelector('.clip-trim-button').click()");
  await client.waitFor("document.querySelector('#trim-dialog').open === true", 5000);
  const trimProbes = await client.evaluate(probeExpression({
    dialog: '#trim-dialog',
    start: '#trim-start',
    end: '#trim-end',
    startRange: '#trim-start-range',
    previewIn: '#trim-preview-in',
    reset: '#trim-reset',
    apply: '#trim-apply',
  }));
  for (const [name, probe] of Object.entries(trimProbes)) {
    assert.ok(!probe.missing, `trim dialog surface ${name} is missing`);
    assert.ok(probe.cursor.includes('url('), `trim dialog surface ${name} has cursor ${probe.cursor}`);
  }
  await client.evaluate("document.querySelector('#trim-dialog').close()");
  console.log(`PASS dialogs: transition and trim dialogs keep the cursor URL both closed and open (${Object.keys(openDialogProbes).length + Object.keys(trimProbes).length} surfaces)`);

  const dragState = await client.evaluate(`(() => {
    const cards = [...document.querySelectorAll('.clip-card')];
    if (cards.length < 2) return {error: 'need two cards'};
    const source = cards[0];
    const target = cards[1];
    const before = {
      order: cards.map(card => card.dataset.clipId),
      sourceCursor: getComputedStyle(source).cursor,
      targetCursor: getComputedStyle(target).cursor,
      draggable: cards.map(card => card.draggable),
    };
    const dataTransfer = new DataTransfer();
    source.dispatchEvent(new DragEvent('dragstart', {bubbles: true, cancelable: true, dataTransfer}));
    const duringSource = getComputedStyle(source).cursor;
    const rect = target.getBoundingClientRect();
    const clientX = rect.left + rect.width * 0.75;
    const clientY = rect.top + rect.height / 2;
    target.dispatchEvent(new DragEvent('dragover', {bubbles: true, cancelable: true, dataTransfer, clientX, clientY}));
    const duringTarget = getComputedStyle(target).cursor;
    const payload = dataTransfer.getData('text/plain');
    const classes = {dragging: source.classList.contains('dragging'), dropTarget: target.classList.contains('drop-target')};
    target.dispatchEvent(new DragEvent('drop', {bubbles: true, cancelable: true, dataTransfer, clientX, clientY}));
    source.dispatchEvent(new DragEvent('dragend', {bubbles: true, cancelable: true, dataTransfer}));
    return {before, duringSource, duringTarget, payload, classes};
  })()`);
  assert.equal(dragState.error, undefined, dragState.error);
  assert.ok(dragState.before.draggable.every(Boolean), 'clip cards are not draggable with a fine pointer');
  assert.match(dragState.payload, /^clip-/);
  assert.deepEqual(dragState.classes, {dragging: true, dropTarget: true});
  for (const cursor of [dragState.before.sourceCursor, dragState.before.targetCursor, dragState.duringSource, dragState.duringTarget]) {
    assert.ok(cursor.includes('url('), `cursor lost the custom image during drag: ${cursor}`);
  }
  await client.waitFor(`JSON.stringify([...document.querySelectorAll('.clip-card')].map(card => card.dataset.clipId)) === ${JSON.stringify(JSON.stringify([...dragState.before.order].reverse()))}`, 30000);
  console.log(`PASS drag: ${dragState.before.order.length} cards reorder after drop and every cursor stays on the interactive token (drag ghost remains browser-owned)`);

  await client.send('Emulation.setTouchEmulationEnabled', {enabled: true, maxTouchPoints: 5});
  await client.send('Emulation.setDeviceMetricsOverride', {width: 390, height: 844, deviceScaleFactor: 1, mobile: true});
  await client.send('Page.navigate', {url: `${baseUrl}?cursor-contract=touch`});
  await client.waitFor("document.documentElement.dataset.appReady === 'true'", 15000);
  const touchBefore = await client.evaluate(`(() => ({
    finePointer: matchMedia('(any-hover: hover) and (any-pointer: fine)').matches,
    coarsePointer: matchMedia('(pointer: coarse)').matches,
    maxTouchPoints: navigator.maxTouchPoints,
    bodyCursor: getComputedStyle(document.body).cursor,
    importCursor: getComputedStyle(document.querySelector('header label.button')).cursor,
    importHeight: document.querySelector('header label.button').getBoundingClientRect().height,
  }))()`);
  assert.equal(touchBefore.finePointer, false, 'touch emulation still matches the fine-pointer media query');
  assert.equal(touchBefore.coarsePointer, true, 'touch emulation did not report a coarse pointer');
  assert.ok(touchBefore.maxTouchPoints > 0);
  assert.ok(!touchBefore.bodyCursor.includes('url('), `touch body cursor is ${touchBefore.bodyCursor}`);
  assert.ok(!touchBefore.importCursor.includes('url('), `touch import cursor is ${touchBefore.importCursor}`);
  assert.ok(touchBefore.importHeight >= 44, `touch import target is ${touchBefore.importHeight}px, expected >= 44`);
  await client.setFiles('#file-input-a', [fixture]);
  await client.waitFor("document.querySelectorAll('.clip-card').length === 1", 30000);
  const touchCard = await client.evaluate(`(() => {
    const card = document.querySelector('.clip-card');
    return {draggable: card.draggable, cursor: getComputedStyle(card).cursor};
  })()`);
  assert.equal(touchCard.draggable, false, 'touch cards must not be draggable');
  assert.ok(!touchCard.cursor.includes('url('), `touch card cursor is ${touchCard.cursor}`);
  await client.send('Emulation.setTouchEmulationEnabled', {enabled: false, maxTouchPoints: 1});
  console.log(`PASS touch: coarse pointer keeps the system cursor (${touchBefore.bodyCursor}/${touchCard.cursor}), cards are not draggable, and the import target is ${touchBefore.importHeight.toFixed(2)}px`);

  const elapsed = (Date.now() - started) / 1000;
  assert.ok(elapsed < 90, `cursor contract took ${elapsed.toFixed(1)}s, budget is 90s`);
  if (client.exceptions.length) throw new Error(`Browser exceptions:\n${client.exceptions.join('\n')}`);
  console.log(`PASS cursor contract completed in ${elapsed.toFixed(1)}s`);
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
