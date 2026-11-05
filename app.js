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
import { atempoChain, normalizeSpeed, speedOutputFrameCount, SPEED_MAX, SPEED_MIN, SPEED_STEP } from './speed.js';
import { canRandomize, normalizeSeed, randomizeTransition } from './randomize.js';
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
const BUILD = 'v32';
const SHELL_NOTICE_MIXED = 'This page mixes two m4shlab versions. Reload to get a consistent editor.';
const SHELL_NOTICE_INCOMPLETE = 'This editor is incomplete. Reload the page.';
const REQUIRED_UI = [
  'file-input-a',
  'file-input-b',
  'preview-video',
  'empty-preview',
  'status',
  'source-tiers',
  'drop-zone',
  'error',
  'conversion-progress',
  'conversion-status',
  'assemble-preview',
  'export-button',
  'preview-label',
  'preview-time',
  'sound-toggle',
  'report',
  'undo-button',
  'redo-button',
  'transition-dialog',
  'transition-subtitle',
  'transition-method',
  'transition-apply',
  'transition-randomize',
  'classic-mosh-options',
  'transition-duration',
  'transition-duration-value',
  'transition-duration-mode',
  'transition-duration-max',
  'transition-ending',
  'nal-effect-options',
  'effect-parameter',
  'effect-parameter-label',
  'effect-parameter-value',
  'effect-parameter-max',
  'melt-cadence-control',
  'melt-cadence',
  'reset-pulse-options',
  'reset-interval',
  'reset-interval-value',
  'reset-interval-max',
  'reset-repeat',
  'reset-repeat-value',
];
const OPTIONAL_UI = [
  'project-menu',
  'project-name',
  'save-settings',
  'load-settings',
  'settings-input',
  'transition-seed',
  'copy-seed',
  'transition-seed-error',
  'bitstream-report',
  'bitstream-report-json',
  'sequence-label',
  'trim-dialog',
  'trim-subtitle',
  'trim-start',
  'trim-end',
  'trim-start-range',
  'trim-end-range',
  'trim-readout',
  'trim-clamp',
  'trim-start-seconds',
  'trim-end-seconds',
  'trim-error',
  'trim-preview-in',
  'trim-preview-out',
  'trim-reset',
  'trim-apply',
];
const missingRequiredUi = REQUIRED_UI.filter(id => !document.getElementById(id));
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
const projectMenu = document.querySelector('#project-menu');
const saveSettingsButton = document.querySelector('#save-settings');
const loadSettingsButton = document.querySelector('#load-settings');
const settingsInput = document.querySelector('#settings-input');
const AUDIO_PREFERENCE_KEY = 'm4shlab-audio';
const PROJECT_NAME_KEY = 'm4shlab-project';
const SETTINGS_FORMAT = 'm4shlab-settings';
const SETTINGS_VERSION = 1;
const SETTINGS_MAX_BYTES = 1024 * 1024;
const DEFAULT_PROJECT_NAME = 'Project';
const DEFAULT_EXPORT_FILENAME = 'm4shlab-merge.mp4';
const TRANSITION_METHODS = new Set(['cut', 'classic-mosh', 'melt', 'loop', 'reset-pulse']);
const report = document.querySelector('#report');
const bitstreamReportJson = document.querySelector('#bitstream-report-json');
const undoButton = document.querySelector('#undo-button');
const redoButton = document.querySelector('#redo-button');
const coarsePointerQuery = window.matchMedia('(pointer: coarse)');
const trimDialog = document.querySelector('#trim-dialog');
const trimSubtitle = document.querySelector('#trim-subtitle');
const trimStartInput = document.querySelector('#trim-start');
const trimEndInput = document.querySelector('#trim-end');
const trimStartRange = document.querySelector('#trim-start-range');
const trimEndRange = document.querySelector('#trim-end-range');
const trimReadout = document.querySelector('#trim-readout');
const trimClamp = document.querySelector('#trim-clamp');
const trimStartSeconds = document.querySelector('#trim-start-seconds');
const trimEndSeconds = document.querySelector('#trim-end-seconds');
const trimError = document.querySelector('#trim-error');
const trimPreviewIn = document.querySelector('#trim-preview-in');
const trimPreviewOut = document.querySelector('#trim-preview-out');
const trimReset = document.querySelector('#trim-reset');
const trimApply = document.querySelector('#trim-apply');
const transitionDialog = document.querySelector('#transition-dialog');
const transitionSubtitle = document.querySelector('#transition-subtitle');
const transitionMethod = document.querySelector('#transition-method');
const transitionApply = document.querySelector('#transition-apply');
const transitionRandomize = document.querySelector('#transition-randomize');
const transitionSeed = document.querySelector('#transition-seed');
const copySeedButton = document.querySelector('#copy-seed');
const transitionSeedError = document.querySelector('#transition-seed-error');
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
let trimClipIndex = null;
let activeMoshFps = 25;
let activeMoshMaximum = 0;
let activeRandomSeed = null;
let normalizationAttempted = false;
let undoStack = [];
let redoStack = [];
let refreshInFlight = 0;
let soundEnabled = readSoundPreference();
let projectNameSaveTimer = null;

function reloadAfterControllerChange({registration, onReload = () => location.reload(), timeoutMs = 3000} = {}) {
  const container = navigator.serviceWorker;
  if (!container || !registration || !container.controller) {
    onReload();
    return () => {};
  }
  let done = false;
  let timer = null;
  let watchedWorker = null;

  const detach = () => {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
    container.removeEventListener?.('controllerchange', fire);
    registration.removeEventListener?.('updatefound', onUpdateFound);
    if (watchedWorker) watchedWorker.removeEventListener?.('statechange', onInstallingStateChange);
    watchedWorker = null;
  };

  const cleanup = () => {
    if (done) return;
    done = true;
    detach();
  };

  const fire = () => {
    if (done) return;
    done = true;
    detach();
    onReload();
  };

  const timeoutFallback = async () => {
    if (done) return;
    if (registration.installing || registration.waiting) return;
    done = true;
    detach();
    try {
      await registration.unregister?.();
    } catch {}
    onReload();
  };

  const onInstallingStateChange = () => {
    if (watchedWorker?.state === 'activated') fire();
  };

  const onUpdateFound = () => {
    const installing = registration.installing;
    if (!installing || typeof installing.addEventListener !== 'function') return;
    if (watchedWorker) watchedWorker.removeEventListener?.('statechange', onInstallingStateChange);
    watchedWorker = installing;
    watchedWorker.addEventListener('statechange', onInstallingStateChange);
    if (installing.state === 'activated') fire();
  };

  container.addEventListener('controllerchange', fire);
  registration.addEventListener?.('updatefound', onUpdateFound);
  if (registration.installing) onUpdateFound();
  timer = setTimeout(timeoutFallback, timeoutMs);
  Promise.resolve()
    .then(() => registration.update?.())
    .catch(() => {});
  return cleanup;
}

