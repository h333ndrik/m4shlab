import { capNormalizationDimensions } from './conversion-settings.js';
import { HybridEncodeError, encodeY4mWithWebCodecs, isWebCodecsEncoderAvailable } from './hybrid-encoder.js';
import { normalizeSpeed } from './speed.js';

const MAX_CONVERSION_BYTES = 100 * 1024 * 1024;
const FFMPEG_CORE_VERSION = '0.12.10';
const DEFAULT_CONVERSION_WATCHDOG_MS = 60 * 1000;
const MAX_WORKERS = 2;
const workers = [];
const waiters = [];
const failureListeners = new Set();
const recentFailures = [];
let nextRequestId = 1;
let lastWatchdogAt = null;

/* The watchdog is the only thing that ends a conversion the worker silently
   dropped (a wedged wasm instance, a terminated thread, a core fetch that never
   settles). Sixty seconds without any message is the contract; tests shorten it
   with the data-conversion-watchdog-ms attribute on <html>. */
function conversionWatchdogMs() {
  const override = Number(globalThis.document?.documentElement?.dataset?.conversionWatchdogMs);
  return Number.isFinite(override) && override > 0 ? override : DEFAULT_CONVERSION_WATCHDOG_MS;
}

function watchdogError() {
  return new Error('Conversion did not respond. Reload the page and try a shorter clip.');
}

export function onConverterFailure(listener) {
  failureListeners.add(listener);
  return () => failureListeners.delete(listener);
}

function reportWorkerFailure(message) {
  const failure = {message, at: Date.now()};
  recentFailures.push(failure);
  if (recentFailures.length > 20) recentFailures.shift();
  for (const listener of failureListeners) {
    try {
      listener(message);
    } catch {}
  }
}

function noteWatchdog() {
  lastWatchdogAt = Date.now();
  reportWorkerFailure(watchdogError().message);
}

export function converterWorkerStatus() {
  return {
    workers: workers.map(slot => ({busy: slot.busy, dead: slot.dead === true, lastError: slot.lastError ?? null})),
    queued: waiters.length,
    failures: recentFailures.length,
    lastFailure: recentFailures.at(-1) ?? null,
    lastWatchdogAt,
  };
}

function createWorkerSlot() {
  const worker = new Worker(new URL('./converter-worker.js', import.meta.url), {type: 'module'});
  const slot = {busy: false, worker, dead: false, lastError: null};
  worker.addEventListener('error', event => {
    slot.dead = true;
    slot.lastError = event?.message || 'converter worker crashed';
    reportWorkerFailure(slot.lastError);
  });
  worker.addEventListener('messageerror', () => {
    slot.dead = true;
    slot.lastError = 'converter worker message could not be decoded';
    reportWorkerFailure(slot.lastError);
  });
  workers.push(slot);
  return slot;
}

function removeWorkerSlot(slot) {
  const index = workers.indexOf(slot);
  if (index !== -1) workers.splice(index, 1);
  slot.dead = true;
  slot.busy = false;
  slot.worker.terminate();
}

function acquireWorker(timeoutMs = conversionWatchdogMs()) {
  let slot = workers.find(candidate => !candidate.busy && !candidate.dead);
  if (!slot && workers.filter(candidate => !candidate.dead).length < MAX_WORKERS) slot = createWorkerSlot();
  if (slot) {
    slot.busy = true;
    return Promise.resolve(slot);
  }
  return new Promise((resolve, reject) => {
    const waiter = {resolve, timer: 0};
    waiter.timer = setTimeout(() => {
      const index = waiters.indexOf(waiter);
      if (index !== -1) waiters.splice(index, 1);
      noteWatchdog();
      reject(watchdogError());
    }, timeoutMs);
    waiters.push(waiter);
  });
}

function releaseWorker(slot, healthy = true) {
  if (!healthy) {
    removeWorkerSlot(slot);
    const waiter = waiters.shift();
    if (waiter) {
      clearTimeout(waiter.timer);
      const replacement = createWorkerSlot();
      replacement.busy = true;
      waiter.resolve(replacement);
    }
    return;
  }
  const waiter = waiters.shift();
  if (waiter) {
    clearTimeout(waiter.timer);
    waiter.resolve(slot);
  } else {
    slot.busy = false;
  }
}

