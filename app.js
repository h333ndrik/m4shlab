import { childBoxes, parseBoxes, parseMp4 } from './parser/mp4.js';
import { extractNals } from './parser/nal.js';
import {
  CompatibilityError,
  appendCutH264,
  checkCompatibility,
  inspectEffectEligibility,
  mergeEffectH264,
  mergeMoshH264,
  mergeSequenceH264,
} from './merge.js';
import {
  convertToH264,
  extractAudioPcmWithFfmpeg,
  MAX_CONVERSION_BYTES,
  muxAacWithFfmpeg,
  muxPcmWithFfmpeg,
  speedAudioPcmWithFfmpeg,
} from './converter.js';
import { isWebCodecsAvailable, normalizeWithWebCodecs } from './webcodecs.js';
import { chooseNormalizationTarget } from './webcodecs-muxer.js';
import { frameRateForTrack, maxMoshFrames } from './classic-mosh.js';
import { atempoChain, normalizeSpeed, SPEED_MAX, SPEED_MIN, SPEED_STEP } from './speed.js';
import { canRandomize, randomizeTransition } from './randomize.js';
import {
  assembleAudioTimeline,
  buildAdts,
  encodeAacWithWebCodecs,
  isAudioEncoderAvailable,
  retimeMuxedAudio,
  RuntimeError,
  samplesPerFrame,
  wavBytes,
  AUDIO_CHANNELS,
  AUDIO_SAMPLE_RATE,
} from './audio.js';

const MAX_CLIPS = 12;
const inputA = document.querySelector('#file-input-a');
const inputB = document.querySelector('#file-input-b');
const video = document.querySelector('#preview-video');
const emptyPreview = document.querySelector('#empty-preview');
const status = document.querySelector('#status');
const sourceTiers = document.querySelector('#source-tiers');
const sequenceLabel = document.querySelector('#sequence-label');
const dropZone = document.querySelector('#drop-zone');
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
const undoButton = document.querySelector('#undo-button');
const redoButton = document.querySelector('#redo-button');
const transitionDialog = document.querySelector('#transition-dialog');
const transitionTitle = document.querySelector('#transition-title');
const transitionApply = document.querySelector('#transition-apply');
const transitionRandomize = document.querySelector('#transition-randomize');
const transitionSeed = document.querySelector('#transition-seed');
const classicMoshOptions = document.querySelector('#classic-mosh-options');
const transitionDuration = document.querySelector('#transition-duration');
const transitionDurationValue = document.querySelector('#transition-duration-value');
const transitionDurationMode = document.querySelector('#transition-duration-mode');
const transitionDurationMax = document.querySelector('#transition-duration-max');
const transitionEnding = document.querySelector('#transition-ending');
const nalEffectOptions = document.querySelector('#nal-effect-options');
const effectParameter = document.querySelector('#effect-parameter');
const effectParameterLabel = document.querySelector('#effect-parameter-label');
const effectParameterValue = document.querySelector('#effect-parameter-value');
const effectParameterMax = document.querySelector('#effect-parameter-max');
const meltCadenceControl = document.querySelector('#melt-cadence-control');
const meltCadence = document.querySelector('#melt-cadence');
const resetPulseOptions = document.querySelector('#reset-pulse-options');
const resetInterval = document.querySelector('#reset-interval');
const resetIntervalValue = document.querySelector('#reset-interval-value');
const resetIntervalMax = document.querySelector('#reset-interval-max');
const resetRepeat = document.querySelector('#reset-repeat');
const resetRepeatValue = document.querySelector('#reset-repeat-value');

let clips = [];
let merged = null;
let refreshToken = 0;
let importToken = 0;
let activeBoundary = null;
let activeMoshFps = 25;
let activeMoshMaximum = 0;
let activeRandomSeed = null;
let normalizationAttempted = false;
let undoStack = [];
let redoStack = [];

