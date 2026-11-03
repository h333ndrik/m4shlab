import { parseMp4 } from './parser/mp4.js';
import { CompatibilityError, checkCompatibility, mergeMoshH264 } from './merge.js';
import { convertToH264, MAX_CONVERSION_BYTES } from './converter.js';

const inputA = document.querySelector('#file-input-a');
const inputB = document.querySelector('#file-input-b');
const video = document.querySelector('#preview-video');
const emptyPreview = document.querySelector('#empty-preview');
const status = document.querySelector('#status');
const sourceTiers = document.querySelector('#source-tiers');
const error = document.querySelector('#error');
const conversionPanel = document.querySelector('#conversion-panel');
const conversionStatus = document.querySelector('#conversion-status');
const conversionMessage = document.querySelector('#conversion-message');
const conversionProgress = document.querySelector('#conversion-progress');
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
let pairNormalizationAttempted = false;
const loadTokens = {a: 0, b: 0};

function formatBytes(value) {
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / (1024 * 1024)).toFixed(1)} MB`;
}

function clipMode(clip) {
  if (!clip) return '';
  if (clip.conversion) return 'converted via ffmpeg.wasm';
  return 'native H.264';
}

function clipDescription(clip) {
  if (!clip) return '';
  if (!clip.conversion) return 'native H.264';
  const target = clip.conversion.target;
  const destination = target ? ` at ${target.width}×${target.height}` : '';
  return `converted via ffmpeg.wasm${destination}`;
}

function clipReport(clip) {
  if (!clip) return null;
  return {
    name: clip.file.name,
    tier: clip.conversion ? 'tier-2' : 'tier-1',
    mode: clip.conversion ? 'converted via ffmpeg.wasm' : 'native H.264',
    conversion: clip.conversion ? {...clip.conversion} : null,
  };
}

function setError(message = '') {
  error.textContent = message;
  error.hidden = !message;
}

function setConversionProgress(progress) {
  if (progress === null || !Number.isFinite(progress)) {
    conversionProgress.removeAttribute('value');
  } else {
    conversionProgress.value = Math.max(0, Math.min(1, progress));
  }
}

function showConversion(label, state, message, progress = null) {
  conversionPanel.hidden = false;
  conversionStatus.textContent = `${label} · ${state}`;
  conversionMessage.textContent = message;
  setConversionProgress(progress);
}

function renderSourceTiers() {
  const entries = [];
  for (const slot of ['a', 'b']) {
    const clip = clips[slot];
    if (clip) entries.push(`Clip ${slot.toUpperCase()}: ${clip.file.name} — ${clipDescription(clip)}`);
  }
  sourceTiers.replaceChildren();
  sourceTiers.hidden = entries.length === 0;
  for (const entry of entries) {
    const line = document.createElement('div');
    line.textContent = entry;
    sourceTiers.append(line);
  }
}

function finishConversionPanel() {
  const converted = ['a', 'b'].filter(slot => clips[slot]?.conversion);
  if (!converted.length) {
    conversionPanel.hidden = true;
    return;
  }
  const normalized = converted.length === 2 && converted.every(slot => clips[slot].conversion.mode === 'normalized');
  conversionStatus.textContent = normalized ? 'normalized via ffmpeg.wasm' : 'converted via ffmpeg.wasm';
  conversionMessage.textContent = converted.map(slot => `${slot.toUpperCase()}: ${clips[slot].file.name} → H.264 at ${clips[slot].mp4.videoTrack.width}×${clips[slot].mp4.videoTrack.height}`).join(' · ');
  setConversionProgress(1);
  conversionPanel.hidden = false;
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
  const cutLabel = clips.a?.conversion ? 'A cut (converted source)' : 'A cut (input)';
  setPreview(isMerged ? merged.mergedUrl : merged.cutUrl, isMerged ? 'merged A→B · video only' : cutLabel);
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
  renderSourceTiers();
  finishConversionPanel();
  originalButton.disabled = !clips.a;
  modifiedButton.disabled = true;

  if (clips.a) {
    setPreview(clips.a.url, clips.a.conversion ? 'A cut (converted source)' : 'A cut (input)');
    emptyPreview.hidden = true;
    originalButton.setAttribute('aria-pressed', 'true');
    modifiedButton.setAttribute('aria-pressed', 'false');
  } else {
    setPreview(null);
    emptyPreview.hidden = false;
    emptyPreview.textContent = 'load clips A and B to begin';
  }

  if (clips.a && !clips.b) {
    status.textContent = `${clips.a.file.name} loaded as clip A (${clipMode(clips.a)}) · load clip B to check compatibility.`;
  } else if (!clips.a && clips.b) {
    status.textContent = `${clips.b.file.name} loaded as clip B (${clipMode(clips.b)}) · load clip A to check compatibility.`;
  } else {
    status.textContent = 'No videos loaded.';
  }
}

async function convertClipSource(slot, sourceBytes, options, parseError = null) {
  const label = `Clip ${slot.toUpperCase()}`;
  const converted = await convertToH264(sourceBytes, {
    target: options.target ?? null,
    onStatus: message => {
      if (!options.isCurrent()) return;
      showConversion(label, 'working', message, null);
    },
    onProgress: progress => {
      if (!options.isCurrent()) return;
      const percent = progress.progress === null ? null : Math.round(progress.progress * 100);
      showConversion(label, 'working', percent === null ? 'Preparing H.264 conversion…' : `Converting with ffmpeg.wasm · ${percent}%`, progress.progress);
    },
  });
  if (!options.isCurrent()) return null;
  const mp4 = parseMp4(converted.bytes);
  return {
    bytes: converted.bytes,
    mp4,
    conversion: {
      converted: true,
      engine: converted.engine,
      coreVersion: converted.coreVersion,
      inputBytes: sourceBytes.byteLength,
      outputBytes: converted.bytes.byteLength,
      elapsedMs: converted.elapsedMs,
      target: converted.target,
      mode: options.target ? 'normalized' : 'converted',
      reason: options.reason,
      sourceError: parseError ? {code: parseError.code ?? null, message: parseError.message} : null,
    },
  };
}

async function normalizePair(token) {
  const target = {
    width: Math.max(clips.a.mp4.videoTrack.width, clips.b.mp4.videoTrack.width),
    height: Math.max(clips.a.mp4.videoTrack.height, clips.b.mp4.videoTrack.height),
  };
  pairNormalizationAttempted = true;
  for (const slot of ['a', 'b']) {
    if (token !== refreshToken) return false;
    const clip = clips[slot];
    const label = `Clip ${slot.toUpperCase()}`;
    showConversion(label, 'normalizing', `Converting both clips to a common ${target.width}×${target.height} H.264 layout…`, null);
    if (clip.file.size > MAX_CONVERSION_BYTES) {
      throw new Error(`${label} is ${formatBytes(clip.file.size)}; convert-on-load is limited to 100 MB.`);
    }
    const sourceBytes = new Uint8Array(await clip.file.arrayBuffer());
    const converted = await convertClipSource(slot, sourceBytes, {
      target,
      reason: 'pair-normalization',
      isCurrent: () => token === refreshToken,
    }, clip.conversion?.sourceError ?? null);
    if (!converted || token !== refreshToken) return false;
    revokeClip(slot);
    clips[slot] = {
      file: clip.file,
      bytes: converted.bytes,
      mp4: converted.mp4,
      url: URL.createObjectURL(new Blob([converted.bytes], {type: 'video/mp4'})),
      conversion: converted.conversion,
    };
    renderSourceTiers();
  }
  finishConversionPanel();
  return true;
}

async function refreshPair() {
  const token = ++refreshToken;
  resetMerged();
  setError('');
  if (!clips.a || !clips.b) {
    updateSingleClipState();
    return;
  }

  renderSourceTiers();
  finishConversionPanel();
  compatibilityPanel.hidden = true;
  reportPanel.hidden = true;
  originalButton.disabled = false;
  modifiedButton.disabled = true;
  exportButton.disabled = true;
  setPreview(clips.a.url, clips.a.conversion ? 'A cut (converted source)' : 'A cut (input)');
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
  report.textContent = JSON.stringify({
    stage: 'compatibility',
    sources: {a: clipReport(clips.a), b: clipReport(clips.b)},
    ...compatibility,
  }, null, 2);
  reportPanel.hidden = false;

  if (!compatibility.compatible) {
    if (!pairNormalizationAttempted && (clips.a.conversion || clips.b.conversion)) {
      status.textContent = 'Converted pair is not yet aligned; normalizing both sources with ffmpeg.wasm…';
      try {
        const normalized = await normalizePair(token);
        if (!normalized || token !== refreshToken) return;
        await refreshPair();
        return;
      } catch (cause) {
        if (token !== refreshToken) return;
        showConversion('Conversion', 'failed', cause instanceof Error ? cause.message : String(cause));
        status.textContent = 'Pair normalization failed.';
        setError(`${cause instanceof Error ? cause.message : String(cause)} Try shorter clips or a lower resolution.`);
        return;
      }
    }
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
      sources: {a: clipReport(clips.a), b: clipReport(clips.b)},
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
  const label = `Clip ${slot.toUpperCase()}`;
  const token = ++loadTokens[slot];
  pairNormalizationAttempted = false;
  resetMerged();
  revokeClip(slot);
  clips[slot] = null;
  setError('');
  reportPanel.hidden = true;
  compatibilityPanel.hidden = true;
  renderSourceTiers();
  status.textContent = `Reading ${file.name} as ${label}…`;

  try {
    const sourceBytes = new Uint8Array(await file.arrayBuffer());
    let bytes = sourceBytes;
    let mp4;
    let conversion = null;
    let parseError = null;

    try {
      mp4 = parseMp4(bytes);
    } catch (cause) {
      parseError = cause;
      if (sourceBytes.byteLength > MAX_CONVERSION_BYTES) {
        throw new Error(`${label} is ${formatBytes(sourceBytes.byteLength)}; convert-on-load is limited to 100 MB.`);
      }
      showConversion(label, 'loading ffmpeg.wasm', `“${cause.message}” Loading the local converter; this can take a while on the first file.`, null);
      const converted = await convertClipSource(slot, sourceBytes, {
        reason: cause.code ?? 'unparseable-input',
        isCurrent: () => token === loadTokens[slot],
      }, cause);
      if (!converted || token !== loadTokens[slot]) return;
      bytes = converted.bytes;
      mp4 = converted.mp4;
      conversion = converted.conversion;
    }

    clips[slot] = {
      file,
      bytes,
      mp4,
      url: URL.createObjectURL(new Blob([bytes], {type: 'video/mp4'})),
      conversion,
    };
    await refreshPair();
  } catch (cause) {
    if (token !== loadTokens[slot]) return;
    clips[slot] = null;
    showConversion(label, 'failed', cause instanceof Error ? cause.message : String(cause));
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