function showShellNotice(message) {
  const main = document.querySelector('main');
  if (!main) return null;
  let notice = document.getElementById('shell-notice');
  if (!notice) {
    notice = document.createElement('aside');
    notice.id = 'shell-notice';
    notice.className = 'shell-notice';
    notice.setAttribute('role', 'status');
    const text = document.createElement('span');
    text.className = 'shell-notice-text';
    const reload = document.createElement('button');
    reload.type = 'button';
    reload.className = 'shell-notice-reload';
    reload.textContent = 'Reload';
    reload.addEventListener('click', async () => {
      if (reload.disabled) return;
      reload.disabled = true;
      reload.setAttribute('aria-busy', 'true');
      reload.textContent = 'Reloading…';
      let registration = null;
      try {
        registration = await navigator.serviceWorker?.getRegistration?.() ?? null;
      } catch {}
      reloadAfterControllerChange({registration});
    });
    const dismiss = document.createElement('button');
    dismiss.type = 'button';
    dismiss.className = 'shell-notice-dismiss';
    dismiss.setAttribute('aria-label', 'Dismiss version notice');
    dismiss.textContent = '×';
    dismiss.addEventListener('click', () => notice.remove());
    notice.append(text, reload, dismiss);
    main.prepend(notice);
  }
  const label = notice.querySelector('.shell-notice-text');
  if (label) label.textContent = message;
  return notice;
}

function checkShellBuild() {
  const meta = document.querySelector('meta[name="m4shlab-build"]')?.getAttribute('content') ?? null;
  const attribute = document.documentElement.getAttribute('data-build');
  if (meta === BUILD && attribute === BUILD) return;
  showShellNotice(SHELL_NOTICE_MIXED);
  console.warn(`m4shlab build mismatch: app.js ${BUILD}, meta ${meta ?? 'missing'}, data-build ${attribute ?? 'missing'}`);
}

checkShellBuild();

if (document.documentElement.dataset.testHooks === 'true') {
  window.m4shlabTest = {reloadAfterControllerChange};
}

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