function formatBytes(value) {
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / (1024 * 1024)).toFixed(1)} MB`;
}

function sourceHasAudioTrack(bytes) {
  try {
    const boxes = parseBoxes(bytes, 0, bytes.byteLength, {allowSizeZero: true});
    const moov = boxes.find(box => box.type === 'moov');
    if (!moov) return false;
    for (const trak of childBoxes(bytes, moov).filter(box => box.type === 'trak')) {
      const mdia = childBoxes(bytes, trak).find(box => box.type === 'mdia');
      if (!mdia) continue;
      const hdlr = childBoxes(bytes, mdia).find(box => box.type === 'hdlr');
      if (!hdlr || hdlr.payloadStart + 12 > hdlr.payloadEnd) continue;
      let handler = '';
      for (let index = 0; index < 4; index += 1) handler += String.fromCharCode(bytes[hdlr.payloadStart + 8 + index]);
      if (handler === 'soun') return true;
    }
  } catch {}
  return false;
}

function silentClipAudio(frames, reason = 'silent') {
  return {
    pcm: null,
    frames,
    hasAudio: false,
    source: reason,
    decodeEngine: null,
    elapsedMs: 0,
  };
}

function planarPcmFromAudioBuffer(buffer, frames) {
  const left = buffer.getChannelData(0);
  const right = buffer.numberOfChannels > 1 ? buffer.getChannelData(1) : left;
  const pcm = new Float32Array(frames * AUDIO_CHANNELS);
  pcm.set(left.subarray(0, Math.min(frames, left.length)), 0);
  pcm.set(right.subarray(0, Math.min(frames, right.length)), frames);
  return pcm;
}

async function extractClipAudio(sourceBytes, mp4, label) {
  const track = mp4.videoTrack;
  const frames = track.samples.length;
  const fps = frameRateForTrack(track);
  const frameSamples = samplesPerFrame(fps, AUDIO_SAMPLE_RATE);
  const expectedSamples = frames * frameSamples;
  if (!sourceHasAudioTrack(sourceBytes)) return silentClipAudio(frames, 'no audio track');

  const started = performance.now();
  const OfflineContext = globalThis.OfflineAudioContext ?? globalThis.webkitOfflineAudioContext;
  if (OfflineContext) {
    try {
      const decodeContext = new OfflineContext(AUDIO_CHANNELS, 1, AUDIO_SAMPLE_RATE);
      const input = sourceBytes.slice();
      const decoded = await decodeContext.decodeAudioData(input.buffer);
      if (!decoded || decoded.length === 0) throw new Error('No decodable audio frames.');
      const renderContext = new OfflineContext(AUDIO_CHANNELS, expectedSamples, AUDIO_SAMPLE_RATE);
      const source = renderContext.createBufferSource();
      source.buffer = decoded;
      source.connect(renderContext.destination);
      source.start(0);
      const rendered = await renderContext.startRendering();
      return {
        pcm: planarPcmFromAudioBuffer(rendered, expectedSamples),
        frames,
        hasAudio: true,
        source: 'Web Audio decodeAudioData',
        decodeEngine: 'Web Audio',
        elapsedMs: Math.round(performance.now() - started),
      };
    } catch {}
  }

  showConversion(label, 'audio', 'Decoding the first audio track with ffmpeg.wasm…');
  const extracted = await extractAudioPcmWithFfmpeg(sourceBytes, expectedSamples, {
    onStatus: message => showConversion(label, 'audio', message),
  });
  if (!extracted.present) return silentClipAudio(frames, 'no audio track');
  return {
    pcm: extracted.pcm,
    frames,
    hasAudio: true,
    source: 'extracted via ffmpeg.wasm',
    decodeEngine: extracted.engine,
    elapsedMs: extracted.elapsedMs,
  };
}

async function applySpeedToClipAudio(baseAudio, outputFrames, speed, label) {
  const resolvedSpeed = normalizeSpeed(speed);
  const targetSamples = outputFrames * samplesPerFrame(30, AUDIO_SAMPLE_RATE);
  if (resolvedSpeed === 1) {
    if (!baseAudio.hasAudio) return silentClipAudio(outputFrames, baseAudio.source ?? 'silent');
    if (baseAudio.frames !== outputFrames) {
      throw new RuntimeError(`Speed 1.0× audio has ${baseAudio.frames} frames but normalized video has ${outputFrames}; no audio is trimmed silently.`);
    }
    return {...baseAudio, speed: 1, inputFrames: baseAudio.frames, outputFrames};
  }
  if (!baseAudio.hasAudio) return {...silentClipAudio(outputFrames, baseAudio.source ?? 'silent'), speed: resolvedSpeed, inputFrames: baseAudio.frames, outputFrames};
  const inputSampleFrames = baseAudio.pcm.length / AUDIO_CHANNELS;
  const wav = wavBytes(baseAudio.pcm, inputSampleFrames, AUDIO_SAMPLE_RATE, AUDIO_CHANNELS);
  const stretched = await speedAudioPcmWithFfmpeg(wav, resolvedSpeed, targetSamples, {
    onStatus: message => showConversion(label, 'audio speed', message),
  });
  return {
    pcm: stretched.pcm,
    frames: outputFrames,
    hasAudio: true,
    source: `atempo ${atempoChain(resolvedSpeed).join('·')}`,
    decodeEngine: baseAudio.decodeEngine,
    speedEngine: 'ffmpeg.wasm',
    elapsedMs: stretched.elapsedMs,
    speed: resolvedSpeed,
    inputFrames: baseAudio.frames,
    outputFrames,
    expectedSamples: targetSamples,
  };
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

function decodingPath(conversion) {
  if (!conversion) return null;
  const source = conversion.origin ?? conversion;
  if (source.decodeEngine === 'WebCodecs (HEVC)') return 'decoded via WebCodecs (HEVC)';
  if (source.decodeEngine === 'ffmpeg.wasm') return 'decoded via ffmpeg.wasm';
  if (source.decodeEngine?.startsWith('WebCodecs')) return 'decoded via WebCodecs';
  return null;
}

function clipMode(clip) {
  if (!clip) return '';
  if (clip.conversion) {
    return `${clip.conversion.mode === 'normalized' ? 'normalized' : 'converted'} via ${conversionEngine(clip)}`;
  }
  return 'native H.264';
}

function conversionPath(clip) {
  const conversion = clip.conversion;
  if (!conversion) return 'native H.264';
  const decode = decodingPath(conversion);
  const suffix = decode ? ` · ${decode}` : '';
  if (conversion.mode === 'normalized') {
    return conversion.origin
      ? `${conversion.origin.mode} via ${conversion.origin.engine}, then normalized via ${conversionEngine(clip)}${suffix}`
      : `normalized via ${conversionEngine(clip)}${suffix}`;
  }
  return `${conversion.mode} via ${conversionEngine(clip)}${suffix}`;
}

function formatDuration(milliseconds) {
  if (!Number.isFinite(milliseconds)) return '';
  return milliseconds < 1000 ? `${Math.round(milliseconds)} ms` : `${(milliseconds / 1000).toFixed(1)} s`;
}

function clipReport(clip, index) {
  if (!clip) return null;
  return {
    index,
    name: clip.file.name,
    tier: clip.conversion ? 'tier-2' : 'tier-1',
    mode: clipMode(clip),
    path: conversionPath(clip),
    speed: Number(clip.speed ?? 1),
    input_frames: clip.baseMp4?.videoTrack.samples.length ?? clip.speedReport?.inputFrames ?? clip.mp4.videoTrack.samples.length,
    output_frames: clip.mp4.videoTrack.samples.length,
    speedReport: clip.speedReport ? {...clip.speedReport} : null,
    conversion: clip.conversion ? {...clip.conversion} : null,
    audio: clip.audio ? {
      frames: clip.audio.frames,
      hasAudio: clip.audio.hasAudio === true,
      source: clip.audio.source,
      decodeEngine: clip.audio.decodeEngine,
      elapsedMs: clip.audio.elapsedMs,
    } : null,
  };
}

function sourcesReport() {
  const list = clips.map(clipReport);
  return {
    count: list.length,
    clips: list,
    a: list[0] ?? null,
    b: list[1] ?? null,
  };
}

function clipDurationSeconds(clip) {
  const track = clip?.mp4?.videoTrack;
  if (!track?.stts || !track.mdhd?.timescale) return null;
  const units = track.stts.durations.reduce((total, value) => total + value, 0);
  return units / track.mdhd.timescale;
}

function moshBoundaryLimits(clip) {
  const track = clip?.mp4?.videoTrack;
  if (!track) return {fps: 25, maximumFrames: 0, boundarySample: 0};
  const firstIdr = extractNals(clip.bytes, track).find(nal => nal.type === 5);
  const boundarySample = firstIdr?.sampleIndex ?? 0;
  let fps = 25;
  try {
    fps = frameRateForTrack(track);
  } catch {}
  return {fps, maximumFrames: maxMoshFrames(track, boundarySample), boundarySample};
}

function moshSettingsForClip(clip) {
  const limits = moshBoundaryLimits(clip);
  const requested = clip?.moshDurationFrames;
  const defaultEnding = clip?.transition === 'melt' || clip?.transition === 'loop' ? 'continue' : 'restore';
  const durationFrames = Math.max(0, Math.min(
    limits.maximumFrames,
    Number.isFinite(requested) ? Math.round(requested) : limits.maximumFrames,
  ));
  return {
    ...limits,
    durationFrames,
    durationSeconds: limits.fps > 0 ? durationFrames / limits.fps : 0,
    ending: clip?.moshEnding === 'continue' || clip?.moshEnding === 'restore' ? clip.moshEnding : defaultEnding,
    explicitDuration: requested !== undefined && requested !== null,
  };
}

function effectSettingsForClip(clip) {
  if (clip?.transition === 'melt') {
    const repeat = Number(clip.meltRepeat);
    const settings = moshSettingsForClip(clip);
    return {
      method: 'melt',
      repeat: Number.isInteger(repeat) && repeat >= 2 && repeat <= 12 ? repeat : 4,
      durationFrames: settings.durationFrames,
      durationSeconds: settings.durationSeconds,
      ending: settings.ending,
      smooth: clip.meltSmooth === true,
    };
  }
  if (clip?.transition === 'loop') {
    const loopFrames = Number(clip.loopFrames);
    const settings = moshSettingsForClip(clip);
    return {
      method: 'loop',
      loopFrames: Number.isInteger(loopFrames) && loopFrames >= 2 && loopFrames <= 48 ? loopFrames : 4,
      durationFrames: settings.durationFrames,
      durationSeconds: settings.durationSeconds,
      ending: settings.ending,
    };
  }
  if (clip?.transition === 'reset-pulse') {
    const interval = Number(clip.resetInterval);
    const repeat = Number(clip.resetRepeat);
    const settings = moshSettingsForClip(clip);
    return {
      method: 'reset-pulse',
      resetInterval: Number.isInteger(interval) && interval >= 4 && interval <= 48 ? interval : 12,
      repeat: Number.isInteger(repeat) && repeat >= 2 && repeat <= 12 ? repeat : 4,
      durationFrames: settings.durationFrames,
      durationSeconds: settings.durationSeconds,
      ending: settings.ending,
    };
  }
  return null;
}

function transitionLabel(method) {
  if (method === 'cut') return 'Cut';
  if (method === 'melt') return 'Melt';
  if (method === 'loop') return 'Loop Release';
  if (method === 'reset-pulse') return 'Reset Pulse';
  return 'Classic Mosh';
}

function clipDisplayLabel(index) {
  return index === 0 ? 'Clip A' : index === 1 ? 'Clip B' : `Clip ${index + 1}`;
}

function compatibilityReport(compatibility) {
  if (!compatibility) return null;
  return {
    compatible: compatibility.compatible,
    spsMatch: compatibility.spsMatch ?? false,
    ppsMatch: compatibility.ppsMatch ?? false,
    failedChecks: compatibility.checks
      ?.filter(check => check.required && !check.match)
      .map(check => check.key) ?? [],
  };
}

function compatibilityErrorText(compatibility) {
  const labels = compatibility?.checks
    ?.filter(check => check.required && !check.match)
    .map(check => check.label)
    .slice(0, 3)
    .join(', ');
  const detail = labels ? ` (${labels})` : '';
  return `These clips cannot be merged automatically${detail}. Record them with the same device and settings, or convert them to H.264 with matching parameters.`;
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

function setConversionProgress(progress, slot = null) {
  if (slot !== 'a' && slot !== 'b') return;
  const bar = slot === 'b' ? conversionProgressB : conversionProgress;
  const row = slot === 'b' ? conversionProgressBRow : conversionProgress.closest('.conversion-progress-row');
  row.hidden = false;
  if (progress === null || !Number.isFinite(progress)) bar.removeAttribute('value');
  else bar.value = Math.max(0, Math.min(1, progress));
}

function showConversion(label, state, message, progress = null, slot = null) {
  conversionPanel.hidden = false;
  conversionStatus.textContent = `${label} · ${state}`;
  conversionMessage.textContent = message;
  if (slot) setConversionProgress(progress, slot);
}

function progressSlot(index) {
  return index === 0 ? 'a' : index === 1 ? 'b' : null;
}

function renderClipCard(index, clip) {
  const card = document.createElement('article');
  card.className = 'clip-card';
  card.dataset.clipIndex = String(index);

  const thumb = document.createElement('div');
  thumb.className = 'clip-thumb';
  const preview = document.createElement('video');
  preview.src = `${clip.url}#t=0.001`;
  preview.muted = true;
  preview.playsInline = true;
  preview.preload = 'metadata';
  preview.setAttribute('aria-hidden', 'true');
  thumb.append(preview);

  const name = document.createElement('span');
  name.className = 'clip-name';
  name.textContent = clip.file.name;
  name.title = clip.file.name;

  const detail = document.createElement('span');
  detail.className = 'clip-detail';
  const duration = clipDurationSeconds(clip);
  detail.textContent = `${duration === null ? 'video' : `${duration.toFixed(2)} s`} · ${clipMode(clip)}`;
  detail.title = conversionPath(clip);

  const speedControl = document.createElement('div');
  speedControl.className = 'clip-speed';
  const speedHeading = document.createElement('div');
  speedHeading.className = 'clip-speed-heading';
  const speedLabel = document.createElement('label');
  speedLabel.textContent = 'speed';
  const speedOutput = document.createElement('output');
  speedOutput.textContent = `${Number(clip.speed ?? 1).toFixed(1)}×`;
  const speedReset = document.createElement('button');
  speedReset.type = 'button';
  speedReset.textContent = 'Reset';
  speedReset.setAttribute('aria-label', `Reset ${clipDisplayLabel(index)} speed to 1.0×`);
  speedReset.disabled = (clip.speed ?? 1) === 1;
  speedReset.addEventListener('click', () => setClipSpeed(index, 1));
  speedHeading.append(speedLabel, speedOutput, speedReset);
  const speedRange = document.createElement('input');
  speedRange.type = 'range';
  speedRange.min = String(SPEED_MIN);
  speedRange.max = String(SPEED_MAX);
  speedRange.step = String(SPEED_STEP);
  speedRange.value = String(Number(clip.speed ?? 1).toFixed(1));
  speedRange.setAttribute('aria-label', `${clipDisplayLabel(index)} playback speed`);
  speedRange.addEventListener('input', () => {
    speedOutput.textContent = `${Number(speedRange.value).toFixed(1)}×`;
  });
  speedRange.addEventListener('change', () => setClipSpeed(index, speedRange.value));
  speedLabel.htmlFor = speedRange.id = `clip-speed-${index}`;
  speedControl.append(speedHeading, speedRange);
  if (clip.speedReport) {
    speedControl.title = `${clip.speedReport.inputFrames} → ${clip.speedReport.outputFrames} frames · audio ${clip.speedReport.audioFrames} frames`;
  }

  const controls = document.createElement('div');
  controls.className = 'clip-controls';
  const actions = [
    ['←', `Move ${clipDisplayLabel(index)} left`, () => moveClip(index, index - 1), index === 0],
    ['→', `Move ${clipDisplayLabel(index)} right`, () => moveClip(index, index + 1), index === clips.length - 1],
    ['×', `Remove ${clipDisplayLabel(index)}`, () => removeClip(index), false],
  ];
  for (const [glyph, label, action, disabled] of actions) {
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = glyph;
    button.setAttribute('aria-label', label);
    button.title = label;
    button.disabled = disabled;
    button.addEventListener('click', action);
    controls.append(button);
  }

  card.append(thumb, name, detail, speedControl, controls);
  return card;
}

