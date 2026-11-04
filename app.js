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
import { LOOKS, normalizeLook, normalizationCacheKey } from './looks.js';
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
const conversionProgress = document.querySelector('#conversion-progress');
const conversionStatus = document.querySelector('#conversion-status');
const assemblePreviewButton = document.querySelector('#assemble-preview');
const exportButton = document.querySelector('#export-button');
const previewLabel = document.querySelector('#preview-label');
const previewTime = document.querySelector('#preview-time');
const soundToggle = document.querySelector('#sound-toggle');
const projectName = document.querySelector('#project-name');
const AUDIO_PREFERENCE_KEY = 'm4shlab-audio';
const PROJECT_NAME_KEY = 'm4shlab-project';
const DEFAULT_PROJECT_NAME = 'Project';
const DEFAULT_EXPORT_FILENAME = 'm4shlab-merge.mp4';
const report = document.querySelector('#report');
const undoButton = document.querySelector('#undo-button');
const redoButton = document.querySelector('#redo-button');
const coarsePointerQuery = window.matchMedia('(pointer: coarse)');
const transitionDialog = document.querySelector('#transition-dialog');
const transitionSubtitle = document.querySelector('#transition-subtitle');
const transitionMethod = document.querySelector('#transition-method');
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
let nextClipId = 1;
let draggedClipId = null;
let importInFlight = 0;
let importSkeletons = [];
let previewedClipId = null;
let previewAssembled = false;
let conversionTotal = 0;
let conversionFinished = 0;
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
let refreshInFlight = 0;
let soundEnabled = readSoundPreference();
let projectNameSaveTimer = null;

function readSoundPreference() {
  try {
    return localStorage.getItem(AUDIO_PREFERENCE_KEY) !== 'false';
  } catch {
    return true;
  }
}

function writeSoundPreference() {
  try {
    localStorage.setItem(AUDIO_PREFERENCE_KEY, String(soundEnabled));
  } catch {}
}

function applySoundPreference() {
  soundToggle.checked = soundEnabled;
  video.muted = !soundEnabled;
}

function readProjectName() {
  try {
    return (localStorage.getItem(PROJECT_NAME_KEY) ?? DEFAULT_PROJECT_NAME).slice(0, 60);
  } catch {
    return DEFAULT_PROJECT_NAME;
  }
}

function saveProjectName() {
  if (!projectName) return;
  if (projectNameSaveTimer !== null) {
    clearTimeout(projectNameSaveTimer);
    projectNameSaveTimer = null;
  }
  try {
    localStorage.setItem(PROJECT_NAME_KEY, projectName.value);
  } catch {}
}

function scheduleProjectNameSave() {
  if (!projectName) return;
  if (projectNameSaveTimer !== null) clearTimeout(projectNameSaveTimer);
  projectNameSaveTimer = setTimeout(saveProjectName, 250);
}

function autoSizeProjectName() {
  if (!projectName) return;
  projectName.size = Math.min(18, Math.max(7, projectName.value.length || 1));
}