function projectFileBaseName() {
  const trimmed = (projectName?.value ?? DEFAULT_PROJECT_NAME).trim();
  if (!trimmed || trimmed === DEFAULT_PROJECT_NAME) return 'm4shlab-merge';
  const sanitized = trimmed
    .replace(/[\u0000-\u001f\u007f\/\\:*?"<>|]/g, '')
    .replace(/\s+/g, '-');
  return sanitized || 'm4shlab-merge';
}

function projectExportFilename() {
  return `${projectFileBaseName()}.mp4`;
}

function projectSettingsFilename() {
  return `${projectFileBaseName()}.m4settings`;
}

function settingsBusy() {
  return refreshInFlight > 0 || importInFlight > 0;
}

function updateSettingsControls() {
  if (saveSettingsButton) saveSettingsButton.disabled = settingsBusy() || clips.length === 0;
  if (loadSettingsButton) loadSettingsButton.disabled = settingsBusy();
}

function closeProjectMenu() {
  if (projectMenu) projectMenu.open = false;
}

function transitionSettingsForClip(clip) {
  const method = clip.transition;
  const base = {
    method,
    duration_frames: null,
    ending: null,
    repeat: null,
    loop_frames: null,
    reset_interval: null,
    smooth: false,
    random_seed: clip.randomSeed ?? null,
  };
  if (method === 'cut') return base;
  const effect = effectSettingsForClip(clip);
  if (effect) {
    return {
      ...base,
      duration_frames: effect.durationFrames,
      ending: effect.ending,
      repeat: effect.repeat ?? null,
      loop_frames: effect.loopFrames ?? null,
      reset_interval: effect.resetInterval ?? null,
      smooth: effect.smooth === true,
    };
  }
  const settings = moshSettingsForClip(clip);
  return {
    ...base,
    duration_frames: settings.durationFrames,
    ending: settings.ending,
  };
}

function currentSettingsSnapshot() {
  return {
    format: SETTINGS_FORMAT,
    version: SETTINGS_VERSION,
    project: (projectName?.value ?? DEFAULT_PROJECT_NAME).trim() || DEFAULT_PROJECT_NAME,
    sound: soundEnabled,
    clip_count: clips.length,
    clips: clips.map(clip => {
      const trim = clipTrimRange(clip);
      return {
        name: clip.file.name,
        frames: clip.mp4.videoTrack.samples.length,
        speed: Number(clip.speed ?? 1),
        look: normalizeLook(clip.look ?? 'original'),
        start_frame: trim.startFrame,
        end_frame: trim.endFrame,
      };
    }),
    transitions: clips.slice(1).map(transitionSettingsForClip),
  };
}

function validateSettingsTransition(saved, index) {
  if (!saved || typeof saved !== 'object' || Array.isArray(saved)) {
    throw new Error(`Transition ${index + 1} is invalid.`);
  }
  if (!TRANSITION_METHODS.has(saved.method)) {
    throw new Error(`Transition ${index + 1} has an unsupported method.`);
  }
  let randomSeed = null;
  if (saved.random_seed !== null && saved.random_seed !== undefined) {
    randomSeed = normalizeSeed(String(saved.random_seed).trim().toLowerCase());
  }
  const method = saved.method;
  const result = {
    method,
    duration_frames: null,
    ending: null,
    repeat: null,
    loop_frames: null,
    reset_interval: null,
    smooth: false,
    random_seed: randomSeed,
  };
  if (method === 'cut') return result;
  if (saved.ending !== 'restore' && saved.ending !== 'continue') {
    throw new Error(`Transition ${index + 1} has an invalid ending.`);
  }
  if (!Number.isInteger(saved.duration_frames) || saved.duration_frames < 1) {
    throw new Error(`Transition ${index + 1} needs a positive frame duration.`);
  }
  if (saved.smooth !== undefined && typeof saved.smooth !== 'boolean') {
    throw new Error(`Transition ${index + 1} has an invalid smooth setting.`);
  }
  result.duration_frames = saved.duration_frames;
  result.ending = saved.ending;
  result.smooth = saved.smooth === true;
  if (method === 'melt') {
    if (!Number.isInteger(saved.repeat) || saved.repeat < 2 || saved.repeat > 12) {
      throw new Error(`Transition ${index + 1} has an invalid Melt repeat.`);
    }
    result.repeat = saved.repeat;
  } else if (method === 'loop') {
    if (!Number.isInteger(saved.loop_frames) || saved.loop_frames < 2 || saved.loop_frames > 48) {
      throw new Error(`Transition ${index + 1} has invalid Loop frames.`);
    }
    result.loop_frames = saved.loop_frames;
  } else if (method === 'reset-pulse') {
    if (!Number.isInteger(saved.reset_interval) || saved.reset_interval < 4 || saved.reset_interval > 48) {
      throw new Error(`Transition ${index + 1} has an invalid Reset Pulse interval.`);
    }
    if (!Number.isInteger(saved.repeat) || saved.repeat < 2 || saved.repeat > 12) {
      throw new Error(`Transition ${index + 1} has an invalid Reset Pulse repeat.`);
    }
    result.reset_interval = saved.reset_interval;
    result.repeat = saved.repeat;
  }
  return result;
}

function clipWithSavedTransition(clip, saved) {
  const next = {
    ...clip,
    transition: saved.method,
    randomSeed: saved.random_seed,
  };
  if (saved.method === 'cut') {
    next.moshDurationFrames = null;
    next.moshEnding = 'restore';
    return next;
  }
  next.moshDurationFrames = saved.duration_frames;
  next.moshEnding = saved.ending;
  if (saved.method === 'melt') {
    next.meltRepeat = saved.repeat;
    next.meltSmooth = saved.smooth;
  } else if (saved.method === 'loop') {
    next.loopFrames = saved.loop_frames;
    next.loopSmooth = saved.smooth;
  } else if (saved.method === 'reset-pulse') {
    next.resetInterval = saved.reset_interval;
    next.resetRepeat = saved.repeat;
  }
  return next;
}

async function applySettingsPayload(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload) || payload.format !== SETTINGS_FORMAT) {
    throw new Error('This is not an m4shlab settings file.');
  }
  if (payload.version !== SETTINGS_VERSION) {
    throw new Error(`Unsupported settings version ${String(payload.version ?? 'missing')}.`);
  }
  if (!Number.isInteger(payload.clip_count) || payload.clip_count !== clips.length) {
    throw new Error(`Settings are for ${String(payload.clip_count ?? 'an unknown number of')} clips, but this timeline has ${clips.length}. Import the same clips first.`);
  }
  if (!Array.isArray(payload.clips) || payload.clips.length !== clips.length) {
    throw new Error('The settings clip list does not match the timeline.');
  }
  if (!Array.isArray(payload.transitions) || payload.transitions.length !== Math.max(0, clips.length - 1)) {
    throw new Error('The settings transition list does not match the timeline boundaries.');
  }
  if (typeof payload.sound !== 'boolean') throw new Error('The settings sound value is invalid.');

  const clipSettings = payload.clips.map((saved, index) => {
    if (!saved || typeof saved !== 'object' || Array.isArray(saved)) {
      throw new Error(`Clip ${index + 1} settings are invalid.`);
    }
    const sourceFrames = clipSourceFrames(clips[index]);
    const startFrame = saved.start_frame === undefined ? 0 : saved.start_frame;
    const endFrame = saved.end_frame === undefined ? sourceFrames : saved.end_frame;
    if (!Number.isInteger(startFrame) || !Number.isInteger(endFrame)) {
      throw new Error(`Clip ${index + 1} has an invalid trim range.`);
    }
    if (startFrame < 0 || endFrame <= startFrame || endFrame > sourceFrames || endFrame - startFrame < 1) {
      throw new Error(`Clip ${index + 1} trim ${startFrame}–${endFrame} is outside the ${sourceFrames} source frames.`);
    }
    return {
      speed: normalizeSpeed(saved.speed),
      look: normalizeLook(saved.look ?? 'original'),
      startFrame,
      endFrame,
    };
  });
  const transitions = payload.transitions.map(validateSettingsTransition);

  const nextClips = clips.map((clip, index) => {
    const next = {
      ...clip,
      speed: clipSettings[index].speed,
      look: clipSettings[index].look,
      trimStart: clipSettings[index].startFrame,
      trimEnd: clipSettings[index].endFrame,
    };
    return index === 0 ? next : clipWithSavedTransition(next, transitions[index - 1]);
  });

  const previous = {
    clips: snapshotState(),
    undo: undoStack.slice(),
    redo: redoStack.slice(),
    project: projectName?.value ?? readProjectName(),
    sound: soundEnabled,
    normalizationAttempted,
  };
  rememberState();
  clips = nextClips;
  normalizationAttempted = false;
  if (projectName) {
    projectName.value = (typeof payload.project === 'string' ? payload.project : DEFAULT_PROJECT_NAME).slice(0, 60);
    autoSizeProjectName();
    saveProjectName();
  }
  soundEnabled = payload.sound;
  soundToggle.checked = soundEnabled;
  writeSoundPreference();
  applySoundPreference();
  await refreshSequence();
  if (!error.hidden) {
    const failure = error.textContent;
    clips = previous.clips;
    undoStack = previous.undo;
    redoStack = previous.redo;
    normalizationAttempted = previous.normalizationAttempted;
    if (projectName) {
      projectName.value = previous.project;
      autoSizeProjectName();
      saveProjectName();
    }
    soundEnabled = previous.sound;
    soundToggle.checked = soundEnabled;
    writeSoundPreference();
    applySoundPreference();
    updateHistoryButtons();
    await refreshSequence();
    throw new Error(failure);
  }
  status.textContent = `Settings loaded for ${Math.max(0, clips.length - 1)} boundaries.`;
}

