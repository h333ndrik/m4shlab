import { parseMp4 } from './parser/mp4.js';
import { CompatibilityError, checkCompatibility, mergeMoshH264 } from './merge.js';
import { convertToH264, MAX_CONVERSION_BYTES } from './converter.js';
import { isWebCodecsAvailable, normalizeWithWebCodecs } from './webcodecs.js';
import { chooseNormalizationTarget } from './webcodecs-muxer.js';

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
const conversionProgressB = document.querySelector('#conversion-progress-b');
const conversionProgressBRow = document.querySelector('#conversion-progress-b-row');
const originalButton = document.querySelector('#show-original');
const modifiedButton = document.querySelector('#show-modified');
const exportButton = document.querySelector('#export-button');
const previewLabel = document.querySelector('#preview-label');
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
  if (clip.conversion) return `${clip.conversion.mode === 'normalized' ? 'normalized' : 'converted'} via ${conversionEngine(clip)}`;
  return 'native H.264';
}

function conversionEngine(clip) {
  const conversion = clip?.conversion;
  if (conversion?.engine === 'WebCodecs') return 'WebCodecs';
  if (conversion?.encodeEngine === 'WebCodecs') return 'ffmpeg.wasm + WebCodecs';
  return 'ffmpeg.wasm';
}

function encodingPath(conversion) {
  return conversion?.encodeEngine === 'WebCodecs' ? 'encoded via WebCodecs' : 'encoded in wasm';
}

function formatDuration(milliseconds) {
  if (!Number.isFinite(milliseconds)) return '';
  return milliseconds < 1000 ? `${Math.round(milliseconds)} ms` : `${(milliseconds / 1000).toFixed(1)} s`;
}

function clipReport(clip) {
  if (!clip) return null;
  return {
    name: clip.file.name,
    tier: clip.conversion ? 'tier-2' : 'tier-1',
    mode: clip.conversion ? `${clip.conversion.mode === 'normalized' ? 'normalized' : 'converted'} via ${conversionEngine(clip)}` : 'native H.264',
    conversion: clip.conversion ? {...clip.conversion} : null,
  };
}

function clipDurationSeconds(clip) {
  const track = clip?.mp4?.videoTrack;
  if (!track?.stts || !track.mdhd?.timescale) return null;
  const units = track.stts.durations.reduce((total, value) => total + value, 0);
  return units / track.mdhd.timescale;
}

function compatibilityReport(compatibility) {
  if (!compatibility) return null;
  return {
    compatible: compatibility.compatible,
    spsMatch: compatibility.spsMatch ?? false,
    ppsMatch: compatibility.ppsMatch ?? false,
    failedChecks: compatibility.checks
      .filter(check => check.required && !check.match)
      .map(check => check.key),
  };
}

function compatibilityErrorText(compatibility) {
  const labels = compatibility?.checks
    ?.filter(check => check.required && !check.match)
    .map(check => check.label)
    .slice(0, 3)
    .join(', ');
  const detail = labels ? ` (${labels})` : '';
  return `This pair cannot be merged automatically${detail}. Record both clips with the same device and settings, or convert them to H.264 with matching parameters.`;
}

function shortErrorText(message, fallback) {
  const compact = String(message ?? '').replace(/\s+/g, ' ').trim();
  if (!compact) return fallback;
  return compact.length > 230 ? `${compact.slice(0, 227)}…` : compact;
}

function setError(message = '') {
  error.textContent = message;
  error.hidden = !message;
}

function setConversionProgress(progress, slot = 'a') {
  const bar = slot === 'b' ? conversionProgressB : conversionProgress;
  const row = slot === 'b' ? conversionProgressBRow : conversionProgress.closest('.conversion-progress-row');
  row.hidden = false;
  if (progress === null || !Number.isFinite(progress)) {
    bar.removeAttribute('value');
  } else {
    bar.value = Math.max(0, Math.min(1, progress));
  }
}

function showConversion(label, state, message, progress = null, slot = null) {
  conversionPanel.hidden = false;
  conversionStatus.textContent = `${label} · ${state}`;
  conversionMessage.textContent = message;
  if (slot) setConversionProgress(progress, slot);
}

