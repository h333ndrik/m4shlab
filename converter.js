const MAX_CONVERSION_BYTES = 100 * 1024 * 1024;
const FFMPEG_CORE_VERSION = '0.12.10';
const INACTIVITY_TIMEOUT_MS = 5 * 60 * 1000;
let worker = null;
let nextRequestId = 1;
let queue = Promise.resolve();

function resetWorker() {
  if (worker) worker.terminate();
  worker = null;
}

function ensureWorker() {
  if (worker) return worker;
  worker = new Worker(new URL('./converter-worker.js', import.meta.url), {type: 'module'});
  return worker;
}

function friendlyError(message) {
  if (/out of memory|memory access out of bounds|cannot enlarge|allocation failed|oom|runtimeerror|abort/i.test(message)) {
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
  const target = options.target ? {
    width: Math.max(2, Math.floor(options.target.width / 2) * 2),
    height: Math.max(2, Math.floor(options.target.height / 2) * 2),
  } : null;
  const instance = ensureWorker();
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
    const fail = error => {
      if (settled) return;
      settled = true;
      clear();
      reject(error);
    };
    const resetTimer = () => {
      clearTimeout(inactivityTimer);
      inactivityTimer = setTimeout(() => {
        resetWorker();
        fail(new Error('ffmpeg.wasm stopped responding for 5 minutes. The conversion was stopped; try a smaller file.'));
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
        resolve({
          bytes: new Uint8Array(data.output),
          target,
          engine: 'ffmpeg.wasm',
          coreVersion: FFMPEG_CORE_VERSION,
          elapsedMs: Math.round(performance.now() - started),
        });
      } else if (data.type === 'error') {
        if (/out of memory|memory access out of bounds|cannot enlarge|allocation failed|oom|runtimeerror|abort/i.test(data.message || '')) resetWorker();
        fail(friendlyError(data.message));
      }
    };
    const onWorkerError = event => {
      resetWorker();
      fail(friendlyError(event.message || 'converter worker failed'));
    };
    const onMessageError = () => {
      resetWorker();
      fail(friendlyError('converter worker message could not be decoded'));
    };
    instance.addEventListener('message', onMessage);
    instance.addEventListener('error', onWorkerError);
    instance.addEventListener('messageerror', onMessageError);
    resetTimer();
    options.onStatus?.('Loading ffmpeg.wasm (about 31 MB, only on first conversion)…');
    options.onProgress?.({progress: null, time: null});
    const copy = new Uint8Array(inputBytes.byteLength);
    copy.set(inputBytes);
    instance.postMessage({id, type: 'convert', inputBytes: copy.buffer, target}, [copy.buffer]);
  });
}

export function convertToH264(inputBytes, options = {}) {
  if (inputBytes.byteLength > MAX_CONVERSION_BYTES) {
    return Promise.reject(new Error(`convert-on-load is limited to 100 MB; this file is ${(inputBytes.byteLength / (1024 * 1024)).toFixed(1)} MB.`));
  }
  const job = queue.then(
    () => runConversion(inputBytes, options),
    () => runConversion(inputBytes, options),
  );
  queue = job.catch(() => {});
  return job;
}

export {FFMPEG_CORE_VERSION, MAX_CONVERSION_BYTES};
