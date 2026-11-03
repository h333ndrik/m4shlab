import { MAX_TARGET_LONG_SIDE } from './conversion-settings.js';

const CORE_VERSION = '0.12.10';
const CORE_BASE = `https://cdn.jsdelivr.net/npm/@ffmpeg/core@${CORE_VERSION}/dist/esm`;
const CORE_JS = `${CORE_BASE}/ffmpeg-core.js`;
const CORE_WASM = `${CORE_BASE}/ffmpeg-core.wasm`;
let core = null;
let corePromise = null;
let currentRequestId = null;
let currentLogs = [];

function post(type, data = {}) {
  self.postMessage({type, requestId: currentRequestId, ...data});
}

async function loadCore() {
  if (core) return core;
  if (corePromise) return corePromise;
  corePromise = (async () => {
    post('status', {message: 'Fetching ffmpeg.wasm core (about 31 MB)…'});
    const module = await import(CORE_JS);
    post('status', {message: 'Initializing ffmpeg.wasm…'});
    const config = `${CORE_JS}#${btoa(JSON.stringify({wasmURL: CORE_WASM, workerURL: ''}))}`;
    const instance = await module.default({mainScriptUrlOrBlob: config});
    instance.setLogger(({type, message}) => {
      if (type === 'stderr' && message) {
        currentLogs.push(message);
        if (currentLogs.length > 20) currentLogs.shift();
      }
      post('log', {message, logType: type});
    });
    instance.setProgress(({progress, time}) => post('progress', {progress, time}));
    core = instance;
    return core;
  })().catch(error => {
    corePromise = null;
    throw error;
  });
  return corePromise;
}

function conversionFilter(target) {
  if (target) {
    const width = Math.max(2, Math.floor(target.width / 2) * 2);
    const height = Math.max(2, Math.floor(target.height / 2) * 2);
    return `scale=${width}:${height}:force_original_aspect_ratio=decrease:flags=lanczos,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1`;
  }
  return `scale='if(gte(iw,ih),min(${MAX_TARGET_LONG_SIDE},iw),-2)':'if(gte(iw,ih),-2,min(${MAX_TARGET_LONG_SIDE},ih))',setsar=1`;
}

function conversionArgs(inputName, outputName, target) {
  return [
    '-i', inputName,
    '-map', '0:v:0',
    '-vf', conversionFilter(target),
    '-c:v', 'libx264',
    '-preset', 'veryfast',
    '-profile:v', 'high',
    '-pix_fmt', 'yuv420p',
    '-crf', '23',
    '-r', '30',
    '-g', '30',
    '-keyint_min', '30',
    '-sc_threshold', '0',
    '-bf', '0',
    '-x264-params', 'open-gop=0:scenecut=0',
    '-video_track_timescale', '15360',
    '-an',
    '-movflags', '+faststart',
    outputName,
  ];
}

function decodeY4mArgs(inputName, outputName, target) {
  return [
    '-i', inputName,
    '-map', '0:v:0',
    '-vf', conversionFilter(target),
    '-pix_fmt', 'yuv420p',
    '-r', '30',
    '-an',
    '-f', 'yuv4mpegpipe',
    outputName,
  ];
}

self.onmessage = async event => {
  const {id, type, inputBytes, target, mode = 'encode-wasm'} = event.data;
  if (type !== 'convert') return;
  currentRequestId = id;
  currentLogs = [];
  const inputName = 'input.bin';
  const decodeOnly = mode === 'decode-y4m';
  const outputName = decodeOnly ? 'output.y4m' : 'output.mp4';
  try {
    const ffmpeg = await loadCore();
    try { ffmpeg.FS.unlink(inputName); } catch {}
    try { ffmpeg.FS.unlink(outputName); } catch {}
    post('status', {message: decodeOnly
      ? 'Decoding with ffmpeg.wasm at the capped normalization size…'
      : target
        ? `Converting to H.264 and letterboxing to ${target.width}×${target.height}…`
        : `Converting to H.264 with the ${MAX_TARGET_LONG_SIDE}px target cap…`});
    ffmpeg.FS.writeFile(inputName, new Uint8Array(inputBytes));
    const status = ffmpeg.exec(...(decodeOnly
      ? decodeY4mArgs(inputName, outputName, target)
      : conversionArgs(inputName, outputName, target)));
    ffmpeg.reset();
    if (status !== 0) throw new Error(`ffmpeg exited with status ${status}`);
    const output = ffmpeg.FS.readFile(outputName);
    if (!(output instanceof Uint8Array) || output.byteLength === 0) throw new Error('ffmpeg produced an empty output file');
    const outputCopy = new Uint8Array(output.byteLength);
    outputCopy.set(output);
    try { ffmpeg.FS.unlink(inputName); } catch {}
    try { ffmpeg.FS.unlink(outputName); } catch {}
    self.postMessage({type: 'done', requestId: id, output: outputCopy.buffer, container: decodeOnly ? 'y4m' : 'mp4'}, [outputCopy.buffer]);
  } catch (error) {
    const detail = currentLogs.slice(-3).join(' | ');
    const message = error?.message || String(error);
    self.postMessage({
      type: 'error',
      requestId: id,
      message: detail ? `${message}: ${detail}` : message,
      stack: error?.stack || '',
    });
  } finally {
    currentRequestId = null;
  }
};