function renderConnector(index) {
  const incoming = clips[index];
  const connector = document.createElement('button');
  connector.type = 'button';
  connector.className = 'connector';
  connector.setAttribute('aria-label', `${transitionLabel(incoming.transition)} into ${clipDisplayLabel(index)}`);
  const effect = document.createElement('span');
  effect.textContent = transitionLabel(incoming.transition);
  const duration = document.createElement('span');
  const seconds = clipDurationSeconds(incoming);
  if (incoming.transition === 'classic-mosh') {
    const settings = moshSettingsForClip(incoming);
    duration.textContent = settings.maximumFrames > 0
      ? `${settings.durationSeconds.toFixed(2)} s · ${settings.ending}`
      : (seconds === null ? 'incoming clip' : `${seconds.toFixed(2)} s`);
  } else if (incoming.transition === 'melt') {
    const effect = effectSettingsForClip(incoming);
    duration.textContent = `${effect.durationSeconds.toFixed(2)} s · ${effect.repeat}× · ${effect.smooth ? 'gentler' : 'original'} · ${effect.ending}`;
  } else if (incoming.transition === 'loop') {
    const effect = effectSettingsForClip(incoming);
    duration.textContent = `${effect.durationSeconds.toFixed(2)} s · ${effect.loopFrames}f · ${effect.ending}`;
  } else if (incoming.transition === 'reset-pulse') {
    const effect = effectSettingsForClip(incoming);
    duration.textContent = `${effect.durationSeconds.toFixed(2)} s · ${effect.resetInterval}f / ${effect.repeat}×`;
  } else {
    duration.textContent = seconds === null ? 'incoming clip' : `${seconds.toFixed(2)} s`;
  }
  connector.append(effect, duration);
  connector.addEventListener('click', () => openTransition(index));
  return connector;
}

function renderSourceTiers() {
  if (clips.length === 0) {
    const empty = document.createElement('p');
    empty.className = 'timeline-empty';
    empty.textContent = 'Import up to 12 clips to build a sequence.';
    sourceTiers.replaceChildren(empty);
    sequenceLabel.textContent = '0 clips';
    sourceTiers.hidden = false;
    return;
  }
  const nodes = [];
  clips.forEach((clip, index) => {
    if (index > 0) nodes.push(renderConnector(index));
    nodes.push(renderClipCard(index, clip));
  });
  sourceTiers.replaceChildren(...nodes);
  sourceTiers.hidden = false;
  const cuts = clips.slice(1).filter(clip => clip.transition === 'cut').length;
  const mosh = clips.length - 1 - cuts;
  sequenceLabel.textContent = `${clips.length} clip${clips.length === 1 ? '' : 's'} · ${cuts} cut · ${mosh} mosh`;
}

function finishConversionPanel() {
  const converted = clips.map((clip, index) => ({clip, index})).filter(item => item.clip.conversion);
  if (converted.length === 0) {
    conversionPanel.hidden = true;
    return;
  }
  const allNormalized = converted.length === clips.length && clips.length > 1
    && converted.every(item => item.clip.conversion.mode === 'normalized');
  const engines = [...new Set(converted.map(item => conversionEngine(item.clip)))];
  conversionStatus.textContent = `${allNormalized ? 'normalized' : 'converted'} via ${engines.join(' + ')}`;
  conversionMessage.textContent = converted.map(({clip, index}) => {
    const conversion = clip.conversion;
    const decode = decodingPath(conversion);
    return `${clipDisplayLabel(index)}: ${clip.file.name} → ${clip.mp4.videoTrack.width}×${clip.mp4.videoTrack.height} · ${decode ? `${decode} · ` : ''}${encodingPath(conversion)} · ${formatDuration(conversion.elapsedMs)}`;
  }).join(' · ');
  for (const {index} of converted) setConversionProgress(1, progressSlot(index));
  conversionProgressBRow.hidden = !converted.some(item => item.index === 1);
  conversionPanel.hidden = false;
}

