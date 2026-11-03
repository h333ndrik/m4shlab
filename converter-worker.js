import { MAX_TARGET_LONG_SIDE } from './conversion-settings.js';
import { atempoFilter } from './speed.js';

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

function extractPcmArgs(inputName, outputName, expectedSamples) {
  return [
    '-i', inputName,
    '-map', '0:a:0',
    '-vn',
    '-ac', '2',
    '-ar', '48000',
    '-af', `apad=whole_len=${expectedSamples},atrim=end_sample=${expectedSamples}`,
    '-f', 'f32le',
    outputName,
  ];
}

function speedPcmArgs(inputName, outputName, expectedSamples, speed) {
  return [
    '-i', inputName,
    '-vn',
    '-ac', '2',
    '-ar', '48000',
    '-af', `${atempoFilter(speed)},apad=whole_len=${expectedSamples},atrim=end_sample=${expectedSamples}`,
    '-f', 'f32le',
    outputName,
  ];
}

function muxAudioArgs(videoName, audioName, outputName, expectedSamples, encodeAudio) {
  return [
    '-i', videoName,
    '-i', audioName,
    '-map', '0:v:0',
    '-map', '1:a:0',
    '-c:v', 'copy',
    ...(encodeAudio
      ? ['-c:a', 'aac', '-b:a', '128k', '-ar', '48000', '-ac', '2']
      : ['-c:a', 'copy']),
    '-t', (expectedSamples / 48000).toFixed(9),
    '-movflags', '+faststart',
    outputName,
  ];
}

function cleanupFiles(ffmpeg, names) {
  for (const name of names) {
    try { ffmpeg.FS.unlink(name); } catch {}
  }
}

self.onmessage = async event => {
  const {id, type, inputBytes, videoBytes, audioBytes, expectedSamples, target, speed, mode = 'encode-wasm'} = event.data;
  if (!['convert', 'extract-audio', 'speed-audio', 'mux-adts', 'mux-wav'].includes(type)) return;
  currentRequestId = id;
  currentLogs = [];
  const inputName = type === 'convert' || type === 'extract-audio' ? 'input.bin' : type === 'speed-audio' ? 'input.wav' : 'video.mp4';
  const audioName = type === 'mux-adts' ? 'audio.aac' : 'audio.wav';
  const decodeOnly = mode === 'decode-y4m';
  const outputName = type === 'extract-audio' || type === 'speed-audio' ? 'output.pcm' : decodeOnly ? 'output.y4m' : 'output.mp4';
  try {
    const ffmpeg = await loadCore();
    cleanupFiles(ffmpeg, [inputName, audioName, outputName, 'output.pcm']);
    let status;
    let resultBytes;
    let present = true;
    if (type === 'convert') {
      post('status', {message: decodeOnly
        ? 'Decoding with ffmpeg.wasm at the capped normalization size…'
        : target
          ? `Converting to H.264 and letterboxing to ${target.width}×${target.height}…`
          : `Converting to H.264 with the ${MAX_TARGET_LONG_SIDE}px target cap…`});
      ffmpeg.FS.writeFile(inputName, new Uint8Array(inputBytes));
      status = ffmpeg.exec(...(decodeOnly
        ? decodeY4mArgs(inputName, outputName, target)
        : conversionArgs(inputName, outputName, target)));
      if (status !== 0) throw new Error(`ffmpeg exited with status ${status}`);
      resultBytes = ffmpeg.FS.readFile(outputName);
    } else if (type === 'extract-audio') {
      post('status', {message: 'Extracting and resampling the first audio track with ffmpeg.wasm…'});
      ffmpeg.FS.writeFile(inputName, new Uint8Array(inputBytes));
      status = ffmpeg.exec(...extractPcmArgs(inputName, 'output.pcm', expectedSamples));
      if (status !== 0) {
        const logs = currentLogs.join(' | ');
        if (/matches no streams|does not contain any stream/i.test(logs)) present = false;
        else throw new Error(`ffmpeg audio extraction exited with status ${status}`);
      } else {
        resultBytes = ffmpeg.FS.readFile('output.pcm');
      }
    } else if (type === 'speed-audio') {
      post('status', {message: `Time-stretching audio to ${Number(speed).toFixed(1)}× with pitch-preserving atempo…`});
      ffmpeg.FS.writeFile(inputName, new Uint8Array(inputBytes));
      status = ffmpeg.exec(...speedPcmArgs(inputName, outputName, expectedSamples, speed));
      if (status !== 0) throw new Error(`ffmpeg audio speed change exited with status ${status}`);
      resultBytes = ffmpeg.FS.readFile(outputName);
    } else {
      post('status', {message: type === 'mux-adts' ? 'Muxing WebCodecs AAC audio and copied video…' : 'Encoding AAC and muxing merged audio…'});
      ffmpeg.FS.writeFile(inputName, new Uint8Array(videoBytes));
      ffmpeg.FS.writeFile(audioName, new Uint8Array(audioBytes));
      status = ffmpeg.exec(...muxAudioArgs(inputName, audioName, outputName, expectedSamples, type === 'mux-wav'));
      if (status !== 0) throw new Error(`ffmpeg audio mux exited with status ${status}`);
      resultBytes = ffmpeg.FS.readFile(outputName);
    }
    ffmpeg.reset();
    if (present && (!(resultBytes instanceof Uint8Array) || resultBytes.byteLength === 0)) throw new Error('ffmpeg produced an empty output file');
    if (!present) {
      self.postMessage({type: 'done', requestId: id, present: false});
      return;
    }
    const outputCopy = new Uint8Array(resultBytes.byteLength);
    outputCopy.set(resultBytes);
    self.postMessage({
      type: 'done',
      requestId: id,
      output: outputCopy.buffer,
      container: type === 'extract-audio' || type === 'speed-audio' ? 'f32le' : decodeOnly ? 'y4m' : 'mp4',
      present: true,
    }, [outputCopy.buffer]);
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
