import { parseMp4 } from './parser/mp4.js';
import { extractNals } from './parser/nal.js';
import { parseSps } from './parser/sps.js';
import { parseAvcConfig } from './merge.js';
import { buildNormalizedMp4, chooseNormalizationTarget } from './webcodecs-muxer.js';

const OUTPUT_FPS = 30;
const OUTPUT_DURATION_US = 1_000_000 / OUTPUT_FPS;
const KEYFRAME_INTERVAL = 30;
const MAX_QUEUE = 8;
const MAX_NORMALIZATION_BYTES = 100 * 1024 * 1024;

export class WebCodecsError extends Error {
  constructor(message, cause = null) {
    super(message);
    this.name = 'WebCodecsError';
    this.cause = cause;
  }
}

function throwIfAborted(signal) {
  if (signal?.aborted) throw new DOMException('Normalization aborted', 'AbortError');
}

function delay(milliseconds = 0) {
  return new Promise(resolve => setTimeout(resolve, milliseconds));
}

function copyBytes(bytes) {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy;
}

function hexByte(value) {
  return value.toString(16).padStart(2, '0');
}

function encoderCodec(width, height) {
  const pixels = width * height;
  const level = pixels > 1920 * 1080 ? 52 : pixels > 1280 * 720 ? 42 : 40;
  return `avc1.4d${hexByte(level)}`;
}

function bitrateFor(width, height) {
  return Math.max(500_000, Math.min(20_000_000, Math.round(width * height * 3)));
}

async function selectEncoderConfig(width, height) {
  const base = {
    width,
    height,
    framerate: OUTPUT_FPS,
    bitrate: bitrateFor(width, height),
    bitrateMode: 'variable',
    latencyMode: 'realtime',
    avc: {format: 'avc'},
  };
  const candidates = [encoderCodec(width, height), 'avc1.42001f', 'avc1.640028'];
  for (const codec of [...new Set(candidates)]) {
    const config = {...base, codec};
    try {
      const support = await VideoEncoder.isConfigSupported(config);
      if (support.supported) return {config: {...support.config, ...base, codec}, codec};
    } catch {
      // Try the next compatible H.264 profile.
    }
  }
  throw new WebCodecsError('This browser exposes WebCodecs but cannot encode H.264 at the requested size. ffmpeg.wasm fallback is required.');
}

async function selectDecoderConfig(bytes, track) {
  const avc = parseAvcConfig(bytes, track.avcC);
  const description = copyBytes(avc.raw);
  const codec = `avc1.${hexByte(avc.profileIdc)}${hexByte(avc.profileCompatibility)}${hexByte(avc.levelIdc)}`;
  const config = {codec, description, optimizeForLatency: true};
  try {
    const support = await VideoDecoder.isConfigSupported(config);
    if (support.supported) return {config, codec};
  } catch {
    // The caller receives one actionable error below.
  }
  throw new WebCodecsError(`This browser cannot decode the source H.264 configuration (${codec}) with WebCodecs. ffmpeg.wasm fallback is required.`);
}

function sourceChunks(bytes, track) {
  const nals = extractNals(bytes, track);
  const idrSamples = new Set(nals.filter(nal => nal.type === 5).map(nal => nal.sampleIndex));
  const durations = track.stts?.durations;
  if (!durations || durations.length !== track.samples.length) {
    throw new WebCodecsError('The source has no complete video sample timing table.');
  }
  let timestamp = 0;
  return track.samples.map(sample => {
    const duration = Math.round(durations[sample.index] * 1_000_000 / track.mdhd.timescale);
    const chunk = {
      type: idrSamples.has(sample.index) ? 'key' : 'delta',
      timestamp,
      duration,
      data: copyBytes(bytes.subarray(sample.offset, sample.offset + sample.size)),
    };
    timestamp += Math.max(1, duration);
    return chunk;
  });
}

function createCanvas(width, height) {
  if (typeof OffscreenCanvas === 'function') return new OffscreenCanvas(width, height);
  if (typeof document !== 'undefined') {
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    return canvas;
  }
  throw new WebCodecsError('This browser cannot create the canvas required for WebCodecs normalization.');
}