function sequenceNormalizationReport() {
  const conversions = clips.map(clip => clip.conversion).filter(Boolean);
  if (conversions.length === 0) return null;
  const reasons = new Set(['sequence-normalization', 'pair-normalization', 'speed-normalization']);
  return {
    autoNormalized: clips.length > 1 && conversions.length === clips.length
      && conversions.every(conversion => reasons.has(conversion.reason)),
    parallel: conversions.length > 1 && conversions.every(conversion => conversion.parallel === true),
    target: conversions.find(conversion => conversion.target)?.target ?? null,
    engines: clips.map((clip, index) => {
      const source = clip.conversion?.origin ?? clip.conversion;
      return {
        index,
        name: clip.file.name,
        path: conversionPath(clip),
        sourceCodec: source?.sourceCodec ?? null,
        decode: source?.decodeEngine ?? source?.engine ?? null,
        encode: clip.conversion?.encodeEngine ?? clip.conversion?.engine ?? null,
        hevcWebCodecsFallbackReason: source?.hevcWebCodecsFallbackReason ?? null,
      };
    }).filter(entry => clips[entry.index].conversion),
  };
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

function resetMerged() {
  if (merged?.cutUrl) URL.revokeObjectURL(merged.cutUrl);
  if (merged?.mergedUrl) URL.revokeObjectURL(merged.mergedUrl);
  merged = null;
  modifiedButton.disabled = true;
  exportButton.disabled = true;
  exportButton.onclick = null;
}

function setPreview(url, label, version = null) {
  if (!url) {
    video.removeAttribute('src');
    video.load();
    previewLabel.textContent = '—';
    return;
  }
  video.src = url;
  previewLabel.textContent = label;
  if (version) {
    originalButton.setAttribute('aria-pressed', String(version === 'original'));
    modifiedButton.setAttribute('aria-pressed', String(version === 'merged'));
  }
}

function sourceCutLabel() {
  return clips[0]?.conversion ? 'clip 1 cut (converted source)' : 'clip 1 cut (input)';
}

function showVersion(version) {
  if (!merged) return;
  const isMerged = version === 'merged';
  setError('');
  setPreview(
    isMerged ? merged.mergedUrl : merged.cutUrl,
    isMerged ? `merged ${clips.length} clip${clips.length === 1 ? '' : 's'} · video only` : sourceCutLabel(),
    isMerged ? 'merged' : 'original',
  );
}

function updateSingleClipState() {
  reportPanel.hidden = true;
  resetMerged();
  renderSourceTiers();
  finishConversionPanel();
  originalButton.textContent = 'A cut';
  originalButton.disabled = clips.length === 0;
  modifiedButton.disabled = true;

  if (clips.length === 1) {
    setPreview(clips[0].url, sourceCutLabel(), 'original');
    emptyPreview.hidden = true;
    status.textContent = `${clips[0].file.name} loaded as clip A (${clipMode(clips[0])}) · add another clip to create a transition.`;
  } else {
    setPreview(null);
    emptyPreview.hidden = false;
    emptyPreview.textContent = 'import clips to begin';
    status.textContent = 'No videos loaded.';
  }
}

function snapshotState() {
  return clips.map(clip => ({...clip}));
}

function restoreState(snapshot) {
  clips = snapshot.map(clip => ({...clip}));
  normalizationAttempted = false;
  updateHistoryButtons();
  refreshSequence();
}

function rememberState() {
  undoStack.push(snapshotState());
  if (undoStack.length > 50) undoStack.shift();
  redoStack = [];
  updateHistoryButtons();
}

function setClipSpeed(index, value) {
  if (index < 0 || index >= clips.length) return;
  let speed;
  try {
    speed = normalizeSpeed(value);
  } catch (cause) {
    setError(cause instanceof Error ? cause.message : String(cause));
    return;
  }
  if ((clips[index].speed ?? 1) === speed) return;
  rememberState();
  clips = clips.map((clip, clipIndex) => clipIndex === index ? {...clip, speed} : clip);
  normalizationAttempted = false;
  setError('');
  refreshSequence();
}

function updateHistoryButtons() {
  undoButton.disabled = undoStack.length === 0;
  redoButton.disabled = redoStack.length === 0;
}

function moveClip(from, to) {
  if (to < 0 || to >= clips.length || from === to) return;
  rememberState();
  const next = [...clips];
  const [clip] = next.splice(from, 1);
  next.splice(to, 0, clip);
  clips = next;
  normalizationAttempted = false;
  refreshSequence();
}

function removeClip(index) {
  if (index < 0 || index >= clips.length) return;
  rememberState();
  clips = clips.filter((_, clipIndex) => clipIndex !== index);
  normalizationAttempted = false;
  refreshSequence();
}

function undoTimeline() {
  if (undoStack.length === 0) return;
  redoStack.push(snapshotState());
  const previous = undoStack.pop();
  restoreState(previous);
}

function redoTimeline() {
  if (redoStack.length === 0) return;
  undoStack.push(snapshotState());
  const next = redoStack.pop();
  restoreState(next);
}

function updateTransitionSeedDisplay() {
  transitionSeed.textContent = activeRandomSeed ? `seed ${activeRandomSeed}` : 'seed —';
}

function clearRandomSeed() {
  if (activeRandomSeed === null) return;
  activeRandomSeed = null;
  updateTransitionSeedDisplay();
}

function randomMethodsForClip(clip) {
  if (!clip) return [];
  const methods = ['classic-mosh'];
  const eligibility = inspectEffectEligibility(clip.bytes, clip.mp4);
  if (eligibility.eligible) methods.push('melt', 'loop', 'reset-pulse');
  return methods;
}

function updateRandomizeAvailability() {
  const method = transitionDialog.querySelector('input[name="transition-method"]:checked')?.value;
  const clip = clips[activeBoundary];
  const methods = randomMethodsForClip(clip);
  const enabled = method !== 'cut' && canRandomize({
    availableFrames: activeMoshMaximum,
    fps: activeMoshFps,
    methods,
  });
  transitionRandomize.disabled = !enabled;
  transitionRandomize.title = enabled
    ? 'Generate a reproducible random mosh variant'
    : activeMoshMaximum < 12
      ? 'Randomize needs at least 12 frames after the first GOP boundary'
      : 'No valid random combination is available for this boundary';
}

function updateTransitionOptionsVisibility() {
  const method = transitionDialog.querySelector('input[name="transition-method"]:checked')?.value;
  classicMoshOptions.hidden = method === 'cut';
  nalEffectOptions.hidden = method !== 'melt' && method !== 'loop';
  meltCadenceControl.hidden = method !== 'melt';
  resetPulseOptions.hidden = method !== 'reset-pulse';
  updateRandomizeAvailability();
}

function updateTransitionDurationDisplay(custom = false) {
  const frames = Math.round(Number(transitionDuration.value));
  const seconds = activeMoshFps > 0 ? frames / activeMoshFps : 0;
  transitionDurationValue.textContent = `${seconds.toFixed(2)} s · ${frames} frame${frames === 1 ? '' : 's'}`;
  transitionDurationMax.textContent = `${activeMoshMaximum} available`;
  if (custom) transitionDurationMode.textContent = 'custom';
}

function updateEffectParameterDisplay() {
  const method = transitionDialog.querySelector('input[name="transition-method"]:checked')?.value;
  const value = Math.round(Number(effectParameter.value));
  effectParameterLabel.textContent = method === 'loop' ? 'loop frames' : 'repeat';
  effectParameterValue.textContent = method === 'loop' ? `${value} frames` : `${value}×`;
  effectParameterMax.textContent = `${effectParameter.max} max`;
}

function setEffectParameterControl(method, clip) {
  if (method !== 'melt' && method !== 'loop') return;
  if (method === 'loop') {
    effectParameter.min = '2';
    effectParameter.max = '48';
    effectParameter.value = String(effectSettingsForClip({...clip, transition: 'loop'}).loopFrames);
  } else {
    effectParameter.min = '2';
    effectParameter.max = '12';
    const melt = effectSettingsForClip({...clip, transition: 'melt'});
    effectParameter.value = String(melt.repeat);
    meltCadence.value = melt.smooth ? 'gentler' : 'original';
  }
  effectParameter.step = '1';
  updateEffectParameterDisplay();
}

function updateResetPulseDisplay() {
  const interval = Math.round(Number(resetInterval.value));
  const repeat = Math.round(Number(resetRepeat.value));
  resetIntervalValue.textContent = `${interval} frame${interval === 1 ? '' : 's'}`;
  resetIntervalMax.textContent = `${resetInterval.max} max`;
  resetRepeatValue.textContent = `${repeat}×`;
}

function setResetPulseControls(method, clip) {
  if (method !== 'reset-pulse') return;
  const maxInterval = Math.max(4, Math.min(48, activeMoshMaximum - 1));
  const settings = effectSettingsForClip({...clip, transition: 'reset-pulse'});
  resetInterval.min = '4';
  resetInterval.max = String(maxInterval);
  resetInterval.value = String(Math.min(maxInterval, Math.max(4, settings.resetInterval)));
  resetRepeat.value = String(settings.repeat);
  resetInterval.disabled = activeMoshMaximum < 5;
  resetRepeat.disabled = activeMoshMaximum < 5;
  updateResetPulseDisplay();
}

function updateResetIntervalLimit() {
  const maxInterval = Math.max(4, Math.min(48, activeMoshMaximum - 1));
  resetInterval.max = String(maxInterval);
  if (Number(resetInterval.value) > maxInterval) resetInterval.value = String(maxInterval);
  updateResetPulseDisplay();
}

function openTransition(boundaryIndex) {
  if (boundaryIndex < 1 || boundaryIndex >= clips.length) return;
  activeBoundary = boundaryIndex;
  const clip = clips[boundaryIndex];
  const method = clip.transition;
  const radio = transitionDialog.querySelector(`input[name="transition-method"][value="${method}"]`);
  if (radio) radio.checked = true;
  const settings = moshSettingsForClip(clip);
  activeMoshFps = settings.fps;
  activeMoshMaximum = Math.max(1, settings.maximumFrames);
  transitionDuration.min = '1';
  transitionDuration.max = String(activeMoshMaximum);
  transitionDuration.step = '1';
  transitionDuration.disabled = settings.maximumFrames < 1;
  transitionDuration.value = String(settings.durationFrames > 0 ? settings.durationFrames : activeMoshMaximum);
  transitionEnding.value = settings.ending;
  transitionDurationMode.textContent = clip.moshDurationFrames === undefined || clip.moshDurationFrames === null
    ? 'full length'
    : 'custom';
  activeRandomSeed = clip.randomSeed ?? null;
  updateTransitionSeedDisplay();
  updateTransitionDurationDisplay(false);
  setEffectParameterControl(method, clip);
  setResetPulseControls(method, clip);
  transitionTitle.textContent = `${clipDisplayLabel(boundaryIndex - 1)} → ${clipDisplayLabel(boundaryIndex)}`;
  updateTransitionOptionsVisibility();
  transitionDialog.showModal();
}

for (const radio of transitionDialog.querySelectorAll('input[name="transition-method"]')) {
  radio.addEventListener('change', () => {
    clearRandomSeed();
    if (clips[activeBoundary]?.transition !== radio.value) {
      transitionEnding.value = radio.value === 'melt' || radio.value === 'loop' ? 'continue' : 'restore';
    }
    updateTransitionOptionsVisibility();
    setEffectParameterControl(radio.value, clips[activeBoundary]);
    setResetPulseControls(radio.value, clips[activeBoundary]);
  });
}
effectParameter.addEventListener('input', () => {
  clearRandomSeed();
  updateEffectParameterDisplay();
});
resetInterval.addEventListener('input', () => {
  clearRandomSeed();
  updateResetPulseDisplay();
});
resetRepeat.addEventListener('input', () => {
  clearRandomSeed();
  updateResetPulseDisplay();
});
transitionDuration.addEventListener('input', () => {
  clearRandomSeed();
  updateTransitionDurationDisplay(true);
  updateResetIntervalLimit();
});
transitionEnding.addEventListener('change', () => {
  clearRandomSeed();
  transitionDurationMode.textContent = 'custom';
});
meltCadence.addEventListener('change', clearRandomSeed);

function generateRandomSeed() {
  const bytes = new Uint8Array(8);
  if (!globalThis.crypto?.getRandomValues) throw new Error('This browser cannot generate a secure random seed.');
  globalThis.crypto.getRandomValues(bytes);
  return [...bytes].map(value => value.toString(16).padStart(2, '0')).join('');
}

transitionRandomize.addEventListener('click', () => {
  const clip = clips[activeBoundary];
  if (!clip) return;
  try {
    const settings = randomizeTransition({
      seed: generateRandomSeed(),
      availableFrames: activeMoshMaximum,
      fps: activeMoshFps,
      methods: randomMethodsForClip(clip),
    });
    const radio = transitionDialog.querySelector(`input[name="transition-method"][value="${settings.method}"]`);
    if (!radio) throw new Error(`Randomized method ${settings.method} is unavailable.`);
    radio.checked = true;
    const randomizedClip = {
      ...clip,
      transition: settings.method,
      moshDurationFrames: settings.durationFrames,
      moshEnding: settings.ending,
      meltRepeat: settings.repeat ?? clip.meltRepeat,
      loopFrames: settings.loopFrames ?? clip.loopFrames,
      resetInterval: settings.resetInterval ?? clip.resetInterval,
      resetRepeat: settings.repeat ?? clip.resetRepeat,
    };
    updateTransitionOptionsVisibility();
    setEffectParameterControl(settings.method, randomizedClip);
    setResetPulseControls(settings.method, randomizedClip);
    if (settings.method === 'melt') meltCadence.value = 'original';
    transitionDuration.value = String(settings.durationFrames);
    transitionEnding.value = settings.ending;
    activeRandomSeed = settings.randomSeed;
    updateTransitionSeedDisplay();
    updateTransitionDurationDisplay(false);
    transitionDurationMode.textContent = 'randomized';
    updateEffectParameterDisplay();
    updateResetPulseDisplay();
    setError('');
  } catch (cause) {
    setError(cause instanceof Error ? cause.message : String(cause));
  }
});

transitionApply.addEventListener('click', event => {
  event.preventDefault();
  if (activeBoundary === null) return;
  const selected = transitionDialog.querySelector('input[name="transition-method"]:checked')?.value;
  if (!['cut', 'classic-mosh', 'melt', 'loop', 'reset-pulse'].includes(selected)) return;
  const current = clips[activeBoundary];
  const next = {
    ...current,
    transition: selected,
    ...(selected !== 'cut' ? {
      moshDurationFrames: Math.round(Number(transitionDuration.value)),
      moshEnding: transitionEnding.value,
    } : {}),
    ...(selected === 'melt' ? {
      meltRepeat: Math.round(Number(effectParameter.value)),
      meltSmooth: meltCadence.value === 'gentler',
    } : {}),
    ...(selected === 'loop' ? {
      loopFrames: Math.round(Number(effectParameter.value)),
    } : {}),
    ...(selected === 'reset-pulse' ? {
      resetInterval: Math.round(Number(resetInterval.value)),
      resetRepeat: Math.round(Number(resetRepeat.value)),
    } : {}),
    randomSeed: selected === 'cut' ? null : activeRandomSeed,
  };
  if (current.transition !== next.transition
    || current.moshDurationFrames !== next.moshDurationFrames
    || current.moshEnding !== next.moshEnding
    || current.meltRepeat !== next.meltRepeat
    || current.meltSmooth !== next.meltSmooth
    || current.loopFrames !== next.loopFrames
    || current.resetInterval !== next.resetInterval
    || current.resetRepeat !== next.resetRepeat
    || current.randomSeed !== next.randomSeed) {
    rememberState();
    clips = clips.map((clip, index) => index === activeBoundary ? next : clip);
  }
  transitionDialog.close('apply');
  if (selected === 'melt' || selected === 'loop' || selected === 'reset-pulse') normalizationAttempted = false;
  if (selected) refreshSequence();
});

transitionDialog.addEventListener('close', () => {
  activeBoundary = null;
  activeRandomSeed = null;
  updateTransitionSeedDisplay();
});

async function convertClipSource(index, label, sourceBytes, options, parseError = null) {
  const slot = progressSlot(index);
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

async function readClipFile(file, index, token) {
  const label = clipDisplayLabel(index);
  const slot = progressSlot(index);
  const sourceBytes = new Uint8Array(await file.arrayBuffer());
  let bytes = sourceBytes;
  let mp4;
  let conversion = null;

  try {
    mp4 = parseMp4(bytes);
  } catch (cause) {
    if (sourceBytes.byteLength > MAX_CONVERSION_BYTES) {
      throw new Error(`${label} is ${formatBytes(sourceBytes.byteLength)}; convert-on-load is limited to 100 MB.`);
    }
    const hevcCodec = cause.code === 'UNSUPPORTED_CODEC' && (cause.codec === 'hvc1' || cause.codec === 'hev1');
    let hevcFallbackReason = null;
    if (hevcCodec && isWebCodecsAvailable()) {
      try {
        const hevcMp4 = parseMp4(sourceBytes, {allowHevc: true});
        const target = chooseNormalizationTarget(hevcMp4.videoTrack);
        showConversion(label, 'loading WebCodecs HEVC', `Trying native HEVC decode at ${target.width}×${target.height}…`, null, slot);
        const result = await normalizeWithWebCodecs(sourceBytes, {
          target,
          onStatus: message => {
            if (token === importToken) showConversion(label, 'working', message, null, slot);
          },
          onProgress: progress => {
            if (token !== importToken) return;
            const percent = Math.round(progress * 100);
            showConversion(label, 'working', `WebCodecs HEVC · ${percent}%`, progress, slot);
          },
        });
        if (token !== importToken) return null;
        bytes = result.bytes;
        mp4 = parseMp4(bytes);
        conversion = {
          converted: true,
          engine: 'WebCodecs',
          decodeEngine: result.decoderEngine,
          encodeEngine: 'WebCodecs',
          sourceCodec: result.sourceCodec,
          inputBytes: sourceBytes.byteLength,
          outputBytes: bytes.byteLength,
          elapsedMs: result.elapsedMs,
          target,
          mode: 'converted',
          reason: 'hevc-webcodecs',
          sourceError: {code: cause.code ?? null, message: cause.message},
          decoderCodec: result.decoderCodec,
          encoderCodec: result.encoderCodec,
          fps: result.fps,
          outputSamples: result.outputSamples,
        };
      } catch (hevcCause) {
        if (token !== importToken) return null;
        hevcFallbackReason = hevcCause instanceof Error ? hevcCause.message : String(hevcCause);
      }
    }

    if (!mp4) {
      showConversion(label, 'loading ffmpeg.wasm', `“${hevcFallbackReason ?? cause.message}” Loading the local converter; this can take a while on the first file.`, null, slot);
      const converted = await convertClipSource(index, label, sourceBytes, {
        reason: hevcCodec ? 'hevc-webcodecs-fallback' : (cause.code ?? 'unparseable-input'),
        isCurrent: () => token === importToken,
      }, cause);
      if (!converted || token !== importToken) return null;
      bytes = converted.bytes;
      mp4 = converted.mp4;
      conversion = {
        ...converted.conversion,
        sourceCodec: hevcCodec ? 'HEVC' : null,
        hevcWebCodecsFallbackReason: hevcFallbackReason,
      };
    }
  }

  let audio;
  try {
    audio = await extractClipAudio(sourceBytes, mp4, label);
  } catch (cause) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    throw new Error(`${label} audio could not be prepared: ${detail}`);
  }

  return {
    file,
    bytes,
    mp4,
    baseBytes: bytes,
    baseMp4: mp4,
    baseAudio: audio,
    baseConversion: conversion,
    url: URL.createObjectURL(new Blob([bytes], {type: 'video/mp4'})),
    conversion,
    speed: 1,
    preparedSpeed: 1,
    speedReport: null,
    transition: 'classic-mosh',
    moshDurationFrames: null,
    moshEnding: 'restore',
    meltRepeat: 4,
    meltSmooth: false,
    loopFrames: 4,
    resetInterval: 12,
    resetRepeat: 4,
    randomSeed: null,
    audio,
  };
}

function looksLikeVideo(file) {
  return file.type.startsWith('video/') || /\.(mp4|mov|m4v|mkv|webm|avi)$/i.test(file.name);
}

async function importFiles(fileList) {
  const candidates = [...fileList].filter(looksLikeVideo);
  if (candidates.length === 0) {
    setError('Choose a video file or drop a supported video onto the timeline.');
    return;
  }
  const available = MAX_CLIPS - clips.length;
  if (available <= 0) {
    setError(`The timeline is limited to ${MAX_CLIPS} clips. Remove a clip before importing another.`);
    return;
  }
  const selected = candidates.slice(0, available);
  const overflow = candidates.length - selected.length;
  const token = ++importToken;
  const before = snapshotState();
  const baseIndex = clips.length;
  resetMerged();
  setError('');
  reportPanel.hidden = true;
  status.textContent = `Reading ${selected.length} clip${selected.length === 1 ? '' : 's'}…`;

  const settled = await Promise.allSettled(selected.map((file, offset) => readClipFile(file, baseIndex + offset, token)));
  if (token !== importToken) {
    for (const result of settled) {
      if (result.status === 'fulfilled' && result.value?.url) URL.revokeObjectURL(result.value.url);
    }
    return;
  }

  const loaded = settled.filter(result => result.status === 'fulfilled' && result.value).map(result => result.value);
  if (loaded.length > 0) {
    undoStack.push(before);
    if (undoStack.length > 50) undoStack.shift();
    redoStack = [];
    clips.push(...loaded);
    normalizationAttempted = false;
    updateHistoryButtons();
    await refreshSequence();
  } else {
    await refreshSequence();
  }

  const messages = settled.flatMap((result, index) => result.status === 'rejected'
    ? [`${selected[index]?.name ?? 'clip'}: ${result.reason instanceof Error ? result.reason.message : String(result.reason)}`]
    : []);
  if (overflow > 0) messages.push(`Only ${MAX_CLIPS} clips fit; ${overflow} extra file${overflow === 1 ? ' was' : 's were'} not imported.`);
  if (messages.length) {
    const existing = error.hidden ? '' : error.textContent;
    setError([existing, ...messages].filter(Boolean).join(' '));
  }
}

async function loadClipLegacy(slot, file) {
  const label = `Clip ${slot.toUpperCase()}`;
  status.textContent = `Reading ${file.name} as ${label}…`;
  await importFiles([file]);
}

function compatibleChecks(checks) {
  return checks.every(compatibility => compatibility.compatible);
}

function needsNormalization(checks) {
  return checks.some(compatibility => !compatibility.compatible || !compatibility.spsMatch);
}

function effectNormalizationBoundaries() {
  const failures = [];
  for (let index = 1; index < clips.length; index += 1) {
    const incoming = clips[index];
    if (!['melt', 'loop', 'reset-pulse'].includes(incoming.transition)) continue;
    const outgoing = clips[index - 1];
    const a = inspectEffectEligibility(outgoing.bytes, outgoing.mp4);
    const b = inspectEffectEligibility(incoming.bytes, incoming.mp4);
    if (!a.eligible || !b.eligible) {
      failures.push({
        boundaryIndex: index - 1,
        method: incoming.transition,
        outgoing: clipDisplayLabel(index - 1),
        incoming: clipDisplayLabel(index),
        a,
        b,
      });
    }
  }
  return failures;
}

function effectNormalizationError(failure) {
  const effects = failure.method === 'melt' ? 'Melt' : failure.method === 'loop' ? 'Loop Release' : 'Reset Pulse';
  return `${effects} needs clips without B-frames. Normalize this sequence first, or choose Cut/Classic Mosh.`;
}

async function checkSequenceCompatibility() {
  return Promise.all(clips.slice(1).map((clip, offset) => {
    const leftIndex = offset;
    return checkCompatibility(clips[leftIndex].bytes, clip.bytes, clips[leftIndex].mp4, clip.mp4);
  }));
}

async function mapWithConcurrency(items, limit, mapper) {
  const results = new Array(items.length);
  let nextIndex = 0;
  const worker = async () => {
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await mapper(items[index], index);
    }
  };
  await Promise.all(Array.from({length: Math.min(limit, items.length)}, worker));
  return results;
}

