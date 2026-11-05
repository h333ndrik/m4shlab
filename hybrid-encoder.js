import { buildNormalizedMp4 } from './webcodecs-muxer.js';
import { parseMp4 } from './parser/mp4.js';
import { extractNals } from './parser/nal.js';
import { isNormalizationKeyframe } from './looks.js';

const FPS = 30;
const FRAME_DURATION_US = Math.round(1_000_000 / FPS);
const MAX_QUEUE = 8;

export class HybridEncodeError extends Error {
  constructor(message, cause = null) {
    super(message);
    this.name = 'HybridEncodeError';
    this.cause = cause;
  }
}

function hexByte(value) {
  return value.toString(16).padStart(2, '0');
}

function encoderCodec(width, height) {
  const pixels = width * height;
  const level = pixels > 1920 * 1080 ? 52 : pixels > 1280 * 720 ? 42 : 40;
  return `avc1.4d${hexByte(level)}`;
}

async function selectEncoderConfig(width, height) {
  const base = {
    width,
    height,
    framerate: FPS,
    bitrate: Math.max(500_000, Math.min(20_000_000, Math.round(width * height * 3))),
    bitrateMode: 'variable',
    latencyMode: 'realtime',
    avc: {format: 'avc'},
  };
  for (const codec of [...new Set([encoderCodec(width, height), 'avc1.42001f', 'avc1.640028'])]) {
    try {
      const support = await VideoEncoder.isConfigSupported({...base, codec});
      if (support.supported) return {...support.config, ...base, codec};
    } catch {}
  }
  throw new HybridEncodeError('This browser cannot encode H.264 with WebCodecs at the normalization target.');
}

function parseY4m(bytes) {
  const headerEnd = bytes.indexOf(10);
  if (headerEnd < 0) throw new HybridEncodeError('ffmpeg.wasm returned a truncated Y4M header.');
  const header = String.fromCharCode(...bytes.subarray(0, headerEnd));
  const width = Number(/W(\d+)/.exec(header)?.[1]);
  const height = Number(/H(\d+)/.exec(header)?.[1]);
  const chroma = /C([A-Za-z0-9]+)/.exec(header)?.[1] ?? '';
  if (!width || !height) throw new HybridEncodeError('ffmpeg.wasm returned Y4M without valid dimensions.');
  if (!/^420/.test(chroma)) throw new HybridEncodeError(`ffmpeg.wasm returned unsupported Y4M chroma ${chroma || 'unknown'}.`);
  const frameBytes = width * height * 3 / 2;
  const offsets = [];
  let offset = headerEnd + 1;
  while (offset < bytes.byteLength) {
    const newline = bytes.indexOf(10, offset);
    if (newline < 0 || String.fromCharCode(...bytes.subarray(offset, newline)).split(' ')[0] !== 'FRAME') {
      throw new HybridEncodeError('ffmpeg.wasm returned a malformed Y4M frame header.');
    }
    offset = newline + 1;
    if (offset + frameBytes > bytes.byteLength) throw new HybridEncodeError('ffmpeg.wasm returned a truncated Y4M frame.');
    offsets.push(offset);
    offset += frameBytes;
  }
  if (offsets.length === 0) throw new HybridEncodeError('ffmpeg.wasm decoded no frames.');
  return {width, height, frameBytes, offsets};
}

export function isWebCodecsEncoderAvailable() {
  return typeof globalThis.VideoEncoder === 'function' && typeof globalThis.VideoFrame === 'function';
}

export async function encodeY4mWithWebCodecs(y4mBytes, options = {}) {
  if (!isWebCodecsEncoderAvailable()) throw new HybridEncodeError('WebCodecs VideoEncoder is unavailable.');
  const started = performance.now();
  const y4m = parseY4m(y4mBytes);
  const config = await selectEncoderConfig(y4m.width, y4m.height);
  const chunks = [];
  let description = null;
  let encoderError = null;
  let encodedFrames = 0;
  const encoder = new VideoEncoder({
    output: (chunk, metadata) => {
      const data = new Uint8Array(chunk.byteLength);
      chunk.copyTo(data);
      chunks.push({data, key: chunk.type === 'key', timestamp: chunk.timestamp, duration: chunk.duration ?? FRAME_DURATION_US});
      if (!description && metadata?.decoderConfig?.description) {
        description = new Uint8Array(metadata.decoderConfig.description);
      }
    },
    error: error => {
      encoderError = error;
    },
  });

  try {
    encoder.configure(config);
    options.onStatus?.(`Encoding ${y4m.offsets.length} decoded frames with WebCodecs H.264…`);
    for (let index = 0; index < y4m.offsets.length; index += 1) {
      if (options.signal?.aborted) throw new DOMException('Conversion aborted', 'AbortError');
      if (encoderError) throw encoderError;
      while (encoder.encodeQueueSize >= MAX_QUEUE) {
        await new Promise(resolve => setTimeout(resolve, 2));
        if (encoderError) throw encoderError;
      }
      const frame = new VideoFrame(y4mBytes.subarray(y4m.offsets[index], y4m.offsets[index] + y4m.frameBytes), {
        format: 'I420',
        codedWidth: y4m.width,
        codedHeight: y4m.height,
        timestamp: index * FRAME_DURATION_US,
        duration: FRAME_DURATION_US,
        colorSpace: {primaries: 'bt709', transfer: 'bt709', matrix: 'bt709', fullRange: false},
      });
      try {
        encoder.encode(frame, {keyFrame: isNormalizationKeyframe(index)});
        encodedFrames += 1;
      } finally {
        frame.close();
      }
      options.onProgress?.(Math.min(0.98, encodedFrames / y4m.offsets.length));
    }
    await encoder.flush();
    if (encoderError) throw encoderError;
    if (!description) throw new HybridEncodeError('The WebCodecs encoder did not provide an avcC description.');
    if (chunks.length !== encodedFrames) throw new HybridEncodeError(`WebCodecs returned ${chunks.length} chunks for ${encodedFrames} frames.`);
    chunks.sort((a, b) => a.timestamp - b.timestamp);
    const muxed = buildNormalizedMp4({
      chunks,
      description,
      width: y4m.width,
      height: y4m.height,
    });
    const parsed = parseMp4(muxed.bytes);
    const nals = extractNals(muxed.bytes, parsed.videoTrack);
    if (nals.filter(nal => nal.sampleIndex === 0 && nal.type === 5).length < 1) {
      throw new HybridEncodeError('The WebCodecs output does not begin with an IDR frame.');
    }
    options.onProgress?.(1);
    return {
      bytes: muxed.bytes,
      width: y4m.width,
      height: y4m.height,
      outputSamples: encodedFrames,
      encoderCodec: config.codec,
      elapsedMs: Math.round(performance.now() - started),
      keyframes: muxed.report.keyframes,
    };
  } catch (error) {
    if (encoderError) throw new HybridEncodeError(`WebCodecs encode failed: ${encoderError.message ?? encoderError}`);
    throw error instanceof HybridEncodeError ? error : new HybridEncodeError(`WebCodecs encode failed: ${error.message ?? error}`, error);
  } finally {
    if (encoder.state !== 'closed') encoder.close();
  }
}