function limitedI420Frame(rgba, width, height, timestamp) {
  const luma = new Uint8Array(width * height);
  const chromaWidth = width >> 1;
  const chromaHeight = height >> 1;
  const chroma = new Uint8Array(chromaWidth * chromaHeight * 2);
  const uOffset = 0;
  const vOffset = chromaWidth * chromaHeight;

  for (let y = 0; y < height; y += 2) {
    for (let x = 0; x < width; x += 2) {
      let red = 0;
      let green = 0;
      let blue = 0;
      for (let row = 0; row < 2; row += 1) {
        for (let column = 0; column < 2; column += 1) {
          const pixel = ((y + row) * width + x + column) * 4;
          const r = rgba[pixel];
          const g = rgba[pixel + 1];
          const b = rgba[pixel + 2];
          red += r;
          green += g;
          blue += b;
          const value = 16 + (0.183 * r) + (0.614 * g) + (0.062 * b);
          luma[(y + row) * width + x + column] = Math.max(0, Math.min(255, Math.round(value)));
        }
      }
      red /= 4;
      green /= 4;
      blue /= 4;
      const chromaIndex = (y >> 1) * chromaWidth + (x >> 1);
      chroma[uOffset + chromaIndex] = Math.max(0, Math.min(255, Math.round(128 - (0.101 * red) - (0.339 * green) + (0.439 * blue))));
      chroma[vOffset + chromaIndex] = Math.max(0, Math.min(255, Math.round(128 + (0.439 * red) - (0.399 * green) - (0.040 * blue))));
    }
  }

  const buffer = new Uint8Array(luma.byteLength + chroma.byteLength);
  buffer.set(luma, 0);
  buffer.set(chroma, luma.byteLength);
  return new VideoFrame(buffer, {
    format: 'I420',
    codedWidth: width,
    codedHeight: height,
    timestamp,
    duration: Math.round(OUTPUT_DURATION_US),
    colorSpace: {primaries: 'bt709', transfer: 'bt709', matrix: 'bt709', fullRange: false},
  });
}

function unescapeRbsp(bytes) {
  const output = [];
  let zeros = 0;
  for (const value of bytes) {
    if (zeros >= 2 && value === 3) {
      zeros = 0;
      continue;
    }
    output.push(value);
    zeros = value === 0 ? zeros + 1 : 0;
  }
  return Uint8Array.from(output);
}

function escapeRbsp(bytes) {
  const output = [];
  let zeros = 0;
  for (const value of bytes) {
    if (zeros >= 2 && value <= 3) {
      output.push(3);
      zeros = 0;
    }
    output.push(value);
    zeros = value === 0 ? zeros + 1 : 0;
  }
  return Uint8Array.from(output);
}

class SliceBits {
  constructor(bytes) {
    this.bytes = bytes;
    this.bit = 0;
  }

  readBit() {
    if (this.bit >= this.bytes.byteLength * 8) throw new WebCodecsError('Truncated encoded slice header.');
    const value = (this.bytes[this.bit >> 3] >> (7 - (this.bit & 7))) & 1;
    this.bit += 1;
    return value;
  }

  readBits(count) {
    let value = 0;
    for (let i = 0; i < count; i += 1) value = (value * 2) + this.readBit();
    return value;
  }

  readUe() {
    let zeros = 0;
    while (this.readBit() === 0) {
      zeros += 1;
      if (zeros > 31) throw new WebCodecsError('Invalid Exp-Golomb value in encoded slice header.');
    }
    return (2 ** zeros) - 1 + (zeros === 0 ? 0 : this.readBits(zeros));
  }
}