async function normalizeAllClips(token, target) {
  const originals = clips.map(clip => ({...clip}));
  let webcodecsFallbackReason = null;
  const speedPreparation = originals.some(clip => normalizeSpeed(clip.speed ?? 1) !== normalizeSpeed(clip.preparedSpeed ?? 1));
  if (speedPreparation && !isWebCodecsAvailable()) {
    throw new Error('Clip speed requires WebCodecs VideoDecoder and VideoEncoder for the one-pass frame mapping and re-encode.');
  }

  if (isWebCodecsAvailable() && (speedPreparation || originals.every(clip => !clip.conversion))) {
    try {
      for (const [index] of originals.entries()) setConversionProgress(null, progressSlot(index));
      showConversion(`${clips.length} clips`, 'normalizing', `Normalizing clips in parallel with WebCodecs to one ${target.width}×${target.height}, 30 fps H.264 layout…`, null);
      const normalized = await mapWithConcurrency(originals, 2, async (clip, index) => {
        if (token !== refreshToken) return null;
        if (clip.file.size > MAX_CONVERSION_BYTES) {
          throw new Error(`${clipDisplayLabel(index)} is ${formatBytes(clip.file.size)}; conversion is limited to 100 MB.`);
        }
        const label = clipDisplayLabel(index);
        const speed = normalizeSpeed(clip.speed ?? 1);
        const sourceBytes = clip.baseBytes ?? clip.bytes;
        showConversion(label, 'normalizing', `Applying ${speed.toFixed(1)}× speed and re-encoding ${clip.file.name} with WebCodecs at ${target.width}×${target.height}…`, null, progressSlot(index));
        const result = await normalizeWithWebCodecs(sourceBytes, {
          target,
          speed,
          onStatus: message => {
            if (token === refreshToken) showConversion(label, 'working', message, null, progressSlot(index));
          },
          onProgress: progress => {
            if (token !== refreshToken) return;
            const percent = Math.round(progress * 100);
            showConversion(label, 'working', `Normalizing with WebCodecs · ${percent}%`, progress, progressSlot(index));
          },
        });
        const audio = await applySpeedToClipAudio(clip.baseAudio ?? clip.audio, result.outputFrames, speed, label);
        return {result, sourceBytes: sourceBytes.byteLength, audio};
      });
      if (token !== refreshToken || normalized.some(item => !item)) return false;
      clips = originals.map((clip, index) => {
        const {result, sourceBytes, audio} = normalized[index];
        const mp4 = parseMp4(result.bytes);
        const speed = normalizeSpeed(clip.speed ?? 1);
        return {
          ...clip,
          bytes: result.bytes,
          mp4,
          audio,
          preparedSpeed: speed,
          speedReport: {
            speed,
            inputFrames: result.inputFrames,
            outputFrames: result.outputFrames,
            inputFps: result.sourceFps,
            outputFps: result.fps,
            audioFrames: audio.frames,
            audioSamples: audio.pcm ? audio.pcm.length / AUDIO_CHANNELS : 0,
            audioEngine: audio.speedEngine ?? null,
            donorIndexes: result.speedFramePlan?.donorIndexes ?? null,
          },
          conversion: {
            converted: true,
            engine: 'WebCodecs',
            decodeEngine: 'WebCodecs',
            encodeEngine: 'WebCodecs',
            hybrid: false,
            parallel: originals.length > 1,
            inputBytes: sourceBytes,
            outputBytes: result.bytes.byteLength,
            elapsedMs: result.elapsedMs,
            target: result.target,
            mode: 'normalized',
            reason: speedPreparation ? 'speed-normalization' : 'sequence-normalization',
            origin: clip.baseConversion ?? clip.conversion,
            sourceCodec: (clip.baseConversion ?? clip.conversion)?.sourceCodec ?? null,
            hevcWebCodecsFallbackReason: (clip.baseConversion ?? clip.conversion)?.hevcWebCodecsFallbackReason ?? null,
            decoderCodec: result.decoderCodec,
            encoderCodec: result.encoderCodec,
            fps: result.fps,
            keyframes: result.keyframes,
            outputSamples: result.outputSamples,
            speed: result.speed,
            inputFrames: result.inputFrames,
            outputFrames: result.outputFrames,
            frameAlignment: result.frameAlignment,
          },
        };
      });
      for (const [index] of originals.entries()) {
        clips[index].url = URL.createObjectURL(new Blob([clips[index].bytes], {type: 'video/mp4'}));
      }
      finishConversionPanel();
      return true;
    } catch (cause) {
      if (token !== refreshToken) return false;
      webcodecsFallbackReason = cause instanceof Error ? cause.message : String(cause);
      if (speedPreparation) {
        throw new Error(`Speed normalization failed in WebCodecs. ${webcodecsFallbackReason}`);
      }
      showConversion('WebCodecs', 'falling back', `${webcodecsFallbackReason} Loading the ffmpeg.wasm fallback…`, null);
    }
  }

  if (speedPreparation) throw new Error('Clip speed requires the WebCodecs normalization path; ffmpeg.wasm conversion cannot preserve the exact 30 fps speed mapping.');

  const converted = await Promise.all(originals.map(async (clip, index) => {
    if (token !== refreshToken) return null;
    if (clip.file.size > MAX_CONVERSION_BYTES) {
      throw new Error(`${clipDisplayLabel(index)} is ${formatBytes(clip.file.size)}; conversion is limited to 100 MB.`);
    }
    const label = clipDisplayLabel(index);
    const result = await convertClipSource(index, label, clip.bytes, {
      target,
      reason: 'sequence-normalization',
      isCurrent: () => token === refreshToken,
    }, clip.conversion?.sourceError ?? null);
    if (!result || token !== refreshToken) return null;
    return {
      ...clip,
      bytes: result.bytes,
      mp4: result.mp4,
      conversion: {
        ...result.conversion,
        reason: 'sequence-normalization',
        parallel: originals.length > 1,
        origin: clip.conversion,
        webcodecsFallbackReason,
      },
    };
  }));
  if (token !== refreshToken || converted.some(item => !item)) return false;
  clips = converted;
  for (const [index] of originals.entries()) {
    clips[index].url = URL.createObjectURL(new Blob([clips[index].bytes], {type: 'video/mp4'}));
  }
  finishConversionPanel();
  return true;
}

