import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const projectRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const fixtureA = join(projectRoot, 'testmedia', 'synthetic-hevc.mov');
const fixtureB = join(projectRoot, 'testmedia', 'synthetic-hevc-small.mov');
const coreUrl = 'https://cdn.jsdelivr.net/npm/@ffmpeg/core@0.12.10/dist/esm/ffmpeg-core.wasm';

function skip(message) {
  console.log(`SKIP conversion browser test: ${message}`);
  process.exit(0);
}

let playwright;
try {
  playwright = await import('playwright');
} catch {
  skip('Playwright is not installed; the conversion path still has the optional CDP verification documented in README.');
}

try {
  const response = await fetch(coreUrl, {method: 'HEAD'});
  if (!response.ok) skip(`ffmpeg.wasm assets are unavailable (HTTP ${response.status}).`);
} catch {
  skip('ffmpeg.wasm assets are unavailable offline.');
}

if (!existsSync(fixtureA) || !existsSync(fixtureB)) {
  const generated = spawnSync('bash', ['testmedia/generate.sh'], {cwd: projectRoot, encoding: 'utf8'});
  if (generated.status !== 0) skip(`fixtures could not be generated: ${generated.stderr || generated.stdout}`);
}

const port = 4181;
const server = spawn(process.execPath, ['scripts/serve.mjs'], {
  cwd: projectRoot,
  env: {...process.env, PORT: String(port)},
  stdio: 'ignore',
});
let browser;
try {
  await new Promise(resolve => setTimeout(resolve, 700));
  try {
    browser = await playwright.chromium.launch({headless: true});
  } catch (error) {
    skip(`Chromium is unavailable: ${error.message}`);
  }
  const page = await browser.newPage();
  await page.goto(`http://127.0.0.1:${port}/`);
  await page.setInputFiles('#file-input-a', fixtureA);
  await page.waitForFunction(() => document.querySelector('#status').textContent.includes('clip A'), null, {timeout: 120000});
  await page.setInputFiles('#file-input-b', fixtureB);
  await page.waitForFunction(() => document.querySelector('#status').textContent.includes('samples') || !document.querySelector('#error').hidden, null, {timeout: 180000});

  const state = await page.evaluate(() => {
    const report = JSON.parse(document.querySelector('#report').textContent);
    return {
      conversionStatus: document.querySelector('#conversion-status').textContent,
      error: document.querySelector('#error').hidden ? null : document.querySelector('#error').textContent,
      compatibilityMarkup: document.querySelector('#compatibility-panel, #compatibility-status, .compatibility-table'),
      modifiedEnabled: !document.querySelector('#show-modified').disabled,
      sources: report.sources,
      mergedSamples: report.merge.mergedSamples,
    };
  });
  assert.equal(state.error, null, state.error);
  assert.equal(state.compatibilityMarkup, null, 'Compatibility UI must not exist');
  assert.match(state.conversionStatus, /^normalized via ffmpeg\.wasm(?: \+ WebCodecs)?$/);
  assert.equal(state.modifiedEnabled, true);
  assert.equal(state.sources.a.tier, 'tier-2');
  assert.equal(state.sources.b.tier, 'tier-2');
  assert.match(state.sources.a.mode, /^normalized via ffmpeg\.wasm(?: \+ WebCodecs)?$/);
  assert.ok(['ffmpeg.wasm', 'WebCodecs'].includes(state.sources.a.conversion.encodeEngine));
  assert.equal(state.sources.a.conversion.target.width, 320);
  assert.equal(state.sources.a.conversion.target.height, 240);
  assert.ok(state.mergedSamples > 0);

  await page.click('#show-modified');
  await page.waitForFunction(() => document.querySelector('#preview-video').readyState >= 2, null, {timeout: 15000});
  const playback = await page.evaluate(() => {
    const video = document.querySelector('#preview-video');
    return {readyState: video.readyState, error: video.error?.code ?? null, width: video.videoWidth, height: video.videoHeight};
  });
  assert.equal(playback.error, null);
  assert.equal(playback.width, 320);
  assert.equal(playback.height, 240);

  const downloadPromise = page.waitForEvent('download', {timeout: 15000});
  await page.click('#export-button');
  const download = await downloadPromise;
  assert.equal(download.suggestedFilename(), 'm4shlab-merge.mp4');
  console.log(`PASS HEVC MOV conversion and merge: ${JSON.stringify(state)}; preview ${JSON.stringify(playback)}`);
} finally {
  await browser?.close();
  server.kill('SIGTERM');
}