function patchSliceFrameNumber(nal, log2MaxFrameNum, frameNumber) {
  if ((nal[0] & 0x1f) !== 1) return copyBytes(nal);
  const rbsp = unescapeRbsp(nal.subarray(1));
  const bits = new SliceBits(rbsp);
  bits.readUe();
  bits.readUe();
  bits.readUe();
  const frameStart = bits.bit;
  if (frameStart + log2MaxFrameNum > rbsp.byteLength * 8) throw new WebCodecsError('Encoded slice is too short to patch its frame number.');
  const value = frameNumber % (2 ** log2MaxFrameNum);
  for (let i = 0; i < log2MaxFrameNum; i += 1) {
    const position = frameStart + i;
    if ((value >> (log2MaxFrameNum - 1 - i)) & 1) rbsp[position >> 3] |= 1 << (7 - (position & 7));
    else rbsp[position >> 3] &= ~(1 << (7 - (position & 7)));
  }
  const escaped = escapeRbsp(rbsp);
  const output = new Uint8Array(escaped.byteLength + 1);
  output[0] = nal[0];
  output.set(escaped, 1);
  return output;
}

function writeLengthPrefix(length, width) {
  const output = new Uint8Array(width);
  const view = new DataView(output.buffer);
  if (width === 1) view.setUint8(0, length);
  else if (width === 2) view.setUint16(0, length);
  else if (width === 3) {
    view.setUint8(0, (length >>> 16) & 0xff);
    view.setUint16(1, length & 0xffff);
  } else view.setUint32(0, length);
  return output;
}

function patchSampleFrameNumber(data, lengthSize, log2MaxFrameNum, frameNumber) {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const parts = [];
  let offset = 0;
  while (offset < data.byteLength) {
    if (offset + lengthSize > data.byteLength) throw new WebCodecsError('Encoded chunk has a truncated NAL length prefix.');
    const length = lengthSize === 1 ? view.getUint8(offset)
      : lengthSize === 2 ? view.getUint16(offset)
        : lengthSize === 3 ? ((view.getUint8(offset) << 16) | view.getUint16(offset + 1))
          : view.getUint32(offset);
    const start = offset + lengthSize;
    const end = start + length;
    if (length === 0 || end > data.byteLength) throw new WebCodecsError('Encoded chunk contains an invalid NAL length.');
    const nal = patchSliceFrameNumber(data.subarray(start, end), log2MaxFrameNum, frameNumber);
    parts.push(writeLengthPrefix(nal.byteLength, lengthSize), nal);
    offset = end;
  }
  const output = new Uint8Array(parts.reduce((total, part) => total + part.byteLength, 0));
  offset = 0;
  for (const part of parts) {
    output.set(part, offset);
    offset += part.byteLength;
  }
  return output;
}

function alignFrameNumbers(chunks, description, frameNumberBase) {
  if (!Number.isInteger(frameNumberBase) || frameNumberBase < 0) throw new WebCodecsError('frameNumberBase must be a non-negative integer.');
  const avc = parseAvcConfig(description, {payloadStart: 0, payloadEnd: description.byteLength});
  if (!avc.sps.length) throw new WebCodecsError('The normalized avcC has no SPS.');
  const sps = parseSps(avc.sps[0]);
  if (sps.picOrderCntType !== 2) {
    throw new WebCodecsError('The browser encoder emitted picture-order counts that cannot be aligned across clips. ffmpeg.wasm fallback is required.');
  }
  const nextKeyframe = chunks.findIndex((chunk, index) => index > 0 && chunk.key);
  const firstGopEnd = nextKeyframe === -1 ? chunks.length : nextKeyframe;
  let patched = 0;
  for (let index = 1; index < firstGopEnd; index += 1) {
    if (chunks[index].key) continue;
    chunks[index] = {
      ...chunks[index],
      data: patchSampleFrameNumber(
        chunks[index].data,
        avc.lengthSize,
        sps.log2MaxFrameNum,
        frameNumberBase + index,
      ),
    };
    patched += 1;
  }
  if (patched === 0) throw new WebCodecsError('No non-key slices were available for frame-number alignment.');
  return {patched, log2MaxFrameNum: sps.log2MaxFrameNum, picOrderCntType: sps.picOrderCntType};
}

export function isWebCodecsAvailable() {
  return typeof globalThis.VideoDecoder === 'function'
    && typeof globalThis.VideoEncoder === 'function'
    && typeof globalThis.VideoFrame === 'function';
}