function clipCard(slot, clip) {
  const card = document.createElement('article');
  card.className = `clip-card${clip ? '' : ' is-empty'}`;

  const thumb = document.createElement('div');
  thumb.className = 'clip-thumb';
  if (clip) {
    const preview = document.createElement('video');
    preview.src = `${clip.url}#t=0.001`;
    preview.muted = true;
    preview.playsInline = true;
    preview.preload = 'metadata';
    preview.setAttribute('aria-hidden', 'true');
    thumb.append(preview);
  } else {
    thumb.textContent = `clip ${slot}`;
  }

  const name = document.createElement('span');
  name.className = 'clip-name';
  name.textContent = clip?.file.name ?? `Add clip ${slot.toUpperCase()}`;

  const detail = document.createElement('span');
  detail.className = 'clip-detail';
  const duration = clipDurationSeconds(clip);
  detail.textContent = clip
    ? `${duration === null ? 'video' : `${duration.toFixed(2)} s`} · ${clipMode(clip)}`
    : 'use the import control';

  const controls = document.createElement('div');
  controls.className = 'clip-controls';
  for (const [glyph, label, title] of [
    ['←', `Move clip ${slot.toUpperCase()} left`, 'A → B order is fixed in this phase'],
    ['→', `Move clip ${slot.toUpperCase()} right`, 'A → B order is fixed in this phase'],
    ['×', `Remove clip ${slot.toUpperCase()}`, 'Use the import control to replace this clip'],
  ]) {
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = glyph;
    button.setAttribute('aria-label', label);
    button.title = title;
    button.disabled = true;
    controls.append(button);
  }

  card.append(thumb, name, detail, controls);
  return card;
}

function renderSourceTiers() {
  const connector = document.createElement('div');
  connector.className = 'connector';
  const effect = document.createElement('span');
  effect.textContent = 'Classic Mosh';
  const duration = document.createElement('span');
  duration.textContent = clipDurationSeconds(clips.b) === null
    ? 'choose clip B'
    : `${clipDurationSeconds(clips.b).toFixed(2)} s`;
  connector.append(effect, duration);
  sourceTiers.replaceChildren(clipCard('a', clips.a), connector, clipCard('b', clips.b));
  sourceTiers.hidden = false;
}

function finishConversionPanel() {
  const converted = ['a', 'b'].filter(slot => clips[slot]?.conversion);
  if (!converted.length) {
    conversionPanel.hidden = true;
    return;
  }
  const normalized = converted.length === 2 && converted.every(slot => clips[slot].conversion.mode === 'normalized');
  const engines = [...new Set(converted.map(slot => conversionEngine(clips[slot])))];
  const engineLabel = engines.join(' + ');
  conversionStatus.textContent = `${normalized ? 'normalized' : 'converted'} via ${engineLabel}`;
  conversionMessage.textContent = converted.map(slot => {
    const conversion = clips[slot].conversion;
    return `${slot.toUpperCase()}: ${clips[slot].file.name} → H.264 at ${clips[slot].mp4.videoTrack.width}×${clips[slot].mp4.videoTrack.height} · ${encodingPath(conversion)} · ${formatDuration(conversion.elapsedMs)}`;
  }).join(' · ');
  for (const slot of converted) setConversionProgress(1, slot);
  conversionProgressBRow.hidden = !converted.includes('b');
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

function pairNormalizationReport() {
  const conversions = ['a', 'b'].map(slot => clips[slot]?.conversion).filter(Boolean);
  if (conversions.length === 0) return null;
  return {
    autoNormalized: conversions.length === 2 && conversions.every(conversion => conversion.reason === 'pair-normalization'),
    parallel: conversions.length === 2 && conversions.every(conversion => conversion.parallel === true),
    target: conversions[0].target ?? null,
    engines: conversions.map(conversion => ({
      decode: conversion.decodeEngine ?? conversion.engine,
      encode: conversion.encodeEngine ?? conversion.engine,
    })),
  };
}

function updateSingleClipState() {
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
    status.textContent = `${clips.a.file.name} loaded as clip A (${clipMode(clips.a)}) · load clip B to create the transition.`;
  } else if (!clips.a && clips.b) {
    status.textContent = `${clips.b.file.name} loaded as clip B (${clipMode(clips.b)}) · load clip A to create the transition.`;
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
      showConversion(label, 'working', message, null, slot);
    },
    onProgress: progress => {
      if (!options.isCurrent()) return;
      const percent = progress.progress === null ? null : Math.round(progress.progress * 100);
      showConversion(label, 'working', percent === null ? 'Preparing H.264 conversion…' : `Converting with ffmpeg.wasm · ${percent}%`, progress.progress, slot);
    },
  });
  if (!options.isCurrent()) return null;
  const mp4 = parseMp4(converted.bytes);
  const target = converted.target ?? {width: mp4.videoTrack.width, height: mp4.videoTrack.height};
  return {
    bytes: converted.bytes,
    mp4,
    conversion: {
      converted: true,
      engine: converted.engine,
      decodeEngine: converted.decodeEngine,
      encodeEngine: converted.encodeEngine,
      hybrid: converted.hybrid ?? false,
      hybridFallbackReason: converted.hybridFallbackReason ?? null,
      coreVersion: converted.coreVersion,
      inputBytes: sourceBytes.byteLength,
      outputBytes: converted.bytes.byteLength,
      elapsedMs: converted.elapsedMs,
      target,
      mode: options.target ? 'normalized' : 'converted',
      reason: options.reason,
      sourceError: parseError ? {code: parseError.code ?? null, message: parseError.message} : null,
    },
  };
}