function friendlyError(message) {
  if (/out of memory|memory access out of bounds|cannot enlarge|allocation failed|oom|runtimeerror/i.test(message)) {
    return new Error('ffmpeg.wasm ran out of memory during conversion. Try a shorter clip or a lower-resolution source.');
  }
  if (/failed to fetch|networkerror|importing a module|dynamically imported module|load failed|wasm streaming|failed to compile|out of memory during instantiation/i.test(message)) {
    return new Error('Conversion engine could not be loaded — check the connection once; it is cached afterwards.');
  }
  return new Error(`ffmpeg.wasm conversion failed: ${message}`);
}

async function runConversion(inputBytes, options) {
  if (!(inputBytes instanceof Uint8Array)) throw new TypeError('convertToH264 expects a Uint8Array');
  if (inputBytes.byteLength > MAX_CONVERSION_BYTES) {
    throw new Error(`convert-on-load is limited to 100 MB; this file is ${(inputBytes.byteLength / (1024 * 1024)).toFixed(1)} MB.`);
  }
  if (options.signal?.aborted) throw new DOMException('Conversion aborted', 'AbortError');

  const id = nextRequestId++;
  const target = options.target
    ? capNormalizationDimensions(options.target.width, options.target.height)
    : null;
  const hybrid = options.preferWebCodecsEncode === true && isWebCodecsEncoderAvailable();
  const slot = await acquireWorker();
  const instance = slot.worker;
  const started = performance.now();

  return new Promise((resolve, reject) => {
    let settled = false;
    let inactivityTimer = 0;
    const clear = () => {
      clearTimeout(inactivityTimer);
      instance.removeEventListener('message', onMessage);
      instance.removeEventListener('error', onWorkerError);
      instance.removeEventListener('messageerror', onMessageError);
    };
    const fail = (error, healthy = true) => {
      if (settled) return;
      settled = true;
      clear();
      releaseWorker(slot, healthy);
      reject(error);
    };
    const resetTimer = () => {
      clearTimeout(inactivityTimer);
      inactivityTimer = setTimeout(() => {
        noteWatchdog();
        fail(watchdogError(), false);
      }, conversionWatchdogMs());
    };
    const onMessage = event => {
      const data = event.data;
      if (data.requestId !== id) return;
      resetTimer();
      if (data.type === 'status') {
        options.onStatus?.(data.message);
      } else if (data.type === 'progress') {
        options.onProgress?.({
          progress: Number.isFinite(data.progress) ? Math.max(0, Math.min(1, data.progress)) : null,
          time: Number.isFinite(data.time) ? data.time : null,
        });
      } else if (data.type === 'log') {
        options.onLog?.(data.message);
      } else if (data.type === 'done') {
        if (settled) return;
        settled = true;
        clear();
        releaseWorker(slot, true);
        if (data.container === 'y4m') {
          encodeY4mWithWebCodecs(new Uint8Array(data.output), {
            onStatus: options.onStatus,
            onProgress: progress => options.onProgress?.({progress, time: null}),
          }).then(encoded => {
            resolve({
              bytes: encoded.bytes,
              target: {width: encoded.width, height: encoded.height},
              engine: 'ffmpeg.wasm + WebCodecs',
              decodeEngine: 'ffmpeg.wasm',
              encodeEngine: 'WebCodecs',
              encoderCodec: encoded.encoderCodec,
              hybrid: true,
              coreVersion: FFMPEG_CORE_VERSION,
              elapsedMs: Math.round(performance.now() - started),
            });
          }).catch(error => {
            reject(error instanceof HybridEncodeError ? error : new HybridEncodeError(error.message ?? String(error), error));
          });
          return;
        }
        resolve({
          bytes: new Uint8Array(data.output),
          target,
          engine: 'ffmpeg.wasm',
          decodeEngine: 'ffmpeg.wasm',
          encodeEngine: 'ffmpeg.wasm',
          hybrid: false,
          hybridFallbackReason: options.hybridFallbackReason ?? null,
          coreVersion: FFMPEG_CORE_VERSION,
          elapsedMs: Math.round(performance.now() - started),
        });
      } else if (data.type === 'error') {
        const outOfMemory = /out of memory|memory access out of bounds|cannot enlarge|allocation failed|oom|runtimeerror/i.test(data.message || '');
        if (outOfMemory) reportWorkerFailure(`ffmpeg.wasm reported: ${data.message}`);
        fail(friendlyError(data.message), !outOfMemory);
      }
    };
    const onWorkerError = event => {
      fail(friendlyError(event.message || 'converter worker failed'), false);
    };
    const onMessageError = () => {
      fail(friendlyError('converter worker message could not be decoded'), false);
    };
    instance.addEventListener('message', onMessage);
    instance.addEventListener('error', onWorkerError);
    instance.addEventListener('messageerror', onMessageError);
    resetTimer();
    options.onStatus?.('Loading ffmpeg.wasm (about 31 MB, only on first conversion)…');
    options.onProgress?.({progress: null, time: null});
    const copy = new Uint8Array(inputBytes.byteLength);
    copy.set(inputBytes);
    instance.postMessage({
      id,
      type: 'convert',
      inputBytes: copy.buffer,
      target,
      mode: hybrid ? 'decode-y4m' : 'encode-wasm',
    }, [copy.buffer]);
  });
}

