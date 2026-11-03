import { parseMp4 } from './parser/mp4.js';
import { CompatibilityError, checkCompatibility, mergeMoshH264 } from './merge.js';

const inputA = document.querySelector('#file-input-a');
const inputB = document.querySelector('#file-input-b');
const video = document.querySelector('#preview-video');
const emptyPreview = document.querySelector('#empty-preview');
const status = document.querySelector('#status');
const error = document.querySelector('#error');
const originalButton = document.querySelector('#show-original');
const modifiedButton = document.querySelector('#show-modified');
const exportButton = document.querySelector('#export-button');
const previewLabel = document.querySelector('#preview-label');
const compatibilityPanel = document.querySelector('#compatibility-panel');
const compatibilityStatus = document.querySelector('#compatibility-status');
const compatibilityMessage = document.querySelector('#compatibility-message');
const compatibilityRows = document.querySelector('#compatibility-rows');
const reportPanel = document.querySelector('#report-panel');
const report = document.querySelector('#report');

const clips = {a: null, b: null};
let merged = null;
let refreshToken = 0;
const loadTokens = {a: 0, b: 0};

function formatBytes(value) {
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / (1024 * 1024)).toFixed(1)} MB`;
}

function setError(message = '') {
  error.textContent = message;
  error.hidden = !message;
}

function videoErrorText() {
  if (!video.error) return 'Unknown playback failure.';
  const labels = {
    1: 'Playback was aborted.',
    2: 'A network error interrupted playback.',
    3: 'The browser could not decode the video bitstream.',
    4: 'The video format is not supported or the bitstream is damaged.',
  };
  return `${labels[video.error.code] ?? 'Playback failed.'} (media error ${video.error.code})`;
}

video.addEventListener('error', () => {
  if (!video.getAttribute('src')) return;
  setError(`Preview failed: ${videoErrorText()}`);
  status.textContent = 'The selected preview did not decode in this browser.';
});

video.addEventListener('loadeddata', () => {
  emptyPreview.hidden = true;
});

function revokeClip(slot) {
  const clip = clips[slot];
  if (clip?.url) URL.revokeObjectURL(clip.url);
}

function resetMerged() {
  if (merged?.cutUrl) URL.revokeObjectURL(merged.cutUrl);
  if (merged?.mergedUrl) URL.revokeObjectURL(merged.mergedUrl);
  merged = null;
  modifiedButton.disabled = true;
  exportButton.disabled = true;
  exportButton.onclick = null;
}

function setPreview(url, label) {
  if (!url) {
    video.removeAttribute('src');
    video.load();
    previewLabel.textContent = '—';
    return;
  }
  video.src = url;
  previewLabel.textContent = label;
  originalButton.setAttribute('aria-pressed', String(label.startsWith('A cut')));
  modifiedButton.setAttribute('aria-pressed', String(label.startsWith('merged')));
}

function showVersion(version) {
  if (!merged) return;
  const isMerged = version === 'merged';
  setError('');
  setPreview(isMerged ? merged.mergedUrl : merged.cutUrl, isMerged ? 'merged A→B · video only' : 'A cut (input)');
}

function renderCompatibility(compatibility) {
  compatibilityRows.replaceChildren();
  for (const check of compatibility.checks) {
    const row = document.createElement('tr');
    const label = document.createElement('td');
    const a = document.createElement('td');
    const b = document.createElement('td');
    const result = document.createElement('td');
    label.textContent = check.label;
    a.textContent = check.a;
    b.textContent = check.b;
    result.className = `compatibility-result ${check.match ? 'is-match' : check.required ? 'is-mismatch' : 'is-warning'}`;
    result.textContent = check.match ? '✓ match' : check.required ? '✕ mismatch' : `⚠ ${check.note}`;
    row.append(label, a, b, result);
    compatibilityRows.append(row);
  }
  compatibilityStatus.textContent = compatibility.compatible ? 'compatible' : 'not compatible';
  compatibilityStatus.className = `compatibility-status ${compatibility.compatible ? 'is-compatible' : 'is-incompatible'}`;
  compatibilityMessage.textContent = compatibility.message;
  compatibilityPanel.hidden = false;
}

function updateSingleClipState() {
  compatibilityPanel.hidden = true;
  reportPanel.hidden = true;
  resetMerged();
  originalButton.disabled = !clips.a;
  modifiedButton.disabled = true;

  if (clips.a) {
    setPreview(clips.a.url, 'A cut (input)');
    emptyPreview.hidden = true;
    originalButton.setAttribute('aria-pressed', 'true');
    modifiedButton.setAttribute('aria-pressed', 'false');
  } else {
    setPreview(null);
    emptyPreview.hidden = false;
    emptyPreview.textContent = 'load clips A and B to begin';
  }

  if (clips.a && !clips.b) {
    status.textContent = `${clips.a.file.name} loaded as clip A · load clip B to check compatibility.`;
  } else if (!clips.a && clips.b) {
    status.textContent = `${clips.b.file.name} loaded as clip B · load clip A to check compatibility.`;
  } else {
    status.textContent = 'No videos loaded.';
  }
}

async function refreshPair() {
  const token = ++refreshToken;
  resetMerged();
  setError('');
  if (!clips.a || !clips.b) {
    updateSingleClipState();
    return;
  }

  compatibilityPanel.hidden = true;
  reportPanel.hidden = true;
  originalButton.disabled = false;
  modifiedButton.disabled = true;
  exportButton.disabled = true;
  setPreview(clips.a.url, 'A cut (input)');
  emptyPreview.hidden = true;
  status.textContent = 'Checking GOP, parameter, resolution, and timing compatibility…';

  let compatibility;
  try {
    compatibility = await checkCompatibility(clips.a.bytes, clips.b.bytes, clips.a.mp4, clips.b.mp4);
  } catch (cause) {
    if (token !== refreshToken) return;
    status.textContent = 'Pair loaded; compatibility could not be verified.';
    setError(cause instanceof Error ? cause.message : String(cause));
    return;
  }
  if (token !== refreshToken) return;
  renderCompatibility(compatibility);
  report.textContent = JSON.stringify({stage: 'compatibility', ...compatibility}, null, 2);
  reportPanel.hidden = false;

  if (!compatibility.compatible) {
    status.textContent = 'Pair loaded; merge is blocked by compatibility checks.';
    setError(compatibility.message);
    modifiedButton.disabled = true;
    exportButton.disabled = true;
    return;
  }

  status.textContent = 'Compatible pair. Building the merged MP4…';
  try {
    const result = await mergeMoshH264(clips.a.bytes, clips.b.bytes, clips.a.mp4, clips.b.mp4);
    if (token !== refreshToken) return;
    const cutUrl = URL.createObjectURL(new Blob([result.cut], {type: 'video/mp4'}));
    const mergedUrl = URL.createObjectURL(new Blob([result.output], {type: 'video/mp4'}));
    merged = {result, cutUrl, mergedUrl};
    modifiedButton.disabled = false;
    exportButton.disabled = false;
    exportButton.onclick = () => {
      const link = document.createElement('a');
      link.href = mergedUrl;
      link.download = 'm4shlab-merge.mp4';
      link.click();
    };
    showVersion('original');
    status.textContent = `${clips.a.file.name} + ${clips.b.file.name} · ${result.report.mergedSamples} samples · ${result.report.mergedDurationSeconds.toFixed(2)} s · video only`;
    report.textContent = JSON.stringify({
      compatibility: result.compatibility,
      merge: result.report,
      cutByteIdentical: result.cut.byteLength === clips.a.bytes.byteLength && result.cut.every((value, index) => value === clips.a.bytes[index]),
    }, null, 2);
  } catch (cause) {
    if (token !== refreshToken) return;
    status.textContent = 'Pair loaded; no merged MP4 was produced.';
    setError(cause instanceof Error ? cause.message : String(cause));
    if (cause instanceof CompatibilityError) renderCompatibility(cause.report);
  }
}

async function loadClip(slot, file) {
  const label = slot === 'a' ? 'Clip A' : 'Clip B';
  const token = ++loadTokens[slot];
  resetMerged();
  revokeClip(slot);
  clips[slot] = null;
  setError('');
  reportPanel.hidden = true;
  compatibilityPanel.hidden = true;
  status.textContent = `Reading ${file.name} as ${label}…`;

  try {
    const bytes = new Uint8Array(await file.arrayBuffer());
    const mp4 = parseMp4(bytes);
    if (token !== loadTokens[slot]) return;
    clips[slot] = {file, bytes, mp4, url: URL.createObjectURL(new Blob([bytes], {type: 'video/mp4'}))};
    await refreshPair();
  } catch (cause) {
    if (token !== loadTokens[slot]) return;
    clips[slot] = null;
    await refreshPair();
    setError(`${label}: ${cause instanceof Error ? cause.message : String(cause)}`);
  }
}

inputA.addEventListener('change', () => {
  const [file] = inputA.files;
  if (file) loadClip('a', file);
});
inputB.addEventListener('change', () => {
  const [file] = inputB.files;
  if (file) loadClip('b', file);
});
originalButton.addEventListener('click', () => showVersion('original'));
modifiedButton.addEventListener('click', () => showVersion('merged'));

window.addEventListener('beforeunload', () => {
  revokeClip('a');
  revokeClip('b');
  resetMerged();
});