function videoSampleCountsForResult(result, clips) {
  const firstFrames = clips[0].mp4.videoTrack.samples.length;
  if (clips.length === 2) return [firstFrames, result.report.mergedSamples];
  return [firstFrames, ...result.report.boundaries.map(boundary => boundary.mergedSamples)];
}

async function addMergedAudio(result, clips) {
  const methods = clips.slice(1).map(clip => clip.transition === 'melt'
    ? {method: 'melt', dropFrames: 1}
    : clip.transition);
  const fps = frameRateForTrack(clips[0].mp4.videoTrack);
  const timeline = assembleAudioTimeline({
    clips: clips.map(clip => clip.audio ?? silentClipAudio(clip.mp4.videoTrack.samples.length)),
    methods,
    videoSampleCounts: videoSampleCountsForResult(result, clips),
    fps,
    sampleRate: AUDIO_SAMPLE_RATE,
    channels: AUDIO_CHANNELS,
  });
  const sourceClipReport = clips.map((clip, index) => ({
    index,
    source: clip.audio?.source ?? 'silence',
    decodeEngine: clip.audio?.decodeEngine ?? null,
    elapsedMs: clip.audio?.elapsedMs ?? 0,
    hasAudio: clip.audio?.hasAudio === true,
  }));
  if (!sourceClipReport.some(clip => clip.hasAudio)) {
    result.report.audio = {
      included: false,
      reason: 'all source clips are silent or have no audio track',
      frames: timeline.frames,
      expectedSamples: timeline.expectedSamples,
      sampleRate: AUDIO_SAMPLE_RATE,
      channels: AUDIO_CHANNELS,
      segments: timeline.segments,
      sources: sourceClipReport,
    };
    return result;
  }

  let fallbackReason = null;
  let muxed = null;
  let encodeEngine = null;
  let muxEngine = null;
  let encodeElapsedMs = 0;
  let encodedPackets = null;
  let timingInfo = null;
  if (isAudioEncoderAvailable()) {
    try {
      showConversion('Audio', 'encoding', `Encoding ${timeline.frames} frames of AAC-LC with WebCodecs…`);
      const started = performance.now();
      const aac = await encodeAacWithWebCodecs(timeline.pcm, timeline.expectedSamples, {
        sampleRate: timeline.sampleRate,
        channels: timeline.channels,
      });
      encodeElapsedMs = Math.round(performance.now() - started);
      const adts = buildAdts(aac, timeline.expectedSamples);
      encodedPackets = adts.packets;
      showConversion('Audio', 'muxing', 'Muxing the merged video and WebCodecs AAC with ffmpeg.wasm…');
      const mux = await muxAacWithFfmpeg(result.output, adts.bytes, timeline.expectedSamples, {
        onStatus: message => showConversion('Audio', 'muxing', message),
      });
      timingInfo = retimeMuxedAudio(mux.bytes, timeline.expectedSamples, timeline.sampleRate);
      muxed = timingInfo.bytes;
      encodeEngine = 'WebCodecs';
      muxEngine = mux.engine;
    } catch (cause) {
      fallbackReason = cause instanceof Error ? cause.message : String(cause);
      showConversion('Audio', 'falling back', `WebCodecs AAC failed; encoding PCM in ffmpeg.wasm. ${fallbackReason}`);
    }
  }

  if (!muxed) {
    const started = performance.now();
    const wav = wavBytes(timeline.pcm, timeline.expectedSamples, timeline.sampleRate, timeline.channels);
    const mux = await muxPcmWithFfmpeg(result.output, wav, timeline.expectedSamples, {
      onStatus: message => showConversion('Audio', 'encoding', message),
    });
    timingInfo = retimeMuxedAudio(mux.bytes, timeline.expectedSamples, timeline.sampleRate);
    muxed = timingInfo.bytes;
    encodeEngine = 'ffmpeg.wasm';
    muxEngine = mux.engine;
    encodeElapsedMs = Math.round(performance.now() - started);
  }

  let parsed;
  try {
    parsed = parseMp4(muxed);
  } catch (cause) {
    throw new RuntimeError(`Merged audio MP4 could not be validated: ${cause.message ?? cause}`);
  }
  const audioTrack = parsed.tracks.find(track => track.handler === 'soun' && track.complete);
  if (!audioTrack?.mdhd || !audioTrack.stts) throw new RuntimeError('Merged audio MP4 has no complete audio track.');
  const expectedDuration = timeline.expectedSamples / timeline.sampleRate;
  if (!timingInfo || timingInfo.presentationSamples !== timeline.expectedSamples
    || Math.abs(timingInfo.presentationDurationSeconds - expectedDuration) > 0.5 / timingInfo.movieTimescale) {
    throw new RuntimeError(`Merged audio presentation ${timingInfo?.presentationDurationSeconds ?? 'unknown'} s does not match expected ${expectedDuration.toFixed(6)} s.`);
  }

  result.output = muxed;
  result.report.outputBytes = muxed.byteLength;
  result.report.audio = {
    included: true,
    frames: timeline.frames,
    samplesPerFrame: timeline.samplesPerFrame,
    expectedSamples: timeline.expectedSamples,
    sampleRate: timeline.sampleRate,
    channels: timeline.channels,
    durationSeconds: expectedDuration,
    encodeEngine,
    muxEngine,
    encodeElapsedMs,
    encodedPackets,
    encodedSamples: timingInfo.encodedSamples,
    encoderDelaySamples: timingInfo.encoderDelaySamples,
    mediaEndSamples: timingInfo.mediaEndSamples,
    webcodecsFallbackReason: fallbackReason,
    segments: timeline.segments,
    sources: sourceClipReport,
    policy: 'audio follows the clip timeline; Classic Mosh, Loop and Reset Pulse drop one incoming frame; explicit-window Melt starts one frame in; extra picture-only frames are padded with silence',
  };
  finishConversionPanel();
  return result;
}