async function runWorkerTask(payload, transfer, options = {}) {
  const id = nextRequestId++;
  const slot = await acquireWorker();
  const instance = slot.worker;
  const started = performance.now();
  return new Promise((resolve, reject) => {
    let settled = false;
    let inactivityTimer = 0;
    const clear = () => {
      clearTimeout(inactivityTimer);
      instance.removeEventListener('message', onMessage);
      instance.removeEventListener('error', onWorkerError);
      instance.removeEventListener('messageerror', onMessageError);
    };
    const fail = (error, healthy = true) => {
      if (settled) return;
      settled = true;
      clear();
      releaseWorker(slot, healthy);
      reject(error);
    };
    const resetTimer = () => {
      clearTimeout(inactivityTimer);
      inactivityTimer = setTimeout(() => {
        noteWatchdog();
        fail(watchdogError(), false);
      }, conversionWatchdogMs());
    };
    const onMessage = event => {
      const data = event.data;
      if (data.requestId !== id) return;
      resetTimer();
      if (data.type === 'status') options.onStatus?.(data.message);
      else if (data.type === 'done') {
        if (settled) return;
        settled = true;
        clear();
        releaseWorker(slot, true);
        resolve({
          bytes: data.output ? new Uint8Array(data.output) : null,
          present: data.present !== false,
          elapsedMs: Math.round(performance.now() - started),
        });
      } else if (data.type === 'error') {
        const outOfMemory = /out of memory|memory access out of bounds|cannot enlarge|allocation failed|oom|runtimeerror/i.test(data.message || '');
        fail(friendlyError(data.message), !outOfMemory);
      }
    };
    const onWorkerError = event => fail(friendlyError(event.message || 'converter worker failed'), false);
    const onMessageError = () => fail(new Error('ffmpeg.wasm worker message could not be decoded'), false);
    instance.addEventListener('message', onMessage);
    instance.addEventListener('error', onWorkerError);
    instance.addEventListener('messageerror', onMessageError);
    resetTimer();
    instance.postMessage({id, ...payload}, transfer);
  });
}

export async function extractAudioPcmWithFfmpeg(inputBytes, expectedSamples, options = {}) {
  if (!(inputBytes instanceof Uint8Array)) throw new TypeError('extractAudioPcmWithFfmpeg expects a Uint8Array');
  if (!Number.isInteger(expectedSamples) || expectedSamples < 0) throw new Error('Audio extraction requires an exact non-negative sample count.');
  const copy = new Uint8Array(inputBytes.byteLength);
  copy.set(inputBytes);
  const task = await runWorkerTask({
    type: 'extract-audio',
    inputBytes: copy.buffer,
    expectedSamples,
  }, [copy.buffer], options);
  if (!task.present) {
    return {
      pcm: null,
      present: false,
      engine: 'ffmpeg.wasm',
      elapsedMs: task.elapsedMs,
    };
  }
  const interleaved = new Float32Array(task.bytes.buffer, task.bytes.byteOffset, task.bytes.byteLength / 4);
  const expectedInterleaved = expectedSamples * 2;
  if (interleaved.length !== expectedInterleaved) {
    throw new Error(`ffmpeg audio extraction returned ${interleaved.length} samples; expected ${expectedInterleaved}.`);
  }
  const planar = new Float32Array(expectedInterleaved);
  for (let sample = 0; sample < expectedSamples; sample += 1) {
    planar[sample] = interleaved[sample * 2];
    planar[expectedSamples + sample] = interleaved[sample * 2 + 1];
  }
  return {
    pcm: planar,
    present: true,
    engine: 'ffmpeg.wasm',
    elapsedMs: task.elapsedMs,
  };
}

