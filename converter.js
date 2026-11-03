import { capNormalizationDimensions } from './conversion-settings.js';
import { HybridEncodeError, encodeY4mWithWebCodecs, isWebCodecsEncoderAvailable } from './hybrid-encoder.js';

const MAX_CONVERSION_BYTES = 100 * 1024 * 1024;
const FFMPEG_CORE_VERSION = '0.12.10';
const INACTIVITY_TIMEOUT_MS = 5 * 60 * 1000;
const MAX_WORKERS = 2;
const workers = [];
const waiters = [];
let nextRequestId = 1;

function createWorkerSlot() {
  const slot = {
    busy: false,
    worker: new Worker(new URL('./converter-worker.js', import.meta.url), {type: 'module'}),
  };
  workers.push(slot);
  return slot;
}

function removeWorkerSlot(slot) {
  const index = workers.indexOf(slot);
  if (index !== -1) workers.splice(index, 1);
  slot.worker.terminate();
}

function acquireWorker() {
  let slot = workers.find(candidate => !candidate.busy);
  if (!slot && workers.length < MAX_WORKERS) slot = createWorkerSlot();
  if (slot) {
    slot.busy = true;
    return Promise.resolve(slot);
  }
  return new Promise(resolve => waiters.push(resolve));
}

function releaseWorker(slot, healthy = true) {
  if (!healthy) {
    removeWorkerSlot(slot);
    const waiter = waiters.shift();
    if (waiter) {
      const replacement = createWorkerSlot();
      replacement.busy = true;
      waiter(replacement);
    }
    return;
  }
  const waiter = waiters.shift();
  if (waiter) waiter(slot);
  else slot.busy = false;
}

function friendlyError(message) {
  if (/out of memory|memory access out of bounds|cannot enlarge|allocation failed|oom|runtimeerror/i.test(message)) {
    return new Error('ffmpeg.wasm ran out of memory during conversion. Try a shorter clip or a lower-resolution source.');
  }
  if (/failed to fetch|networkerror|importing a module|dynamically imported module|load failed/i.test(message)) {
    return new Error('Could not load ffmpeg.wasm from the CDN. Check the network connection; the original file was never uploaded.');
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
        fail(new Error('ffmpeg.wasm stopped responding for 5 minutes. The conversion was stopped; try a smaller file.'), false);
      }, INACTIVITY_TIMEOUT_MS);
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