function projectExportFilename() {
  const trimmed = (projectName?.value ?? DEFAULT_PROJECT_NAME).trim();
  if (!trimmed || trimmed === DEFAULT_PROJECT_NAME) return DEFAULT_EXPORT_FILENAME;
  const sanitized = trimmed
    .replace(/[\u0000-\u001f\u007f\/\\:*?"<>|]/g, '')
    .replace(/\s+/g, '-');
  return sanitized ? `${sanitized}.mp4` : DEFAULT_EXPORT_FILENAME;
}

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

function clipReport(clip, index) {
  if (!clip) return null;
  return {
    index,
    name: clip.file.name,
    tier: clip.conversion ? 'tier-2' : 'tier-1',
    mode: clipMode(clip),
    path: conversionPath(clip),
    speed: Number(clip.speed ?? 1),
    look: normalizeLook(clip.look ?? 'original'),
    preparedLook: normalizeLook(clip.preparedLook ?? 'original'),
    lookReport: clip.lookReport ? {...clip.lookReport} : null,
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
      smooth: clip.loopSmooth === true,
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

function beginConversionProgress(total = clips.length) {
  conversionTotal = Math.max(1, Number(total) || 1);
  conversionFinished = 0;
}

function updateConversionStatus(label = 'clips') {
  if (/audio/i.test(label)) {
    conversionStatus.textContent = 'preparing audio…';
    return;
  }
  conversionStatus.textContent = `normalizing clips… ${Math.min(conversionFinished, conversionTotal)} of ${conversionTotal}`;
}

function showConversion(label, state) {
  conversionProgress.hidden = false;
  if (state === 'failed') conversionStatus.textContent = 'conversion failed';
  else updateConversionStatus(label);
}

function advanceConversionProgress() {
  conversionFinished = Math.min(conversionTotal, conversionFinished + 1);
  if (!conversionProgress.hidden) updateConversionStatus();
}

function progressSlot(index) {
  return index === 0 ? 'a' : index === 1 ? 'b' : null;
}

function clipDragAllowed() {
  return refreshInFlight === 0 && importInFlight === 0 && !coarsePointerQuery.matches && navigator.maxTouchPoints === 0;
}

function clearDropTargets() {
  for (const card of sourceTiers.querySelectorAll('.clip-card.drop-target:not(.clip-skeleton)')) {
    card.classList.remove('drop-target');
  }
}

function isClipReorderTransfer(dataTransfer) {
  const types = [...(dataTransfer?.types ?? [])];
  return types.includes('text/plain') && !types.includes('Files');
}

function syncClipDragState() {
  const allowed = clipDragAllowed();
  for (const card of sourceTiers.querySelectorAll('.clip-card:not(.clip-skeleton)')) {
    card.draggable = allowed;
    if (!allowed) card.classList.remove('dragging');
  }
  if (!allowed) clearDropTargets();
}

function wireClipDrag(card, clip, index) {
  card.dataset.clipId = clip.id;
  card.draggable = clipDragAllowed();

  card.addEventListener('dragstart', event => {
    if (!card.draggable || !clipDragAllowed() || (event.target instanceof Element
      && event.target.closest('button, input, select, label, a'))) {
      event.preventDefault();
      return;
    }
    draggedClipId = clip.id;
    card.classList.add('dragging');
    event.dataTransfer.effectAllowed = 'move';
    event.dataTransfer.setData('text/plain', clip.id);
  });

  card.addEventListener('dragover', event => {
    if (!draggedClipId || !card.draggable) return;
    const sourceIndex = clips.findIndex(item => item.id === draggedClipId);
    if (sourceIndex < 0 || sourceIndex === index) {
      card.classList.remove('drop-target');
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    event.dataTransfer.dropEffect = 'move';
    clearDropTargets();
    card.classList.add('drop-target');
  });

  card.addEventListener('dragleave', event => {
    if (!card.contains(event.relatedTarget)) card.classList.remove('drop-target');
  });

  card.addEventListener('drop', event => {
    const sourceId = event.dataTransfer?.getData('text/plain') || draggedClipId;
    const sourceIndex = clips.findIndex(item => item.id === sourceId);
    event.preventDefault();
    event.stopPropagation();
    card.classList.remove('drop-target');
    clearDropTargets();
    draggedClipId = null;
    if (sourceIndex < 0 || sourceIndex === index) return;

    const rect = card.getBoundingClientRect();
    const insertionIndex = index + (event.clientX >= rect.left + rect.width / 2 ? 1 : 0);
    const destination = insertionIndex > sourceIndex ? insertionIndex - 1 : insertionIndex;
    if (destination !== sourceIndex) moveClip(sourceIndex, destination);
  });

  card.addEventListener('dragend', () => {
    draggedClipId = null;
    card.classList.remove('dragging');
    clearDropTargets();
  });
}

function renderClipCard(index, clip) {
  const card = document.createElement('article');
  card.className = 'clip-card';
  card.dataset.clipIndex = String(index);

  const thumb = document.createElement('div');
  thumb.className = 'clip-thumb';
  const preview = document.createElement('video');
  preview.muted = true;
  preview.playsInline = true;
  preview.preload = 'metadata';
  preview.setAttribute('aria-hidden', 'true');
  preview.addEventListener('loadeddata', () => preview.classList.add('is-ready'), {once: true});
  preview.src = `${clip.url}#t=0.001`;
  thumb.append(preview);

  const name = document.createElement('span');
  name.className = 'clip-name';
  name.textContent = clip.file.name;
  name.title = clip.file.name;

  const detail = document.createElement('span');
  detail.className = 'clip-detail';
  const duration = clipDurationSeconds(clip);
  detail.textContent = duration === null ? 'video' : `${duration.toFixed(2)} s`;

  const lookControl = document.createElement('label');
  lookControl.className = 'clip-look';
  const lookLabel = document.createElement('span');
  lookLabel.textContent = 'look';
  const lookSelect = document.createElement('select');
  lookSelect.id = `clip-look-${index}`;
  lookSelect.setAttribute('aria-label', `${clipDisplayLabel(index)} look`);
  for (const look of LOOKS) {
    const option = document.createElement('option');
    option.value = look.value;
    option.textContent = look.label;
    lookSelect.append(option);
  }
  lookSelect.value = normalizeLook(clip.look ?? 'original');
  lookSelect.disabled = refreshInFlight > 0;
  lookSelect.addEventListener('change', () => setClipLook(index, lookSelect.value));
  lookLabel.htmlFor = lookSelect.id;
  lookControl.append(lookLabel, lookSelect);

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

  card.tabIndex = 0;
  card.setAttribute('aria-label', `Preview ${clip.file.name}`);
  card.addEventListener('click', event => {
    if (event.target instanceof Element && event.target.closest('button, input, select, label, a')) return;
    previewClip(index);
  });
  card.addEventListener('keydown', event => {
    if (event.target !== card || (event.key !== 'Enter' && event.key !== ' ')) return;
    event.preventDefault();
    previewClip(index);
  });
  if (!previewAssembled && clip.id === previewedClipId) {
    card.classList.add('is-previewing');
    card.setAttribute('aria-current', 'true');
  }

  card.append(thumb, name, detail, lookControl, speedControl, controls);
  wireClipDrag(card, clip, index);
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
    duration.textContent = `${effect.durationSeconds.toFixed(2)} s · ${effect.ending}`;
  } else if (incoming.transition === 'loop') {
    const effect = effectSettingsForClip(incoming);
    duration.textContent = `${effect.durationSeconds.toFixed(2)} s · ${effect.loopFrames}f`;
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

function renderSkeletonCard(skeleton) {
  const card = document.createElement('article');
  card.className = 'clip-card clip-skeleton';
  card.dataset.importIndex = String(skeleton.index);
  card.setAttribute('aria-busy', 'true');
  card.setAttribute('aria-label', `Preparing ${skeleton.file.name}`);

  const thumb = document.createElement('div');
  thumb.className = 'clip-thumb skeleton-thumb';
  const shimmer = document.createElement('span');
  shimmer.className = 'skeleton-shimmer';
  shimmer.setAttribute('aria-hidden', 'true');
  thumb.append(shimmer);

  const name = document.createElement('span');
  name.className = 'clip-name';
  name.textContent = skeleton.file.name;
  name.title = skeleton.file.name;

  const detail = document.createElement('span');
  detail.className = 'clip-detail skeleton-status';
  detail.textContent = skeleton.status;
  detail.setAttribute('aria-live', 'polite');

  const lookControl = document.createElement('label');
  lookControl.className = 'clip-look';
  lookControl.setAttribute('aria-hidden', 'true');
  const lookLabel = document.createElement('span');
  lookLabel.textContent = 'look';
  const lookSelect = document.createElement('select');
  lookSelect.disabled = true;
  lookSelect.tabIndex = -1;
  const lookOption = document.createElement('option');
  lookOption.textContent = 'Original';
  lookSelect.append(lookOption);
  lookControl.append(lookLabel, lookSelect);

  const speedControl = document.createElement('div');
  speedControl.className = 'clip-speed';
  speedControl.setAttribute('aria-hidden', 'true');
  const speedHeading = document.createElement('div');
  speedHeading.className = 'clip-speed-heading';
  const speedLabel = document.createElement('span');
  speedLabel.textContent = 'speed';
  const speedOutput = document.createElement('output');
  speedOutput.textContent = '1.0×';
  const speedReset = document.createElement('button');
  speedReset.type = 'button';
  speedReset.textContent = 'Reset';
  speedReset.disabled = true;
  speedHeading.append(speedLabel, speedOutput, speedReset);
  const speedRange = document.createElement('input');
  speedRange.type = 'range';
  speedRange.min = String(SPEED_MIN);
  speedRange.max = String(SPEED_MAX);
  speedRange.step = String(SPEED_STEP);
  speedRange.value = '1.0';
  speedRange.disabled = true;
  speedRange.tabIndex = -1;
  speedControl.append(speedHeading, speedRange);

  const controls = document.createElement('div');
  controls.className = 'clip-controls';
  controls.setAttribute('aria-hidden', 'true');
  for (const glyph of ['←', '→', '×']) {
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = glyph;
    button.disabled = true;
    button.tabIndex = -1;
    controls.append(button);
  }

  card.append(thumb, name, detail, lookControl, speedControl, controls);
  return card;
}

function updateImportSkeleton(token, index, status) {
  const skeleton = importSkeletons.find(item => item.token === token && item.index === index);
  if (!skeleton) return;
  skeleton.status = status;
  const statusNode = sourceTiers.querySelector(`.clip-skeleton[data-import-index="${index}"] .skeleton-status`);
  if (statusNode) statusNode.textContent = status;
}

function renderSourceTiers() {
  const nodes = [];
  clips.forEach((clip, index) => {
    if (index > 0) nodes.push(renderConnector(index));
    nodes.push(renderClipCard(index, clip));
  });
  for (const skeleton of importSkeletons) nodes.push(renderSkeletonCard(skeleton));
  if (nodes.length === 0) {
    const empty = document.createElement('p');
    empty.className = 'timeline-empty';
    empty.textContent = 'Import up to 12 clips to build a sequence.';
    sourceTiers.replaceChildren(empty);
    sequenceLabel.textContent = '0 clips';
    sourceTiers.hidden = false;
    return;
  }
  sourceTiers.replaceChildren(...nodes);
  sourceTiers.hidden = false;
  syncClipDragState();
  sequenceLabel.textContent = `${clips.length} clip${clips.length === 1 ? '' : 's'}`;
}

function finishConversionPanel() {
  conversionProgress.hidden = true;
  conversionStatus.textContent = 'normalizing clips…';
}

function sequenceNormalizationReport() {
  const conversions = clips.map(clip => clip.conversion).filter(Boolean);
  if (conversions.length === 0) return null;
  const reasons = new Set(['sequence-normalization', 'pair-normalization', 'speed-normalization', 'look-normalization', 'speed-look-normalization']);
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

function formatPreviewTime(value) {
  return Number.isFinite(value) && value >= 0 ? value.toFixed(2) : '0.00';
}

function updatePreviewTime() {
  const current = Number.isFinite(video.currentTime) ? video.currentTime : 0;
  const duration = Number.isFinite(video.duration) ? video.duration : 0;
  previewTime.textContent = `${formatPreviewTime(current)} / ${formatPreviewTime(duration)} s`;
}

video.addEventListener('timeupdate', updatePreviewTime);
video.addEventListener('durationchange', updatePreviewTime);
video.addEventListener('loadedmetadata', updatePreviewTime);
video.addEventListener('emptied', () => { previewTime.textContent = '0.00 / 0.00 s'; });

video.addEventListener('error', () => {
  if (!video.getAttribute('src')) return;
  setError(`Preview failed: ${videoErrorText()}`);
  status.textContent = 'The selected preview did not decode in this browser.';
});

video.addEventListener('loadeddata', () => {
  emptyPreview.hidden = true;
});

function updatePreviewSelection() {
  for (const card of sourceTiers.querySelectorAll('.clip-card:not(.clip-skeleton)')) {
    const selected = !previewAssembled && card.dataset.clipId === previewedClipId;
    card.classList.toggle('is-previewing', selected);
    if (selected) card.setAttribute('aria-current', 'true');
    else card.removeAttribute('aria-current');
  }
  assemblePreviewButton.setAttribute('aria-pressed', String(previewAssembled));
}

function resetMerged() {
  if (merged?.cutUrl) URL.revokeObjectURL(merged.cutUrl);
  if (merged?.mergedUrl) URL.revokeObjectURL(merged.mergedUrl);
  merged = null;
  previewAssembled = false;
  assemblePreviewButton.disabled = true;
  exportButton.disabled = true;
  exportButton.onclick = null;
}

function setPreview(url, label) {
  previewTime.textContent = '0.00 / 0.00 s';
  video.muted = !soundEnabled;
  if (!url) {
    video.removeAttribute('src');
    video.load();
    previewLabel.textContent = '—';
    return;
  }
  video.src = url;
  previewLabel.textContent = label;
}

function clipPreviewLabel(index = 0) {
  const clip = clips[index];
  return clip ? `Clip preview · ${clip.file.name}` : '—';
}

function assembledPreviewLabel() {
  return 'Assembled preview · all clips and transitions';
}

function previewClip(index) {
  const clip = clips[index];
  if (!clip) return;
  setError('');
  previewedClipId = clip.id;
  previewAssembled = false;
  setPreview(clip.url, clipPreviewLabel(index));
  updatePreviewSelection();
}

function previewAssembledSequence() {
  if (!merged) return;
  setError('');
  previewAssembled = true;
  setPreview(merged.mergedUrl, assembledPreviewLabel());
  updatePreviewSelection();
}

function updateSingleClipState() {
  resetMerged();
  renderSourceTiers();
  finishConversionPanel();
  assemblePreviewButton.disabled = true;

  if (clips.length === 1) {
    previewClip(0);
    emptyPreview.hidden = true;
    report.textContent = JSON.stringify({stage: 'source', sources: sourcesReport()}, null, 2);
    status.textContent = `${clips[0].file.name} loaded as clip A · add another clip to create a transition.`;
  } else {
    previewedClipId = null;
    previewAssembled = false;
    setPreview(null);
    updatePreviewSelection();
    report.textContent = '';
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

function setClipLook(index, value) {
  if (index < 0 || index >= clips.length) return;
  let look;
  try {
    look = normalizeLook(value);
  } catch (cause) {
    setError(cause instanceof Error ? cause.message : String(cause));
    return;
  }
  if (normalizeLook(clips[index].look ?? 'original') === look) return;
  rememberState();
  clips = clips.map((clip, clipIndex) => clipIndex === index ? {...clip, look} : clip);
  normalizationAttempted = false;
  setError('');
  refreshSequence();
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
  const method = transitionMethod.value;
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
  const method = transitionMethod.value;
  classicMoshOptions.hidden = method === 'cut';
  nalEffectOptions.hidden = method !== 'melt' && method !== 'loop';
  meltCadenceControl.hidden = method !== 'melt' && method !== 'loop';
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
  const method = transitionMethod.value;
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
    const loop = effectSettingsForClip({...clip, transition: 'loop'});
    effectParameter.value = String(loop.loopFrames);
    meltCadence.value = loop.smooth ? 'gentler' : 'original';
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
  transitionMethod.value = method;
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
  transitionSubtitle.textContent = `${clips[boundaryIndex - 1].file.name} → ${clips[boundaryIndex].file.name}`;
  updateTransitionOptionsVisibility();
  transitionDialog.showModal();
}

transitionMethod.addEventListener('change', () => {
  clearRandomSeed();
  const method = transitionMethod.value;
  if (clips[activeBoundary]?.transition !== method) {
    transitionEnding.value = method === 'melt' || method === 'loop' ? 'continue' : 'restore';
  }
  updateTransitionOptionsVisibility();
  setEffectParameterControl(method, clips[activeBoundary]);
  setResetPulseControls(method, clips[activeBoundary]);
});
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
    if (![...transitionMethod.options].some(option => option.value === settings.method)) {
      throw new Error(`Randomized method ${settings.method} is unavailable.`);
    }
    transitionMethod.value = settings.method;
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
    if (settings.method === 'melt' || settings.method === 'loop') meltCadence.value = 'original';
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
  const selected = transitionMethod.value;
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
      loopSmooth: meltCadence.value === 'gentler',
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
    || current.loopSmooth !== next.loopSmooth
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
  const reportStatus = options.onImportStatus ?? (() => {});
  const converted = await convertToH264(sourceBytes, {
    target: options.target ?? null,
    onStatus: message => {
      if (!options.isCurrent()) return;
      showConversion(label, 'working', message, null, slot);
      reportStatus('converting…');
    },
    onProgress: progress => {
      if (!options.isCurrent()) return;
      const percent = progress.progress === null ? null : Math.round(progress.progress * 100);
      showConversion(label, 'working', percent === null ? 'Preparing H.264 conversion…' : `Converting with ffmpeg.wasm · ${percent}%`, progress.progress, slot);
      reportStatus(percent === null ? 'converting…' : `converting… ${percent} %`);
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

async function readClipFile(file, index, token, onImportStatus = () => {}) {
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
            if (token !== importToken) return;
            showConversion(label, 'working', message, null, slot);
            onImportStatus('converting…');
          },
          onProgress: progress => {
            if (token !== importToken) return;
            const percent = Math.round(progress * 100);
            showConversion(label, 'working', `WebCodecs HEVC · ${percent}%`, progress, slot);
            onImportStatus(`converting… ${percent} %`);
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
        advanceConversionProgress();
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
        onImportStatus,
      }, cause);
      if (!converted || token !== importToken) return null;
      bytes = converted.bytes;
      mp4 = converted.mp4;
      conversion = {
        ...converted.conversion,
        sourceCodec: hevcCodec ? 'HEVC' : null,
        hevcWebCodecsFallbackReason: hevcFallbackReason,
      };
      advanceConversionProgress();
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
    id: `clip-${nextClipId++}`,
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
    look: 'original',
    preparedLook: 'original',
    lookReport: null,
    transition: 'classic-mosh',
    moshDurationFrames: null,
    moshEnding: 'restore',
    meltRepeat: 4,
    meltSmooth: false,
    loopFrames: 4,
    loopSmooth: false,
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
  importInFlight += 1;
  syncClipDragState();
  try {
    return await importFilesInternal(fileList);
  } finally {
    importInFlight -= 1;
    syncClipDragState();
  }
}

async function importFilesInternal(fileList) {
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
  beginConversionProgress(selected.length);
  const before = snapshotState();
  const baseIndex = clips.length;
  resetMerged();
  setError('');
  status.textContent = `Reading ${selected.length} clip${selected.length === 1 ? '' : 's'}…`;
  importSkeletons = selected.map((file, index) => ({token, index, file, status: 'waiting'}));
  renderSourceTiers();

  const settled = await mapWithConcurrency(selected, 2, async (file, offset) => {
    updateImportSkeleton(token, offset, 'converting… 0 %');
    try {
      return {
        status: 'fulfilled',
        value: await readClipFile(file, baseIndex + offset, token, status => {
          updateImportSkeleton(token, offset, status);
        }),
      };
    } catch (reason) {
      return {status: 'rejected', reason};
    }
  });
  if (token !== importToken) {
    for (const result of settled) {
      if (result.status === 'fulfilled' && result.value?.url) URL.revokeObjectURL(result.value.url);
    }
    return;
  }

  importSkeletons = [];
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
  beginConversionProgress(originals.length);
  let webcodecsFallbackReason = null;
  const speedPreparation = originals.some(clip => normalizeSpeed(clip.speed ?? 1) !== normalizeSpeed(clip.preparedSpeed ?? 1));
  const lookPreparation = originals.some(clip => normalizeLook(clip.look ?? 'original') !== normalizeLook(clip.preparedLook ?? 'original'));
  const renderPreparation = speedPreparation || lookPreparation;
  if (renderPreparation && !isWebCodecsAvailable()) {
    const requirement = speedPreparation && lookPreparation ? 'Clip speed and looks' : speedPreparation ? 'Clip speed' : 'Clip looks';
    throw new Error(`${requirement} require WebCodecs VideoDecoder and VideoEncoder for the one-pass frame mapping, look, and re-encode.`);
  }

  if (isWebCodecsAvailable() && (renderPreparation || originals.every(clip => !clip.conversion))) {
    try {
      showConversion(`${clips.length} clips`, 'normalizing');
      const normalized = await mapWithConcurrency(originals, 2, async (clip, index) => {
        if (token !== refreshToken) return null;
        if (clip.file.size > MAX_CONVERSION_BYTES) {
          throw new Error(`${clipDisplayLabel(index)} is ${formatBytes(clip.file.size)}; conversion is limited to 100 MB.`);
        }
        const label = clipDisplayLabel(index);
        const speed = normalizeSpeed(clip.speed ?? 1);
        const look = normalizeLook(clip.look ?? 'original');
        const sourceBytes = clip.baseBytes ?? clip.bytes;
        const sourceKey = `${clip.file.name}:${clip.file.size}:${clip.file.lastModified}`;
        const cacheKey = normalizationCacheKey({sourceKey, target, speed, look});
        const lookText = look === 'original' ? 'original look' : `${look.replaceAll('-', ' ')} look`;
        showConversion(label, 'normalizing', `Applying ${speed.toFixed(1)}× speed and ${lookText}, then re-encoding ${clip.file.name} with WebCodecs at ${target.width}×${target.height}…`, null, progressSlot(index));
        const result = await normalizeWithWebCodecs(sourceBytes, {
          target,
          speed,
          look,
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
        advanceConversionProgress();
        return {result, sourceBytes: sourceBytes.byteLength, audio, cacheKey, sourceKey};
      });
      if (token !== refreshToken || normalized.some(item => !item)) return false;
      clips = originals.map((clip, index) => {
        const {result, sourceBytes, audio, cacheKey, sourceKey} = normalized[index];
        const mp4 = parseMp4(result.bytes);
        const speed = normalizeSpeed(clip.speed ?? 1);
        const look = normalizeLook(clip.look ?? 'original');
        const preparationReason = speedPreparation && lookPreparation
          ? 'speed-look-normalization'
          : speedPreparation ? 'speed-normalization' : lookPreparation ? 'look-normalization' : 'sequence-normalization';
        return {
          ...clip,
          bytes: result.bytes,
          mp4,
          audio,
          preparedSpeed: speed,
          preparedLook: look,
          lookReport: {
            look,
            cacheKey,
            sourceKey,
            encodePasses: 1,
          },
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
            reason: preparationReason,
            origin: clip.baseConversion ?? clip.conversion,
            sourceCodec: (clip.baseConversion ?? clip.conversion)?.sourceCodec ?? null,
            hevcWebCodecsFallbackReason: (clip.baseConversion ?? clip.conversion)?.hevcWebCodecsFallbackReason ?? null,
            decoderCodec: result.decoderCodec,
            encoderCodec: result.encoderCodec,
            fps: result.fps,
            keyframes: result.keyframes,
            outputSamples: result.outputSamples,
            speed: result.speed,
            look: result.look,
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
      if (renderPreparation) {
        throw new Error(`${speedPreparation && lookPreparation ? 'Speed and look' : speedPreparation ? 'Speed' : 'Look'} normalization failed in WebCodecs. ${webcodecsFallbackReason}`);
      }
      showConversion('WebCodecs', 'falling back', `${webcodecsFallbackReason} Loading the ffmpeg.wasm fallback…`, null);
    }
  }

  if (renderPreparation) throw new Error('Clip speed and looks require the WebCodecs normalization path; ffmpeg.wasm conversion cannot preserve the exact frame mapping and pixel-look pass.');

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

function syncRenderControlsBusy() {
  const busy = refreshInFlight > 0;
  for (const select of document.querySelectorAll('.clip-look select')) select.disabled = busy;
  soundToggle.disabled = busy;
  syncClipDragState();
}

async function refreshSequence() {
  refreshInFlight += 1;
  syncRenderControlsBusy();
  try {
    await refreshSequenceInternal();
  } finally {
    refreshInFlight -= 1;
    syncRenderControlsBusy();
  }
}

async function refreshSequenceInternal() {
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
  const lookPreparationNeeded = clips.some(clip => normalizeLook(clip.look ?? 'original') !== normalizeLook(clip.preparedLook ?? 'original'));
  if (speedPreparationNeeded || lookPreparationNeeded) {
    const target = chooseNormalizationTarget(...clips.map(clip => ({
      width: clip.mp4.videoTrack.width,
      height: clip.mp4.videoTrack.height,
    })));
    const preparationText = speedPreparationNeeded && lookPreparationNeeded ? 'clip speed and looks' : speedPreparationNeeded ? 'clip speed' : 'clip looks';
    status.textContent = `Applying ${preparationText} at ${target.width}×${target.height}, 30 fps…`;
    report.textContent = JSON.stringify({
      stage: 'render-normalizing',
      sources: sourcesReport(),
      target,
    }, null, 2);
    try {
      const normalized = await normalizeAllClips(token, target);
      if (!normalized || token !== refreshToken) return;
      normalizationAttempted = true;
      renderSourceTiers();
    } catch (cause) {
      if (token !== refreshToken) return;
      const detail = cause instanceof Error ? cause.message : String(cause);
      report.textContent = JSON.stringify({stage: 'render-normalization-failed', error: detail, sources: sourcesReport()}, null, 2);
      status.textContent = 'Clip speed or look could not be prepared.';
      setError(shortErrorText(detail, 'Clip speed or look could not be prepared.'));
      return;
    }
  }
  if (clips.length === 1) {
    updateSingleClipState();
    return;
  }

  assemblePreviewButton.disabled = true;
  exportButton.disabled = true;
  const preferredPreview = clips.findIndex(clip => clip.id === previewedClipId);
  previewClip(preferredPreview >= 0 ? preferredPreview : 0);
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
    if (soundEnabled) {
      result = await addMergedAudio(result, clips);
    } else {
      result.report.audio = {
        included: false,
        enabled: false,
        reason: 'sound toggle is off',
      };
    }
    result.report.audioEnabled = result.report.audio?.included === true;
    if (token !== refreshToken) return;
    const cutUrl = URL.createObjectURL(new Blob([result.cut], {type: 'video/mp4'}));
    const mergedUrl = URL.createObjectURL(new Blob([result.output], {type: 'video/mp4'}));
    merged = {result, cutUrl, mergedUrl};
    assemblePreviewButton.disabled = false;
    exportButton.disabled = false;
    exportButton.onclick = () => {
      const link = document.createElement('a');
      link.href = mergedUrl;
      link.download = projectExportFilename();
      link.click();
    };
    previewClip(clips.findIndex(clip => clip.id === previewedClipId) >= 0 ? clips.findIndex(clip => clip.id === previewedClipId) : 0);
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
          look: normalizeLook(clip.look ?? 'original'),
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
      audio: result.report.audio?.included === true,
      merge: result.report,
      cutByteIdentical: result.cut.byteLength === clips[0].bytes.byteLength
        && result.cut.every((value, index) => value === clips[0].bytes[index]),
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
for (const eventName of ['dragenter', 'dragover']) {
  dropZone.addEventListener(eventName, event => {
    if (isClipReorderTransfer(event.dataTransfer)) return;
    event.preventDefault();
    dropZone.classList.add('is-dragging');
  });
}
dropZone.addEventListener('dragleave', event => {
  if (!dropZone.contains(event.relatedTarget)) dropZone.classList.remove('is-dragging');
});
dropZone.addEventListener('drop', event => {
  if (isClipReorderTransfer(event.dataTransfer)) return;
  event.preventDefault();
  dropZone.classList.remove('is-dragging');
  if (event.dataTransfer.files.length) importFiles(event.dataTransfer.files);
});
window.addEventListener('dragover', event => event.preventDefault());
window.addEventListener('drop', event => event.preventDefault());
soundToggle.addEventListener('change', () => {
  soundEnabled = soundToggle.checked;
  writeSoundPreference();
  applySoundPreference();
  setError('');
  if (clips.length > 1) refreshSequence();
});
if (projectName) {
  projectName.addEventListener('input', () => {
    autoSizeProjectName();
    scheduleProjectNameSave();
  });
  projectName.addEventListener('change', saveProjectName);
  projectName.addEventListener('blur', saveProjectName);
}
assemblePreviewButton.addEventListener('click', previewAssembledSequence);
undoButton.addEventListener('click', undoTimeline);
redoButton.addEventListener('click', redoTimeline);
coarsePointerQuery.addEventListener?.('change', syncClipDragState);
window.addEventListener('resize', syncClipDragState);

applySoundPreference();
if (projectName) {
  projectName.value = readProjectName();
  autoSizeProjectName();
}
updateHistoryButtons();
updateSingleClipState();
document.documentElement.dataset.appReady = 'true';

window.addEventListener('beforeunload', () => {
  saveProjectName();
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