export async function speedAudioPcmWithFfmpeg(wavBytes, speed, expectedSamples, options = {}) {
  if (!(wavBytes instanceof Uint8Array)) throw new TypeError('speedAudioPcmWithFfmpeg expects WAV bytes');
  if (!Number.isInteger(expectedSamples) || expectedSamples <= 0) throw new Error('Audio speed change requires a positive exact sample count.');
  const resolvedSpeed = normalizeSpeed(speed);
  const copy = new Uint8Array(wavBytes.byteLength);
  copy.set(wavBytes);
  const task = await runWorkerTask({
    type: 'speed-audio',
    inputBytes: copy.buffer,
    speed: resolvedSpeed,
    expectedSamples,
  }, [copy.buffer], options);
  const interleaved = new Float32Array(task.bytes.buffer, task.bytes.byteOffset, task.bytes.byteLength / 4);
  const expectedInterleaved = expectedSamples * 2;
  if (interleaved.length !== expectedInterleaved) {
    throw new Error(`ffmpeg atempo returned ${interleaved.length} samples; expected ${expectedInterleaved}.`);
  }
  const planar = new Float32Array(expectedInterleaved);
  for (let sample = 0; sample < expectedSamples; sample += 1) {
    planar[sample] = interleaved[sample * 2];
    planar[expectedSamples + sample] = interleaved[sample * 2 + 1];
  }
  return {
    pcm: planar,
    speed: resolvedSpeed,
    expectedSamples,
    engine: 'ffmpeg.wasm',
    elapsedMs: task.elapsedMs,
  };
}

async function runAudioMux(type, videoBytes, audioBytes, expectedSamples, options = {}) {
  if (!(videoBytes instanceof Uint8Array) || !(audioBytes instanceof Uint8Array)) throw new TypeError('Audio muxing expects video and audio Uint8Arrays');
  if (!Number.isInteger(expectedSamples) || expectedSamples <= 0) throw new Error('Audio muxing requires a positive exact sample count.');
  const videoCopy = new Uint8Array(videoBytes.byteLength);
  videoCopy.set(videoBytes);
  const audioCopy = new Uint8Array(audioBytes.byteLength);
  audioCopy.set(audioBytes);
  const task = await runWorkerTask({
    type,
    videoBytes: videoCopy.buffer,
    audioBytes: audioCopy.buffer,
    expectedSamples,
  }, [videoCopy.buffer, audioCopy.buffer], options);
  if (!task.bytes || task.bytes.byteLength === 0) throw new Error('ffmpeg audio muxing returned an empty MP4.');
  return {bytes: task.bytes, engine: 'ffmpeg.wasm', elapsedMs: task.elapsedMs};
}

export function muxAacWithFfmpeg(videoBytes, adtsBytes, expectedSamples, options = {}) {
  return runAudioMux('mux-adts', videoBytes, adtsBytes, expectedSamples, options);
}

export function muxPcmWithFfmpeg(videoBytes, wavBytes, expectedSamples, options = {}) {
  return runAudioMux('mux-wav', videoBytes, wavBytes, expectedSamples, options);
}

export async function convertToH264(inputBytes, options = {}) {
  if (inputBytes.byteLength > MAX_CONVERSION_BYTES) {
    throw new Error(`convert-on-load is limited to 100 MB; this file is ${(inputBytes.byteLength / (1024 * 1024)).toFixed(1)} MB.`);
  }
  if (options.preferWebCodecsEncode !== false && isWebCodecsEncoderAvailable()) {
    try {
      return await runConversion(inputBytes, {...options, preferWebCodecsEncode: true});
    } catch (error) {
      if (!(error instanceof HybridEncodeError)) throw error;
      options.onStatus?.('WebCodecs encoding failed; falling back to the full ffmpeg.wasm encoder…');
      return runConversion(inputBytes, {
        ...options,
        preferWebCodecsEncode: false,
        hybridFallbackReason: error.message,
      });
    }
  }
  return runConversion(inputBytes, {...options, preferWebCodecsEncode: false});
}

export {FFMPEG_CORE_VERSION, MAX_CONVERSION_BYTES, MAX_WORKERS};