async function normalizePair(token) {
  const target = chooseNormalizationTarget(
    {width: clips.a.mp4.videoTrack.width, height: clips.a.mp4.videoTrack.height},
    {width: clips.b.mp4.videoTrack.width, height: clips.b.mp4.videoTrack.height},
  );
  pairNormalizationAttempted = true;
  let webcodecsFallbackReason = null;

  if (isWebCodecsAvailable() && !clips.a.conversion && !clips.b.conversion) {
    const normalizedClips = {};
    const discardNormalizedClips = () => {
      for (const clip of Object.values(normalizedClips)) {
        if (clip.url) URL.revokeObjectURL(clip.url);
      }
    };
    try {
      setConversionProgress(null, 'a');
      setConversionProgress(null, 'b');
      showConversion('Clips A + B', 'normalizing', `Decoding and re-encoding both clips in parallel with WebCodecs to a common ${target.width}×${target.height} H.264 layout…`, null);
      await Promise.all(['a', 'b'].map(async slot => {
        if (token !== refreshToken) return;
        const clip = clips[slot];
        const label = `Clip ${slot.toUpperCase()}`;
        if (clip.file.size > MAX_CONVERSION_BYTES) {
          throw new Error(`${label} is ${formatBytes(clip.file.size)}; conversion is limited to 100 MB.`);
        }
        showConversion(label, 'normalizing', `Decoding and re-encoding both clips with WebCodecs to a common ${target.width}×${target.height} H.264 layout…`, null, slot);
        const sourceBytes = new Uint8Array(await clip.file.arrayBuffer());
        const normalized = await normalizeWithWebCodecs(sourceBytes, {
          target,
          onStatus: message => {
            if (token === refreshToken) showConversion(label, 'working', message, null, slot);
          },
          onProgress: progress => {
            if (token !== refreshToken) return;
            const percent = Math.round(progress * 100);
            showConversion(label, 'working', `Normalizing with WebCodecs · ${percent}%`, progress, slot);
          },
        });
        if (token !== refreshToken) return;
        const mp4 = parseMp4(normalized.bytes);
        normalizedClips[slot] = {
          file: clip.file,
          bytes: normalized.bytes,
          mp4,
          url: URL.createObjectURL(new Blob([normalized.bytes], {type: 'video/mp4'})),
          conversion: {
            converted: true,
            engine: 'WebCodecs',
            decodeEngine: 'WebCodecs',
            encodeEngine: 'WebCodecs',
            hybrid: false,
            parallel: true,
            inputBytes: sourceBytes.byteLength,
            outputBytes: normalized.bytes.byteLength,
            elapsedMs: normalized.elapsedMs,
            target: normalized.target,
            mode: 'normalized',
            reason: 'pair-normalization',
            decoderCodec: normalized.decoderCodec,
            encoderCodec: normalized.encoderCodec,
            fps: normalized.fps,
            keyframes: normalized.keyframes,
            outputSamples: normalized.outputSamples,
            frameAlignment: normalized.frameAlignment,
          },
        };
      }));
      if (token !== refreshToken || !normalizedClips.a || !normalizedClips.b) {
        discardNormalizedClips();
        return false;
      }
      for (const slot of ['a', 'b']) {
        revokeClip(slot);
        clips[slot] = normalizedClips[slot];
      }
      renderSourceTiers();
      finishConversionPanel();
      return true;
    } catch (cause) {
      discardNormalizedClips();
      if (token !== refreshToken) return false;
      webcodecsFallbackReason = cause instanceof Error ? cause.message : String(cause);
      showConversion('WebCodecs', 'falling back', `${cause instanceof Error ? cause.message : String(cause)} Loading the ffmpeg.wasm fallback…`, null);
    }
  }

  const convertedClips = {};
  setConversionProgress(null, 'a');
  setConversionProgress(null, 'b');
  showConversion('Clips A + B', 'normalizing', `Converting both clips in parallel with ffmpeg.wasm to a common ${target.width}×${target.height} H.264 layout…`, null);
  try {
    await Promise.all(['a', 'b'].map(async slot => {
      const clip = clips[slot];
      const label = `Clip ${slot.toUpperCase()}`;
      if (clip.file.size > MAX_CONVERSION_BYTES) {
        throw new Error(`${label} is ${formatBytes(clip.file.size)}; convert-on-load is limited to 100 MB.`);
      }
      const sourceBytes = new Uint8Array(await clip.file.arrayBuffer());
      const converted = await convertClipSource(slot, sourceBytes, {
        target,
        reason: 'pair-normalization',
        isCurrent: () => token === refreshToken,
      }, clip.conversion?.sourceError ?? null);
      if (!converted || token !== refreshToken) return;
      convertedClips[slot] = {
        file: clip.file,
        bytes: converted.bytes,
        mp4: converted.mp4,
        url: URL.createObjectURL(new Blob([converted.bytes], {type: 'video/mp4'})),
        conversion: {
          ...converted.conversion,
          webcodecsFallbackReason,
          parallel: true,
        },
      };
    }));
  } catch (cause) {
    for (const clip of Object.values(convertedClips)) URL.revokeObjectURL(clip.url);
    throw cause;
  }
  if (token !== refreshToken) {
    for (const clip of Object.values(convertedClips)) URL.revokeObjectURL(clip.url);
    return false;
  }
  if (!convertedClips.a || !convertedClips.b) return false;
  for (const slot of ['a', 'b']) {
    revokeClip(slot);
    clips[slot] = convertedClips[slot];
  }
  renderSourceTiers();
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
  reportPanel.hidden = true;
  originalButton.disabled = false;
  modifiedButton.disabled = true;
  exportButton.disabled = true;
  setPreview(clips.a.url, clips.a.conversion ? 'A cut (converted source)' : 'A cut (input)');
  emptyPreview.hidden = true;
  status.textContent = 'Preparing the transition…';

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
  if (!compatibility.compatible && !pairNormalizationAttempted) {
    const target = chooseNormalizationTarget(
      {width: clips.a.mp4.videoTrack.width, height: clips.a.mp4.videoTrack.height},
      {width: clips.b.mp4.videoTrack.width, height: clips.b.mp4.videoTrack.height},
    );
    report.textContent = JSON.stringify({
      stage: 'normalizing-pair',
      sources: {a: clipReport(clips.a), b: clipReport(clips.b)},
      target,
      compatibility: compatibilityReport(compatibility),
    }, null, 2);
    reportPanel.hidden = false;
    modifiedButton.disabled = true;
    exportButton.disabled = true;
    status.textContent = `Normalizing clips A and B to ${target.width}×${target.height}…`;
    try {
      const normalized = await normalizePair(token);
      if (!normalized || token !== refreshToken) return;
      await refreshPair();
      return;
    } catch (cause) {
      if (token !== refreshToken) return;
      report.textContent = JSON.stringify({
        stage: 'normalization-failed',
        sources: {a: clipReport(clips.a), b: clipReport(clips.b)},
        target,
        compatibility: compatibilityReport(compatibility),
        error: cause instanceof Error ? cause.message : String(cause),
      }, null, 2);
      showConversion('Conversion', 'failed', cause instanceof Error ? cause.message : String(cause));
      status.textContent = 'Could not prepare this pair for merging.';
      const detail = cause instanceof Error ? cause.message : String(cause);
      setError(shortErrorText(`Normalization failed. ${detail} Try shorter clips or matching H.264 settings.`, 'Normalization failed. Try shorter clips or matching H.264 settings.'));
      return;
    }
  }

  report.textContent = JSON.stringify({
    stage: 'compatibility',
    sources: {a: clipReport(clips.a), b: clipReport(clips.b)},
    normalization: pairNormalizationReport(),
    compatibility: compatibilityReport(compatibility),
  }, null, 2);
  reportPanel.hidden = false;

  if (!compatibility.compatible) {
    status.textContent = 'This pair cannot be merged automatically.';
    setError(compatibilityErrorText(compatibility));
    modifiedButton.disabled = true;
    exportButton.disabled = true;
    return;
  }

  status.textContent = 'Compatible pair. Building the merged MP4…';
  setError('');
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
      normalization: pairNormalizationReport(),
      compatibility: compatibilityReport(result.compatibility),
      merge: result.report,
      cutByteIdentical: result.cut.byteLength === clips.a.bytes.byteLength && result.cut.every((value, index) => value === clips.a.bytes[index]),
    }, null, 2);
  } catch (cause) {
    if (token !== refreshToken) return;
    status.textContent = 'No merged MP4 was produced.';
    if (cause instanceof CompatibilityError) {
      setError(compatibilityErrorText(cause.report));
    } else {
      const detail = cause instanceof Error ? cause.message : String(cause);
      setError(shortErrorText(detail, 'The merge failed. Try shorter clips or matching H.264 settings.'));
    }
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
      showConversion(label, 'loading ffmpeg.wasm', `“${cause.message}” Loading the local converter; this can take a while on the first file.`, null, slot);
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
    showConversion(label, 'failed', cause instanceof Error ? cause.message : String(cause), null, slot);
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

updateSingleClipState();

window.addEventListener('beforeunload', () => {
  revokeClip('a');
  revokeClip('b');
  resetMerged();
});