async function refreshSequence() {
  const token = ++refreshToken;
  resetMerged();
  setError('');
  renderSourceTiers();
  finishConversionPanel();
  updateHistoryButtons();

  if (clips.length === 0) {
    updateSingleClipState();
    return;
  }
  const speedPreparationNeeded = clips.some(clip => normalizeSpeed(clip.speed ?? 1) !== normalizeSpeed(clip.preparedSpeed ?? 1));
  if (speedPreparationNeeded) {
    const target = chooseNormalizationTarget(...clips.map(clip => ({
      width: clip.mp4.videoTrack.width,
      height: clip.mp4.videoTrack.height,
    })));
    status.textContent = `Applying clip speed at ${target.width}×${target.height}, 30 fps…`;
    report.textContent = JSON.stringify({
      stage: 'speed-normalizing',
      sources: sourcesReport(),
      target,
    }, null, 2);
    reportPanel.hidden = false;
    try {
      const normalized = await normalizeAllClips(token, target);
      if (!normalized || token !== refreshToken) return;
      normalizationAttempted = true;
      renderSourceTiers();
    } catch (cause) {
      if (token !== refreshToken) return;
      const detail = cause instanceof Error ? cause.message : String(cause);
      report.textContent = JSON.stringify({stage: 'speed-normalization-failed', error: detail, sources: sourcesReport()}, null, 2);
      status.textContent = 'Clip speed could not be prepared.';
      setError(shortErrorText(detail, 'Clip speed could not be prepared.'));
      return;
    }
  }
  if (clips.length === 1) {
    updateSingleClipState();
    return;
  }

  reportPanel.hidden = true;
  originalButton.textContent = 'A cut';
  originalButton.disabled = false;
  modifiedButton.disabled = true;
  exportButton.disabled = true;
  setPreview(clips[0].url, sourceCutLabel(), 'original');
  emptyPreview.hidden = true;
  status.textContent = 'Preparing the sequence…';

  let checks;
  try {
    checks = await checkSequenceCompatibility();
  } catch (cause) {
    if (token !== refreshToken) return;
    status.textContent = 'Clips loaded; compatibility could not be verified.';
    setError(cause instanceof Error ? cause.message : String(cause));
    return;
  }
  if (token !== refreshToken) return;

  let effectFailures = effectNormalizationBoundaries();
  if ((needsNormalization(checks) || effectFailures.length > 0) && !normalizationAttempted) {
    const target = chooseNormalizationTarget(...clips.map(clip => ({
      width: clip.mp4.videoTrack.width,
      height: clip.mp4.videoTrack.height,
    })));
    normalizationAttempted = true;
    report.textContent = JSON.stringify({
      stage: 'normalizing-sequence',
      sources: sourcesReport(),
      target,
      incompatibleBoundaries: checks.map((compatibility, offset) => ({boundaryIndex: offset, ...compatibilityReport(compatibility)}))
        .filter(item => !item.compatible),
      effectNormalizationBoundaries: effectFailures,
    }, null, 2);
    reportPanel.hidden = false;
    status.textContent = `Normalizing clips to ${target.width}×${target.height}…`;
    try {
      const normalized = await normalizeAllClips(token, target);
      if (!normalized || token !== refreshToken) return;
      checks = await checkSequenceCompatibility();
      effectFailures = effectNormalizationBoundaries();
    } catch (cause) {
      if (token !== refreshToken) return;
      report.textContent = JSON.stringify({
        stage: 'normalization-failed',
        sources: sourcesReport(),
        target,
        error: cause instanceof Error ? cause.message : String(cause),
      }, null, 2);
      showConversion('Conversion', 'failed', cause instanceof Error ? cause.message : String(cause));
      status.textContent = 'Could not prepare these clips for merging.';
      const detail = cause instanceof Error ? cause.message : String(cause);
      setError(shortErrorText(`Normalization failed. ${detail} Try shorter clips or matching H.264 settings.`, 'Normalization failed. Try shorter clips or matching H.264 settings.'));
      return;
    }
    if (token !== refreshToken) return;
  } else if (!compatibleChecks(checks) && normalizationAttempted) {
    const firstFailure = checks.find(compatibility => !compatibility.compatible);
    status.textContent = 'These clips cannot be merged automatically.';
    setError(compatibilityErrorText(firstFailure));
    return;
  }

  if (effectFailures.length > 0) {
    status.textContent = 'Melt/Loop needs normalized clips.';
    setError(effectNormalizationError(effectFailures[0]));
    return;
  }

  if (!compatibleChecks(checks)) {
    const firstFailure = checks.find(compatibility => !compatibility.compatible);
    status.textContent = 'These clips cannot be merged automatically.';
    setError(compatibilityErrorText(firstFailure));
    return;
  }

  status.textContent = 'Building the merged sequence…';
  setError('');
  try {
    let result;
    let pairCompatibility = null;
    if (clips.length === 2) {
      pairCompatibility = checks[0];
      const settings = moshSettingsForClip(clips[1]);
      const effect = effectSettingsForClip(clips[1]);
      if (clips[1].transition === 'cut') {
        result = await appendCutH264(clips[0].bytes, clips[1].bytes, clips[0].mp4, clips[1].mp4);
      } else if (effect) {
        result = await mergeEffectH264(clips[0].bytes, clips[1].bytes, clips[0].mp4, clips[1].mp4, effect);
      } else {
        result = await mergeMoshH264(clips[0].bytes, clips[1].bytes, clips[0].mp4, clips[1].mp4, {
          durationFrames: settings.durationFrames,
          ending: settings.ending,
        });
      }
    } else {
      result = await mergeSequenceH264(
        clips.map(clip => ({bytes: clip.bytes, parsed: clip.mp4})),
        clips.slice(1).map(clip => {
          if (clip.transition === 'cut') return {method: 'cut'};
          const effect = effectSettingsForClip(clip);
          if (effect) return effect;
          const settings = moshSettingsForClip(clip);
          return {method: 'classic-mosh', durationFrames: settings.durationFrames, ending: settings.ending};
        }),
      );
    }
    if (token !== refreshToken) return;
    result = await addMergedAudio(result, clips);
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
    const audioLabel = result.report.audio?.included ? 'video + AAC audio' : 'video only';
    status.textContent = `${clips.length} clips · ${result.report.mergedSamples} samples · ${result.report.mergedDurationSeconds.toFixed(2)} s · ${audioLabel}`;
    report.textContent = JSON.stringify({
      stage: 'merged',
      sources: sourcesReport(),
      normalization: sequenceNormalizationReport(),
      compatibility: pairCompatibility ? compatibilityReport(pairCompatibility) : {
        compatible: true,
        boundaries: checks.map(compatibilityReport),
      },
      transitions: clips.slice(1).map((clip, offset) => {
        const settings = clip.transition === 'cut' ? null : moshSettingsForClip(clip);
        const effect = effectSettingsForClip(clip);
        return {
          boundaryIndex: offset,
          method: clip.transition,
          speed: Number(clip.speed ?? 1),
          input_frames: clip.baseMp4?.videoTrack.samples.length ?? clip.mp4.videoTrack.samples.length,
          output_frames: clip.mp4.videoTrack.samples.length,
          durationFrames: settings?.durationFrames ?? null,
          durationSeconds: settings?.durationSeconds ?? null,
          ending: settings?.ending ?? null,
          repeat: effect?.repeat ?? null,
          smooth: effect?.smooth ?? false,
          loopFrames: effect?.loopFrames ?? null,
          resetInterval: effect?.resetInterval ?? null,
          resetRepeat: effect?.repeat ?? null,
          random_seed: clip.randomSeed ?? null,
        };
      }),
      merge: result.report,
      cutByteIdentical: result.cut.byteLength === clips[0].bytes.byteLength
        && result.cut.every((value, index) => value === clips[0].bytes[index]),
    }, null, 2);
    reportPanel.hidden = false;
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

inputA.addEventListener('change', () => {
  const files = [...inputA.files];
  inputA.value = '';
  if (files.length) importFiles(files);
});
inputB.addEventListener('change', () => {
  const [file] = inputB.files;
  inputB.value = '';
  if (file) loadClipLegacy('b', file);
});
originalButton.addEventListener('click', () => showVersion('original'));
modifiedButton.addEventListener('click', () => showVersion('merged'));
undoButton.addEventListener('click', undoTimeline);
redoButton.addEventListener('click', redoTimeline);

for (const eventName of ['dragenter', 'dragover']) {
  dropZone.addEventListener(eventName, event => {
    event.preventDefault();
    dropZone.classList.add('is-dragging');
  });
}
dropZone.addEventListener('dragleave', event => {
  if (!dropZone.contains(event.relatedTarget)) dropZone.classList.remove('is-dragging');
});
dropZone.addEventListener('drop', event => {
  event.preventDefault();
  dropZone.classList.remove('is-dragging');
  if (event.dataTransfer.files.length) importFiles(event.dataTransfer.files);
});
window.addEventListener('dragover', event => event.preventDefault());
window.addEventListener('drop', event => event.preventDefault());

updateHistoryButtons();
updateSingleClipState();
document.documentElement.dataset.appReady = 'true';

window.addEventListener('beforeunload', () => {
  const urls = new Set(clips.map(clip => clip.url).filter(Boolean));
  if (merged?.cutUrl) urls.add(merged.cutUrl);
  if (merged?.mergedUrl) urls.add(merged.mergedUrl);
  for (const url of urls) URL.revokeObjectURL(url);
});

if ('serviceWorker' in navigator) {
  window.addEventListener('load', async () => {
    try {
      await navigator.serviceWorker.register('./sw.js');
    } catch {}
  });
}