async function loadSettingsFile(file) {
  if (!file) return;
  if (file.size > SETTINGS_MAX_BYTES) {
    setError('Settings files are limited to 1 MiB.');
    return;
  }
  let payload;
  try {
    payload = JSON.parse(await file.text());
  } catch {
    setError('This settings file is not valid JSON.');
    return;
  }
  try {
    await applySettingsPayload(payload);
    setError('');
  } catch (cause) {
    setError(cause instanceof Error ? cause.message : String(cause));
  }
}

function saveSettingsFile() {
  if (!saveSettingsButton || saveSettingsButton.disabled) return;
  const link = document.createElement('a');
  const url = URL.createObjectURL(new Blob([JSON.stringify(currentSettingsSnapshot(), null, 2)], {
    type: 'application/json',
  }));
  link.href = url;
  link.download = projectSettingsFilename();
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  saveProjectName();
  closeProjectMenu();
  setError('');
  status.textContent = 'Settings saved. Videos are not included.';
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

function trimClipAudio(baseAudio, trim, fps) {
  if (!baseAudio) return null;
  const frameSamples = samplesPerFrame(fps, AUDIO_SAMPLE_RATE);
  const trimmedFrames = Math.max(0, trim.trimmedFrames);
  if (!baseAudio.hasAudio || !baseAudio.pcm) {
    return {...silentClipAudio(trimmedFrames, baseAudio.source ?? 'silent'), trimStartFrame: trim.startFrame};
  }
  const startSample = trim.startFrame * frameSamples * AUDIO_CHANNELS;
  const endSample = trim.endFrame * frameSamples * AUDIO_CHANNELS;
  const pcm = baseAudio.pcm.slice(startSample, endSample);
  const expectedSamples = trimmedFrames * frameSamples * AUDIO_CHANNELS;
  if (pcm.length !== expectedSamples) {
    throw new RuntimeError(`Trimmed audio has ${pcm.length / AUDIO_CHANNELS} samples but ${trimmedFrames} frames need ${expectedSamples / AUDIO_CHANNELS}.`);
  }
  return {...baseAudio, pcm, frames: trimmedFrames, trimStartFrame: trim.startFrame};
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
    start_frame: clipTrimRange(clip).startFrame,
    end_frame: clipTrimRange(clip).endFrame,
    trimmed_frames: clipTrimRange(clip).trimmedFrames,
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

function syncOpenTransitionDialog() {
  if (!transitionDialog?.open || activeBoundary === null) return;
  const clip = clips[activeBoundary];
  if (!clip) return;
  const settings = moshSettingsForClip(clip);
  activeMoshFps = settings.fps;
  activeMoshMaximum = Math.max(1, settings.maximumFrames);
  transitionDuration.min = '1';
  transitionDuration.max = String(activeMoshMaximum);
  transitionDuration.disabled = settings.maximumFrames < 1;
  const previous = Math.round(Number(transitionDuration.value));
  const clamped = Math.min(Math.max(Number.isFinite(previous) ? previous : activeMoshMaximum, 1), activeMoshMaximum);
  let mode = transitionDurationMode.textContent;
  if (String(clamped) !== transitionDuration.value) {
    transitionDuration.value = String(clamped);
    mode = 'clamped';
  }
  updateTransitionDurationDisplay(mode === 'custom');
  if (mode === 'clamped') transitionDurationMode.textContent = 'clamped';
  updateEffectParameterDisplay();
  updateResetIntervalLimit();
  updateTransitionOptionsVisibility();
}

function transitionSeconds(durationFrames, fps) {
  const frames = Number(durationFrames);
  const rate = Number(fps);
  if (!Number.isFinite(frames) || frames < 0 || !Number.isFinite(rate) || rate <= 0) return null;
  return frames / rate;
}

function clipSeconds(clip) {
  const track = clip?.mp4?.videoTrack;
  if (!track?.stts || !track.mdhd?.timescale) return null;
  const units = track.stts.durations.reduce((total, value) => total + value, 0);
  return units / track.mdhd.timescale;
}

function clipSourceFrames(clip) {
  const track = (clip?.baseMp4 ?? clip?.mp4)?.videoTrack;
  return track?.samples?.length ?? 0;
}

function clipTrimRange(clip) {
  const sourceFrames = clipSourceFrames(clip);
  if (sourceFrames < 1) return {sourceFrames: 0, startFrame: 0, endFrame: 0, trimmedFrames: 0};
  const rawStart = Number.isInteger(clip?.trimStart) ? clip.trimStart : 0;
  const rawEnd = Number.isInteger(clip?.trimEnd) ? clip.trimEnd : sourceFrames;
  const startFrame = Math.max(0, Math.min(rawStart, sourceFrames - 1));
  const endFrame = Math.min(sourceFrames, Math.max(startFrame + 1, rawEnd));
  return {sourceFrames, startFrame, endFrame, trimmedFrames: endFrame - startFrame};
}

function clipTrimSignature(clip) {
  const trim = clipTrimRange(clip);
  return `${trim.startFrame}-${trim.endFrame}`;
}

function preparedTrimSignature(clip) {
  const sourceFrames = clipSourceFrames(clip);
  const start = Number.isInteger(clip?.preparedTrimStart) ? clip.preparedTrimStart : 0;
  const end = Number.isInteger(clip?.preparedTrimEnd) ? clip.preparedTrimEnd : sourceFrames;
  return `${start}-${end}`;
}

function clipThumbnailOffset(clip) {
  if (!clipIsTrimmed(clip)) return 0.001;
  const fps = baseClipFps(clip);
  if (!fps) return 0.001;
  return Math.max(0.001, clipTrimRange(clip).startFrame / fps + 0.001);
}

function clipIsTrimmed(clip) {
  const trim = clipTrimRange(clip);
  return trim.trimmedFrames > 0 && (trim.startFrame > 0 || trim.endFrame < trim.sourceFrames);
}

function baseClipFps(clip) {
  try {
    return frameRateForTrack((clip?.baseMp4 ?? clip?.mp4)?.videoTrack);
  } catch {
    return null;
  }
}

function formatSeconds(seconds) {
  return seconds === null || !Number.isFinite(seconds) ? null : `${seconds.toFixed(2)} s`;
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

function clampMoshFrames(requestedFrames, maximumFrames) {
  return Math.max(0, Math.min(maximumFrames, requestedFrames));
}

function projectedMoshSettings(clip, trim) {
  const sourceFps = baseClipFps(clip) ?? 30;
  const speed = normalizeSpeed(clip.speed ?? 1);
  const frames = speed === 1 ? trim.trimmedFrames : speedOutputFrameCount(trim.trimmedFrames, sourceFps, speed);
  const maximumFrames = Math.max(0, frames - 1);
  const requested = clip?.moshDurationFrames === undefined || clip?.moshDurationFrames === null
    ? maximumFrames
    : Math.round(Number(clip.moshDurationFrames));
  const effectiveFrames = clampMoshFrames(requested, maximumFrames);
  return {
    maximumFrames,
    requestedFrames: requested,
    effectiveFrames,
    clamped: requested > maximumFrames,
    fps: 30,
  };
}

function moshSettingsForClip(clip) {
  const limits = moshBoundaryLimits(clip);
  const requested = clip?.moshDurationFrames;
  const defaultEnding = clip?.transition === 'melt' || clip?.transition === 'loop' ? 'continue' : 'restore';
  const requestedFrames = Number.isFinite(requested) ? Math.round(requested) : limits.maximumFrames;
  const durationFrames = clampMoshFrames(requestedFrames, limits.maximumFrames);
  return {
    ...limits,
    durationFrames,
    durationSeconds: transitionSeconds(durationFrames, limits.fps) ?? 0,
    ending: clip?.moshEnding === 'continue' || clip?.moshEnding === 'restore' ? clip.moshEnding : defaultEnding,
    explicitDuration: requested !== undefined && requested !== null,
    requestedFrames,
    clamped: requestedFrames > limits.maximumFrames,
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
  return 'm4sh';
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
  updateSettingsControls();
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
  preview.src = `${clip.url}#t=${clipThumbnailOffset(clip)}`;
  thumb.append(preview);

  const name = document.createElement('span');
  name.className = 'clip-name';
  name.textContent = clip.file.name;
  name.title = clip.file.name;

  const detail = document.createElement('span');
  detail.className = 'clip-detail';
  const clipText = formatSeconds(clipSeconds(clip)) ?? 'video';
  detail.textContent = clipIsTrimmed(clip) ? `${clipText} · trimmed` : clipText;

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
  const trimAction = document.createElement('button');
  trimAction.type = 'button';
  trimAction.className = 'clip-trim-button';
  trimAction.textContent = '✂';
  trimAction.setAttribute('aria-label', `Trim ${clip.file.name}`);
  trimAction.title = `Trim ${clip.file.name}`;
  trimAction.addEventListener('click', () => openTrimDialog(index));
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
  controls.append(trimAction);

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
  const notes = [];
  if (incoming.randomSeed) notes.push(`Random seed ${incoming.randomSeed}`);
  const effect = document.createElement('span');
  effect.textContent = transitionLabel(incoming.transition);
  const duration = document.createElement('span');
  const clipText = formatSeconds(clipSeconds(incoming));
  const settings = incoming.transition === 'cut' ? null : moshSettingsForClip(incoming);
  if (settings?.clamped) notes.push(`Duration clamped to ${settings.durationFrames} frames after normalization.`);
  if (notes.length > 0) connector.title = notes.join(' · ');
  if (incoming.transition === 'classic-mosh') {
    const text = formatSeconds(settings.durationSeconds);
    duration.textContent = settings.maximumFrames > 0 && text !== null
      ? `${text} · ${settings.ending}`
      : (clipText ?? 'incoming clip');
  } else if (incoming.transition === 'melt') {
    const melt = effectSettingsForClip(incoming);
    duration.textContent = `${formatSeconds(melt.durationSeconds) ?? '0.00 s'} · ${melt.ending}`;
  } else if (incoming.transition === 'loop') {
    const loop = effectSettingsForClip(incoming);
    duration.textContent = `${formatSeconds(loop.durationSeconds) ?? '0.00 s'} · ${loop.loopFrames}f`;
  } else if (incoming.transition === 'reset-pulse') {
    const pulse = effectSettingsForClip(incoming);
    duration.textContent = `${formatSeconds(pulse.durationSeconds) ?? '0.00 s'} · ${pulse.resetInterval}f / ${pulse.repeat}×`;
  } else {
    duration.textContent = clipText ?? 'incoming clip';
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
  for (const glyph of ['←', '→', '×', '✂']) {
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

function updateSequenceLabel() {
  if (!sequenceLabel) return;
  sequenceLabel.textContent = `${clips.length} clip${clips.length === 1 ? '' : 's'}`;
}

function renderSourceTiers() {
  const scrollLeft = sourceTiers?.scrollLeft ?? 0;
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
    updateSequenceLabel();
    sourceTiers.hidden = false;
    sourceTiers.scrollLeft = scrollLeft;
    return;
  }
  sourceTiers.replaceChildren(...nodes);
  sourceTiers.hidden = false;
  sourceTiers.scrollLeft = scrollLeft;
  syncClipDragState();
  updateSequenceLabel();
}

function rerenderTimeline() {
  if (!sourceTiers) return;
  const scrollLeft = sourceTiers.scrollLeft;
  renderSourceTiers();
  sourceTiers.scrollLeft = scrollLeft;
  updatePreviewSelection();
  syncOpenTransitionDialog();
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

function wirePreviewEvents() {
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
}

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

function setSeedError(message = '') {
  if (!transitionSeedError) return;
  transitionSeedError.textContent = message;
  transitionSeedError.hidden = !message;
}

function updateTransitionSeedDisplay() {
  if (!transitionSeed) return;
  transitionSeed.value = activeRandomSeed ?? '';
}

function clearRandomSeed() {
  setSeedError('');
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

function projectedTrimRange(clip) {
  const trim = clipTrimRange(clip);
  const start = Math.round(Number(trimStartInput?.value));
  const end = Math.round(Number(trimEndInput?.value));
  if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end <= start || end > trim.sourceFrames) return null;
  return {sourceFrames: trim.sourceFrames, startFrame: start, endFrame: end, trimmedFrames: end - start};
}

function trimClampPreview(index, trim) {
  if (!trim) return [];
  const entries = [];
  for (const boundary of [index, index + 1]) {
    if (!Number.isInteger(boundary) || boundary < 1 || boundary >= clips.length) continue;
    const clip = clips[boundary];
    if (!clip || clip.transition === 'cut') continue;
    const settings = boundary === index ? projectedMoshSettings(clip, trim) : moshSettingsForClip(clip);
    if (!settings.clamped) continue;
    entries.push({
      boundary,
      before: settings.requestedFrames / 30,
      after: settings.effectiveFrames / 30,
      frames: settings.effectiveFrames,
    });
  }
  return entries;
}

function updateTrimClampPreview() {
  if (!trimClamp || trimClipIndex === null) return;
  const clip = clips[trimClipIndex];
  if (!clip) return;
  const entries = trimClampPreview(trimClipIndex, projectedTrimRange(clip));
  if (entries.length === 0) {
    trimClamp.hidden = true;
    trimClamp.textContent = '';
    return;
  }
  const detail = entries.map(entry => `${entry.before.toFixed(2)} s → ${entry.after.toFixed(2)} s`).join(', ');
  trimClamp.textContent = `${entries.length} transition${entries.length === 1 ? '' : 's'} will clamp: ${detail}`;
  trimClamp.hidden = false;
}

function setTrimSecondsFromFrames() {
  const clip = clips[trimClipIndex];
  const fps = baseClipFps(clip);
  if (!fps || !trimStartSeconds || !trimEndSeconds) return;
  const start = Math.round(Number(trimStartInput.value));
  const end = Math.round(Number(trimEndInput.value));
  trimStartSeconds.value = Number.isFinite(start) ? (start / fps).toFixed(2) : '0';
  trimEndSeconds.value = Number.isFinite(end) ? (end / fps).toFixed(2) : '0';
}

function trimDialogReady() {
  return Boolean(trimDialog && trimStartInput && trimEndInput && trimStartRange && trimEndRange && trimReadout && trimApply);
}

function setTrimError(message = '') {
  if (!trimError) return;
  trimError.textContent = message;
  trimError.hidden = !message;
}

function trimFpsLabel(fps) {
  if (!Number.isFinite(fps) || fps <= 0) return null;
  return Number.isInteger(fps) ? String(fps) : fps.toFixed(2);
}

function updateTrimReadout() {
  if (!trimDialogReady() || trimClipIndex === null) return;
  const clip = clips[trimClipIndex];
  if (!clip) return;
  const start = Math.round(Number(trimStartInput.value));
  const end = Math.round(Number(trimEndInput.value));
  const frames = Number.isFinite(start) && Number.isFinite(end) ? end - start : 0;
  const fps = baseClipFps(clip);
  const fpsLabel = trimFpsLabel(fps);
  const atSource = fps ? `${transitionSeconds(frames, fps).toFixed(2)} s at ${fpsLabel} fps` : 'source fps unknown';
  const atTarget = `${transitionSeconds(frames, 30).toFixed(2)} s at 30 fps`;
  trimReadout.textContent = `${frames} frame${frames === 1 ? '' : 's'} · ${atSource} · ${atTarget}`;
  updateTrimClampPreview();
}

function syncTrimDialog() {
  if (!trimDialogReady() || trimClipIndex === null) return;
  const clip = clips[trimClipIndex];
  if (!clip) return;
  const trim = clipTrimRange(clip);
  const sourceFrames = trim.sourceFrames;
  trimSubtitle.textContent = `${clip.file.name} · ${sourceFrames} source frames`;
  trimStartInput.min = '0';
  trimStartInput.max = String(Math.max(0, sourceFrames - 1));
  trimEndInput.min = '1';
  trimEndInput.max = String(sourceFrames);
  trimStartInput.value = String(trim.startFrame);
  trimEndInput.value = String(trim.endFrame);
  trimStartRange.min = '0';
  trimStartRange.max = String(Math.max(0, sourceFrames - 1));
  trimStartRange.value = String(trim.startFrame);
  trimEndRange.min = '1';
  trimEndRange.max = String(sourceFrames);
  trimEndRange.value = String(trim.endFrame);
  if (trimStartSeconds) trimStartSeconds.max = String(Math.max(0, sourceFrames - 1));
  if (trimEndSeconds) trimEndSeconds.max = String(sourceFrames);
  setTrimSecondsFromFrames();
  setTrimError('');
  updateTrimReadout();
}

function openTrimDialog(index) {
  if (!trimDialogReady()) return;
  if (!Number.isInteger(index) || index < 0 || index >= clips.length) return;
  trimClipIndex = index;
  syncTrimDialog();
  if (trimDialog.open) trimDialog.close();
  trimDialog.show();
}

function previewTrimEdge(edge) {
  if (trimClipIndex === null || !trimDialogReady()) return;
  const clip = clips[trimClipIndex];
  const fps = baseClipFps(clip);
  if (!clip || !fps) return;
  const end = Math.round(Number(trimEndInput.value));
  const start = Math.round(Number(trimStartInput.value));
  const frame = edge === 'out' ? Math.max(0, (Number.isFinite(end) ? end : 1) - 1) : Math.max(0, Number.isFinite(start) ? start : 0);
  const seconds = frame / fps;
  if (previewAssembled || previewedClipId !== clip.id) previewClip(trimClipIndex);
  video.pause();
  const seek = () => {
    try {
      video.currentTime = seconds;
    } catch {}
  };
  if (video.readyState >= 1) seek();
  else video.addEventListener('loadedmetadata', seek, {once: true});
}

function applyTrimRange() {
  if (!trimDialogReady() || trimClipIndex === null) return;
  const index = trimClipIndex;
  const clip = clips[index];
  if (!clip) return;
  const sourceFrames = clipTrimRange(clip).sourceFrames;
  const start = Number(trimStartInput.value);
  const end = Number(trimEndInput.value);
  if (!Number.isInteger(start) || !Number.isInteger(end)) {
    setTrimError('Enter whole frame numbers for in and out.');
    return;
  }
  if (start < 0) {
    setTrimError('In must be 0 or greater.');
    return;
  }
  if (end <= start) {
    setTrimError('Out must be greater than in.');
    return;
  }
  if (end > sourceFrames) {
    setTrimError(`Out must be at most ${sourceFrames}, the clip's source frames.`);
    return;
  }
  if (end - start < 1) {
    setTrimError('Keep at least one frame.');
    return;
  }
  const current = clipTrimRange(clip);
  trimDialog.close('apply');
  trimClipIndex = null;
  setTrimError('');
  if (current.startFrame === start && current.endFrame === end) return;
  rememberState();
  clips = clips.map((item, itemIndex) => (itemIndex === index ? {...item, trimStart: start, trimEnd: end} : item));
  normalizationAttempted = false;
  setError('');
  refreshSequence();
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
  transitionDurationMode.textContent = settings.clamped
    ? 'clamped'
    : (clip.moshDurationFrames === undefined || clip.moshDurationFrames === null ? 'full length' : 'custom');
  activeRandomSeed = clip.randomSeed ?? null;
  updateTransitionSeedDisplay();
  updateTransitionDurationDisplay(false);
  setEffectParameterControl(method, clip);
  setResetPulseControls(method, clip);
  transitionSubtitle.textContent = `${clips[boundaryIndex - 1].file.name} → ${clips[boundaryIndex].file.name}`;
  updateTransitionOptionsVisibility();
  transitionDialog.showModal();
}

function wireTransitionDialogEvents() {
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
      applyRandomizedTransition(settings);
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
}

function generateRandomSeed() {
  const bytes = new Uint8Array(8);
  if (!globalThis.crypto?.getRandomValues) throw new Error('This browser cannot generate a secure random seed.');
  globalThis.crypto.getRandomValues(bytes);
  return [...bytes].map(value => value.toString(16).padStart(2, '0')).join('');
}

function applyRandomizedTransition(settings) {
  const clip = clips[activeBoundary];
  if (!clip || !settings) return;
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
  setSeedError('');
  setError('');
}

function applyTypedSeed() {
  if (!transitionSeed) return;
  const clip = clips[activeBoundary];
  if (!clip) return;
  const normalized = transitionSeed.value.trim().toLowerCase();
  try {
    normalizeSeed(normalized);
    const settings = randomizeTransition({
      seed: normalized,
      availableFrames: activeMoshMaximum,
      fps: activeMoshFps,
      methods: randomMethodsForClip(clip),
    });
    applyRandomizedTransition(settings);
  } catch (cause) {
    setSeedError(cause instanceof Error ? cause.message : String(cause));
  }
}

async function copySeedToClipboard() {
  if (!transitionSeed) return;
  const value = transitionSeed.value.trim();
  if (!value) {
    setSeedError('Generate or enter a seed first.');
    return;
  }
  let copied = false;
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(value);
      copied = true;
    } else if (typeof document.execCommand === 'function') {
      transitionSeed.focus();
      transitionSeed.select();
      copied = document.execCommand('copy');
    }
  } catch {}
  if (!copied) {
    setSeedError('Could not copy the seed. Select it and copy manually.');
    return;
  }
  setSeedError('');
  if (!copySeedButton) return;
  copySeedButton.textContent = 'copied';
  if (copySeedButton.dataset.resetTimer) clearTimeout(Number(copySeedButton.dataset.resetTimer));
  const timer = setTimeout(() => {
    copySeedButton.textContent = 'copy';
    delete copySeedButton.dataset.resetTimer;
  }, 1200);
  copySeedButton.dataset.resetTimer = String(timer);
}


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
    trimStart: 0,
    trimEnd: null,
    preparedTrimStart: 0,
    preparedTrimEnd: null,
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
  return `${effects} needs clips without B-frames. Normalize this sequence first, or choose Cut/m4sh.`;
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
  const trimPreparation = originals.some(clip => clipTrimSignature(clip) !== preparedTrimSignature(clip));
  const renderPreparation = speedPreparation || lookPreparation || trimPreparation;
  if (renderPreparation && !isWebCodecsAvailable()) {
    const requirements = [
      trimPreparation ? 'Clip trim' : null,
      speedPreparation ? 'Clip speed' : null,
      lookPreparation ? 'Clip looks' : null,
    ].filter(Boolean);
    throw new Error(`${requirements.join(', ')} require WebCodecs VideoDecoder and VideoEncoder for the one-pass frame mapping, look, and re-encode.`);
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
        const trim = clipTrimRange(clip);
        const sourceFps = baseClipFps(clip);
        const sourceBytes = clip.baseBytes ?? clip.bytes;
        const sourceKey = `${clip.file.name}:${clip.file.size}:${clip.file.lastModified}`;
        const cacheKey = normalizationCacheKey({
          sourceKey,
          target,
          speed,
          look,
          startFrame: trim.startFrame,
          endFrame: trim.endFrame,
        });
        const lookText = look === 'original' ? 'original look' : `${look.replaceAll('-', ' ')} look`;
        const trimText = trim.trimmedFrames === trim.sourceFrames ? '' : `frames ${trim.startFrame}–${trim.endFrame - 1}, `;
        showConversion(label, 'normalizing', `Applying ${trimText}${speed.toFixed(1)}× speed and ${lookText}, then re-encoding ${clip.file.name} with WebCodecs at ${target.width}×${target.height}…`, null, progressSlot(index));
        const result = await normalizeWithWebCodecs(sourceBytes, {
          target,
          speed,
          look,
          startFrame: trim.startFrame,
          endFrame: trim.endFrame,
          onStatus: message => {
            if (token === refreshToken) showConversion(label, 'working', message, null, progressSlot(index));
          },
          onProgress: progress => {
            if (token !== refreshToken) return;
            const percent = Math.round(progress * 100);
            showConversion(label, 'working', `Normalizing with WebCodecs · ${percent}%`, progress, progressSlot(index));
          },
        });
        const trimmedAudio = trimClipAudio(clip.baseAudio ?? clip.audio, trim, sourceFps);
        const audio = await applySpeedToClipAudio(trimmedAudio, result.outputFrames, speed, label);
        advanceConversionProgress();
        return {result, sourceBytes: sourceBytes.byteLength, audio, cacheKey, sourceKey, trim};
      });
      if (token !== refreshToken || normalized.some(item => !item)) return false;
      clips = originals.map((clip, index) => {
        const {result, sourceBytes, audio, cacheKey, sourceKey, trim} = normalized[index];
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
          preparedTrimStart: trim.startFrame,
          preparedTrimEnd: trim.endFrame,
          trimReport: {
            sourceFrames: trim.sourceFrames,
            startFrame: trim.startFrame,
            endFrame: trim.endFrame,
            trimmedFrames: trim.trimmedFrames,
          },
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
            trimmedFrames: trim.trimmedFrames,
            startFrame: trim.startFrame,
            endFrame: trim.endFrame,
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
    policy: 'audio follows the clip timeline; m4sh, Loop and Reset Pulse drop one incoming frame; explicit-window Melt starts one frame in; extra picture-only frames are padded with silence',
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
  const trimPreparationNeeded = clips.some(clip => clipTrimSignature(clip) !== preparedTrimSignature(clip));
  if (speedPreparationNeeded || lookPreparationNeeded || trimPreparationNeeded) {
    const target = chooseNormalizationTarget(...clips.map(clip => ({
      width: clip.mp4.videoTrack.width,
      height: clip.mp4.videoTrack.height,
    })));
    const preparationText = [
      trimPreparationNeeded ? 'clip trim' : null,
      speedPreparationNeeded ? 'speed' : null,
      lookPreparationNeeded ? 'looks' : null,
    ].filter(Boolean).join(' and ');
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
      rerenderTimeline();
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
      rerenderTimeline();
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
    const mergeReport = {
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
          requested_frames: settings?.requestedFrames ?? null,
          effective_frames: settings?.durationFrames ?? null,
          clamped: settings?.clamped === true,
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
    };
    const serializedReport = JSON.stringify(mergeReport, null, 2);
    report.textContent = serializedReport;
    if (bitstreamReportJson) bitstreamReportJson.textContent = serializedReport;
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

function wireCoreUi() {
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
  assemblePreviewButton.addEventListener('click', previewAssembledSequence);
  undoButton.addEventListener('click', undoTimeline);
  redoButton.addEventListener('click', redoTimeline);
  coarsePointerQuery.addEventListener?.('change', syncClipDragState);
  window.addEventListener('resize', syncClipDragState);

  window.addEventListener('beforeunload', () => {
    saveProjectName();
    const urls = new Set(clips.map(clip => clip.url).filter(Boolean));
    if (merged?.cutUrl) urls.add(merged.cutUrl);
    if (merged?.mergedUrl) urls.add(merged.mergedUrl);
    for (const url of urls) URL.revokeObjectURL(url);
  });
}

function wireOptionalUi() {
  if (projectName) {
    projectName.addEventListener('input', () => {
      autoSizeProjectName();
      scheduleProjectNameSave();
    });
    projectName.addEventListener('change', saveProjectName);
    projectName.addEventListener('blur', saveProjectName);
  }
  if (transitionSeed) {
    transitionSeed.addEventListener('keydown', event => {
      if (event.key !== 'Enter') return;
      event.preventDefault();
      applyTypedSeed();
    });
    transitionSeed.addEventListener('change', applyTypedSeed);
  }
  copySeedButton?.addEventListener('click', copySeedToClipboard);
  saveSettingsButton?.addEventListener('click', saveSettingsFile);
  loadSettingsButton?.addEventListener('click', () => {
    closeProjectMenu();
    settingsInput?.click();
  });
  settingsInput?.addEventListener('change', () => {
    const [file] = settingsInput.files;
    settingsInput.value = '';
    closeProjectMenu();
    if (file) loadSettingsFile(file);
  });
  if (trimDialogReady()) {
    trimStartInput.addEventListener('input', () => {
      trimStartRange.value = trimStartInput.value;
      setTrimSecondsFromFrames();
      updateTrimReadout();
    });
    trimEndInput.addEventListener('input', () => {
      trimEndRange.value = trimEndInput.value;
      setTrimSecondsFromFrames();
      updateTrimReadout();
    });
    trimStartRange.addEventListener('input', () => {
      trimStartInput.value = trimStartRange.value;
      setTrimSecondsFromFrames();
      updateTrimReadout();
    });
    trimEndRange.addEventListener('input', () => {
      trimEndInput.value = trimEndRange.value;
      setTrimSecondsFromFrames();
      updateTrimReadout();
    });
    trimStartSeconds?.addEventListener('input', () => {
      const fps = baseClipFps(clips[trimClipIndex]);
      const seconds = Number(trimStartSeconds.value);
      if (!fps || !Number.isFinite(seconds)) return;
      const frame = Math.max(0, Math.round(seconds * fps));
      trimStartInput.value = String(frame);
      trimStartRange.value = String(frame);
      updateTrimReadout();
    });
    trimEndSeconds?.addEventListener('input', () => {
      const fps = baseClipFps(clips[trimClipIndex]);
      const seconds = Number(trimEndSeconds.value);
      if (!fps || !Number.isFinite(seconds)) return;
      const frame = Math.max(1, Math.round(seconds * fps));
      trimEndInput.value = String(frame);
      trimEndRange.value = String(frame);
      updateTrimReadout();
    });
    trimPreviewIn?.addEventListener('click', () => previewTrimEdge('in'));
    trimPreviewOut?.addEventListener('click', () => previewTrimEdge('out'));
    trimReset?.addEventListener('click', () => {
      const clip = clips[trimClipIndex];
      if (!clip) return;
      const trim = clipTrimRange(clip);
      trimStartInput.value = '0';
      trimEndInput.value = String(trim.sourceFrames);
      trimStartRange.value = '0';
      trimEndRange.value = String(trim.sourceFrames);
      setTrimSecondsFromFrames();
      setTrimError('');
      updateTrimReadout();
    });
    trimApply.addEventListener('click', applyTrimRange);
    trimDialog.addEventListener('close', () => {
      trimClipIndex = null;
      setTrimError('');
    });
  }
  if (projectMenu) {
    document.addEventListener('click', event => {
      if (projectMenu.open && !projectMenu.contains(event.target)) projectMenu.open = false;
    });
    document.addEventListener('keydown', event => {
      if (event.key === 'Escape' && projectMenu.open) projectMenu.open = false;
    });
  }
}

function startApp() {
  document.documentElement.dataset.optionalUi = OPTIONAL_UI.join(',');
  if (missingRequiredUi.length > 0) {
    showShellNotice(SHELL_NOTICE_INCOMPLETE);
    console.error(`m4shlab: required elements missing: ${missingRequiredUi.join(', ')}`);
    return;
  }
  wirePreviewEvents();
  wireTransitionDialogEvents();
  wireCoreUi();
  wireOptionalUi();
  applySoundPreference();
  if (projectName) {
    projectName.value = readProjectName();
    autoSizeProjectName();
  }
  updateSettingsControls();
  updateHistoryButtons();
  updateSingleClipState();
  document.documentElement.dataset.appReady = 'true';
}

startApp();

if ('serviceWorker' in navigator) {
  window.addEventListener('load', async () => {
    try {
      await navigator.serviceWorker.register('./sw.js');
    } catch {}
  });
}