export async function normalizeWithWebCodecs(inputBytes, options = {}) {
  if (!isWebCodecsAvailable()) {
    throw new WebCodecsError('WebCodecs VideoDecoder/VideoEncoder is unavailable; ffmpeg.wasm fallback is required.');
  }
  if (!(inputBytes instanceof Uint8Array)) throw new TypeError('normalizeWithWebCodecs expects a Uint8Array');
  if (inputBytes.byteLength > MAX_NORMALIZATION_BYTES) {
    throw new WebCodecsError(`WebCodecs normalization is limited to 100 MB; this file is ${(inputBytes.byteLength / (1024 * 1024)).toFixed(1)} MB.`);
  }
  throwIfAborted(options.signal);

  const started = performance.now();
  const parsed = parseMp4(inputBytes);
  const target = chooseNormalizationTarget(options.target ?? parsed.videoTrack);
  const decoderSelection = await selectDecoderConfig(inputBytes, parsed.videoTrack);
  const encoderSelection = await selectEncoderConfig(target.width, target.height);
  const chunks = sourceChunks(inputBytes, parsed.videoTrack);
  if (chunks.length === 0 || chunks[0].type !== 'key') {
    throw new WebCodecsError('WebCodecs normalization requires an IDR in the first source sample.');
  }

  const canvas = createCanvas(target.width, target.height);
  const context = canvas.getContext('2d', {alpha: false});
  if (!context) throw new WebCodecsError('The browser could not create a 2D canvas for normalization.');
  context.fillStyle = '#000';

  const encoded = [];
  let description = null;
  let encoderError = null;
  let decoderError = null;
  let encodedFrames = 0;
  let pendingFrames = 0;
  let processing = Promise.resolve();

  const encoder = new VideoEncoder({
    output: (chunk, metadata) => {
      const data = new Uint8Array(chunk.byteLength);
      chunk.copyTo(data);
      encoded.push({data, key: chunk.type === 'key', timestamp: chunk.timestamp, duration: chunk.duration ?? 0});
      if (!description && metadata?.decoderConfig?.description) {
        description = copyBytes(new Uint8Array(metadata.decoderConfig.description));
      }
    },
    error: error => {
      encoderError = error;
    },
  });
  const decoder = new VideoDecoder({
    output: frame => {
      pendingFrames += 1;
      processing = processing.then(async () => {
        try {
          throwIfAborted(options.signal);
          if (encoderError) throw encoderError;
          const scale = Math.min(target.width / frame.displayWidth, target.height / frame.displayHeight);
          const drawWidth = Math.max(1, Math.round(frame.displayWidth * scale));
          const drawHeight = Math.max(1, Math.round(frame.displayHeight * scale));
          const drawX = Math.floor((target.width - drawWidth) / 2);
          const drawY = Math.floor((target.height - drawHeight) / 2);
          context.fillRect(0, 0, target.width, target.height);
          context.drawImage(frame, drawX, drawY, drawWidth, drawHeight);
          const timestamp = Math.round(encodedFrames * OUTPUT_DURATION_US);
          const image = context.getImageData(0, 0, target.width, target.height);
          const outputFrame = limitedI420Frame(image.data, target.width, target.height, timestamp);
          try {
            encoder.encode(outputFrame, {keyFrame: encodedFrames % KEYFRAME_INTERVAL === 0});
            encodedFrames += 1;
          } finally {
            outputFrame.close();
          }
          options.onProgress?.(Math.min(0.95, encodedFrames / chunks.length));
        } finally {
          frame.close();
          pendingFrames -= 1;
        }
      }).catch(error => {
        encoderError ??= error;
      });
    },
    error: error => {
      decoderError = error;
    },
  });

  try {
    encoder.configure(encoderSelection.config);
    decoder.configure(decoderSelection.config);
    options.onStatus?.(`Decoding H.264 and encoding a normalized ${target.width}×${target.height} stream with WebCodecs…`);

    for (const source of chunks) {
      throwIfAborted(options.signal);
      if (encoderError || decoderError) throw encoderError ?? decoderError;
      while (decoder.decodeQueueSize >= MAX_QUEUE || encoder.encodeQueueSize >= MAX_QUEUE || pendingFrames >= MAX_QUEUE) {
        throwIfAborted(options.signal);
        if (encoderError || decoderError) throw encoderError ?? decoderError;
        await delay(2);
      }
      decoder.decode(new EncodedVideoChunk(source));
      options.onProgress?.(Math.min(0.7, (source.timestamp / (chunks.length * 1_000_000 / OUTPUT_FPS)) * 0.7));
    }

    await decoder.flush();
    await processing;
    if (encoderError || decoderError) throw encoderError ?? decoderError;
    await encoder.flush();
    if (encoderError) throw encoderError;
    if (!description) throw new WebCodecsError('The browser H.264 encoder did not provide an avcC decoder description.');
    if (encoded.length !== encodedFrames) {
      throw new WebCodecsError(`The browser encoded ${encoded.length} chunks for ${encodedFrames} frames.`);
    }

    encoded.sort((left, right) => left.timestamp - right.timestamp);
    const frameAlignment = options.frameNumberBase === undefined
      ? null
      : alignFrameNumbers(encoded, description, options.frameNumberBase);
    const muxed = buildNormalizedMp4({
      chunks: encoded,
      description,
      width: target.width,
      height: target.height,
    });
    const outputMp4 = parseMp4(muxed.bytes);
    if (outputMp4.videoTrack.samples.length !== encoded.length) {
      throw new WebCodecsError('The normalized MP4 sample table does not match the encoder output.');
    }
    const outputNals = extractNals(muxed.bytes, outputMp4.videoTrack);
    const firstSample = outputNals.filter(nal => nal.sampleIndex === 0);
    const idrCount = outputNals.filter(nal => nal.type === 5).length;
    const firstSampleIdrCount = firstSample.filter(nal => nal.type === 5).length;
    if (firstSampleIdrCount < 1) {
      throw new WebCodecsError('The normalized stream does not start with an IDR frame.');
    }
    for (const chunk of muxed.report.chunks) {
      if (!chunk.key && extractNalsFromData(chunk.data, outputMp4.videoTrack.lengthSize).some(nal => nal.type === 5)) {
        throw new WebCodecsError('The normalized stream contains an IDR in a chunk not marked as a key chunk.');
      }
    }

    options.onProgress?.(1);
    return {
      bytes: muxed.bytes,
      target: {width: target.width, height: target.height},
      engine: 'WebCodecs',
      elapsedMs: Math.round(performance.now() - started),
      decoderCodec: decoderSelection.codec,
      encoderCodec: encoderSelection.codec,
      sourceSamples: chunks.length,
      outputSamples: encoded.length,
      outputBytes: muxed.bytes.byteLength,
      idrCount,
      keyframes: muxed.report.keyframes,
      timescale: muxed.report.timescale,
      fps: OUTPUT_FPS,
      profile: encoderSelection.codec.startsWith('avc1.42') ? 'Baseline' : encoderSelection.codec.startsWith('avc1.64') ? 'High' : 'Main',
      pixelFormat: 'H.264 yuv420p limited range',
      frameNumberBase: options.frameNumberBase ?? 0,
      frameAlignment,
    };
  } finally {
    if (decoder.state !== 'closed') decoder.close();
    if (encoder.state !== 'closed') encoder.close();
  }
}

export { MAX_NORMALIZATION_BYTES };

function extractNalsFromData(bytes, lengthSize) {
  const sample = {index: 0, offset: 0, size: bytes.byteLength};
  let offset = 0;
  const nals = [];
  while (offset < bytes.byteLength) {
    let length = 0;
    for (let i = 0; i < lengthSize; i += 1) length = (length * 256) + bytes[offset + i];
    offset += lengthSize;
    nals.push({type: bytes[offset] & 0x1f});
    offset += length;
  }
  if (offset !== bytes.byteLength) throw new WebCodecsError('An encoded chunk has an invalid NAL length prefix.');
  return nals;
}
