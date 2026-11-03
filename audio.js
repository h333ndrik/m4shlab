import { childBoxes, parseMp4 } from './parser/mp4.js';

export class RuntimeError extends Error {
  constructor(message) {
    super(message);
    this.name = 'RuntimeError';
  }
}

const AUDIO_SAMPLE_RATE = 48000;
const AUDIO_CHANNELS = 2;
const DEFAULT_AUDIO_BITRATE = 128000;
const AAC_FRAME_SAMPLES = 1024;

export function samplesPerFrame(fps, sampleRate = AUDIO_SAMPLE_RATE) {
  if (!Number.isFinite(fps) || fps <= 0) throw new RuntimeError('Audio assembly requires a positive video frame rate.');
  const samples = sampleRate / fps;
  if (!Number.isInteger(samples)) {
    throw new RuntimeError(`Audio assembly requires ${sampleRate} Hz to divide exactly by ${fps} fps; the sequence cannot be sample-aligned.`);
  }
  return samples;
}

export function silencePcm(frames, sampleRate = AUDIO_SAMPLE_RATE, channels = AUDIO_CHANNELS) {
  if (!Number.isInteger(frames) || frames < 0) throw new RuntimeError('Silence needs a non-negative integer frame count.');
  return new Float32Array(frames * channels);
}

function assertClipAudio(entry, frameSamples, channels) {
  if (!entry || !Number.isInteger(entry.frames) || entry.frames < 0) {
    throw new RuntimeError('Every audio timeline entry needs a non-negative integer frame count.');
  }
  if (entry.pcm === null || entry.pcm === undefined) return null;
  if (!(entry.pcm instanceof Float32Array)) throw new RuntimeError('Clip audio must be planar Float32 PCM.');
  const expected = entry.frames * frameSamples * channels;
  if (entry.pcm.length !== expected) {
    throw new RuntimeError(`Clip audio length ${entry.pcm.length} does not match ${entry.frames} frames × ${frameSamples} samples × ${channels} channels (${expected} samples).`);
  }
  return entry.pcm;
}

function copyPlanarRange(source, sourceSamples, startSample, sampleCount, channels) {
  const output = new Float32Array(sampleCount * channels);
  if (!source) return output;
  for (let channel = 0; channel < channels; channel += 1) {
    const sourceStart = channel * sourceSamples + startSample;
    const targetStart = channel * sampleCount;
    output.set(source.subarray(sourceStart, sourceStart + sampleCount), targetStart);
  }
  return output;
}

export function assembleAudioTimeline({clips, methods = [], videoSampleCounts, fps, sampleRate = AUDIO_SAMPLE_RATE, channels = AUDIO_CHANNELS}) {
  if (!Array.isArray(clips) || clips.length === 0) throw new RuntimeError('Audio assembly needs at least one clip.');
  if (!Array.isArray(videoSampleCounts) || videoSampleCounts.length !== clips.length) {
    throw new RuntimeError('Audio assembly needs one cumulative video sample count per clip.');
  }
  if (!Array.isArray(methods) || methods.length !== clips.length - 1) {
    throw new RuntimeError('Audio assembly needs one transition method per boundary.');
  }
  if (channels !== AUDIO_CHANNELS) throw new RuntimeError(`Merged audio currently requires exactly ${AUDIO_CHANNELS} channels.`);
  const frameSamples = samplesPerFrame(fps, sampleRate);
  const targetFrames = videoSampleCounts[videoSampleCounts.length - 1];
  if (!Number.isInteger(targetFrames) || targetFrames < 0) throw new RuntimeError('Merged video sample count must be a non-negative integer.');
  const totalAudioSamples = targetFrames * frameSamples;
  const output = new Float32Array(totalAudioSamples * channels);
  const segments = [];
  let writeSample = 0;

  const appendSegment = ({entry, target, dropFrames, method, boundaryIndex}) => {
    if (!Number.isInteger(target) || target < 0) throw new RuntimeError(`Boundary ${boundaryIndex} has an invalid video frame count.`);
    const sourcePcm = assertClipAudio(entry, frameSamples, channels);
    const availableFrames = entry.frames - dropFrames;
    if (availableFrames < 0) throw new RuntimeError(`Boundary ${boundaryIndex} cannot drop ${dropFrames} frames from a ${entry.frames}-frame audio clip.`);
    if (availableFrames > target) {
      throw new RuntimeError(`Boundary ${boundaryIndex} audio is ${availableFrames} frames but the merged video contributes ${target}; no audio is trimmed silently.`);
    }
    const sourceSamples = entry.frames * frameSamples;
    const targetSamples = target * frameSamples;
    const availableSamples = availableFrames * frameSamples;
    if (writeSample + targetSamples > totalAudioSamples) throw new RuntimeError('Audio segments exceed the merged video duration.');
    const fragment = copyPlanarRange(sourcePcm, sourceSamples, dropFrames * frameSamples, availableSamples, channels);
    for (let channel = 0; channel < channels; channel += 1) {
      output.set(fragment.subarray(channel * availableSamples, (channel + 1) * availableSamples), channel * totalAudioSamples + writeSample);
    }
    const paddedFrames = target - availableFrames;
    segments.push({
      clipIndex: boundaryIndex,
      method,
      sourceFrames: entry.frames,
      dropFrames,
      availableFrames,
      paddedFrames,
      videoFrames: target,
      source: entry.source ?? (sourcePcm ? 'pcm' : 'silence'),
    });
    writeSample += targetSamples;
  };

  appendSegment({entry: clips[0], target: videoSampleCounts[0], dropFrames: 0, method: 'base', boundaryIndex: 0});
  for (let index = 0; index < methods.length; index += 1) {
    const target = videoSampleCounts[index + 1] - videoSampleCounts[index];
    if (target < 0) throw new RuntimeError(`Boundary ${index + 1} reduced the cumulative video sample count.`);
    const method = methods[index];
    appendSegment({
      entry: clips[index + 1],
      target,
      dropFrames: method === 'classic-mosh' ? 1 : 0,
      method,
      boundaryIndex: index + 1,
    });
  }
  const expectedSamples = targetFrames * frameSamples;
  if (writeSample !== expectedSamples) throw new RuntimeError(`Audio timeline produced ${writeSample} samples; merged video declares ${expectedSamples}.`);
  if (output.length !== expectedSamples * channels) {
    throw new RuntimeError(`Audio sample count ${output.length} does not equal ${expectedSamples} samples × ${channels} channels.`);
  }
  return {
    pcm: output,
    frames: targetFrames,
    samplesPerFrame: frameSamples,
    sampleRate,
    channels,
    expectedSamples,
    segments,
  };
}

function boxChild(bytes, parent, type, required = true) {
  const found = childBoxes(bytes, parent).find(box => box.type === type);
  if (!found && required) throw new RuntimeError(`Muxed MP4 is missing ${type} inside ${parent.type}.`);
  return found;
}

function readEditList(bytes, track) {
  const edts = boxChild(bytes, track.trak, 'edts', false);
  if (!edts) throw new RuntimeError('Muxed audio has no edit list; exact audio/video duration cannot be established.');
  const elst = boxChild(bytes, edts, 'elst');
  if (elst.payloadEnd - elst.payloadStart < 8) throw new RuntimeError('Muxed audio edit list is truncated.');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const version = bytes[elst.payloadStart];
  const entryCount = view.getUint32(elst.payloadStart + 4);
  if (entryCount !== 1) throw new RuntimeError(`Muxed audio edit list has ${entryCount} entries; exactly one is supported.`);
  if (version === 1) {
    if (elst.payloadEnd - elst.payloadStart < 28) throw new RuntimeError('Muxed audio version 1 edit list is truncated.');
    return {
      elst,
      version,
      durationOffset: elst.payloadStart + 8,
      mediaTimeOffset: elst.payloadStart + 16,
      segmentDuration: Number(view.getBigUint64(elst.payloadStart + 8)),
      mediaTime: Number(view.getBigInt64(elst.payloadStart + 16)),
    };
  }
  if (version !== 0) throw new RuntimeError(`Unsupported audio edit-list version ${version}.`);
  if (elst.payloadEnd - elst.payloadStart < 20) throw new RuntimeError('Muxed audio edit list is truncated.');
  return {
    elst,
    version,
    durationOffset: elst.payloadStart + 8,
    mediaTimeOffset: elst.payloadStart + 12,
    segmentDuration: view.getUint32(elst.payloadStart + 8),
    mediaTime: view.getInt32(elst.payloadStart + 12),
  };
}

function writeTimeValue(view, offset, version, value) {
  if (!Number.isSafeInteger(value) || value < 0) throw new RuntimeError('Muxed audio time value is outside the safe integer range.');
  if (version === 1) view.setBigUint64(offset, BigInt(value));
  else {
    if (value > 0xffffffff) throw new RuntimeError('Muxed audio time value exceeds the 32-bit box field.');
    view.setUint32(offset, value);
  }
}

export function retimeMuxedAudio(inputBytes, expectedSamples, sampleRate = AUDIO_SAMPLE_RATE) {
  if (!(inputBytes instanceof Uint8Array)) throw new TypeError('retimeMuxedAudio expects a Uint8Array.');
  if (!Number.isInteger(expectedSamples) || expectedSamples <= 0) throw new RuntimeError('Muxed audio retiming requires a positive integer sample count.');
  const bytes = new Uint8Array(inputBytes.byteLength);
  bytes.set(inputBytes);
  const parsed = parseMp4(bytes);
  const audioTrack = parsed.tracks.find(track => track.handler === 'soun' && track.complete);
  if (!audioTrack?.mdhd || !audioTrack.stts || !audioTrack.tkhd) throw new RuntimeError('Muxed audio has no complete timed audio track.');
  if (!parsed.mvhd) throw new RuntimeError('Muxed audio MP4 has no movie header.');
  if (audioTrack.mdhd.timescale !== sampleRate) {
    throw new RuntimeError(`Muxed audio timescale ${audioTrack.mdhd.timescale} does not match ${sampleRate} Hz.`);
  }

  const edit = readEditList(bytes, audioTrack);
  if (edit.mediaTime < 0) throw new RuntimeError('Muxed audio edit list has a negative media time.');
  const encodedSamples = audioTrack.stts.durations.reduce((total, value) => total + value, 0);
  const expectedMediaEnd = edit.mediaTime + expectedSamples;
  if (encodedSamples < expectedMediaEnd) {
    throw new RuntimeError(`Muxed audio contains ${encodedSamples} encoded sample units but needs at least ${expectedMediaEnd} including ${edit.mediaTime} encoder-delay samples.`);
  }

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  // The audio media timescale carries the exact sample count. At 30 fps a
  // millisecond movie timescale may only approximate a frame boundary.
  const movieUnits = Math.round(expectedSamples * parsed.mvhd.timescale / audioTrack.mdhd.timescale);

  writeTimeValue(view, audioTrack.mdhd.durationOffset, audioTrack.mdhd.version, expectedMediaEnd);
  writeTimeValue(view, audioTrack.tkhd.durationOffset, audioTrack.tkhd.version, movieUnits);
  writeTimeValue(view, edit.durationOffset, edit.version, movieUnits);

  let movieDuration = movieUnits;
  for (const track of parsed.tracks) {
    if (track === audioTrack || !track.tkhd) continue;
    movieDuration = Math.max(movieDuration, track.tkhd.duration);
  }
  writeTimeValue(view, parsed.mvhd.durationOffset, parsed.mvhd.version, movieDuration);

  const checked = parseMp4(bytes);
  const checkedAudio = checked.tracks.find(track => track.handler === 'soun' && track.complete);
  if (!checkedAudio?.mdhd || !checkedAudio.stts) throw new RuntimeError('Retimed audio track could not be parsed back.');
  if (checkedAudio.mdhd.duration !== expectedMediaEnd) {
    throw new RuntimeError(`Retimed audio media duration ${checkedAudio.mdhd.duration} does not match ${expectedMediaEnd}.`);
  }
  return {
    bytes,
    presentationSamples: expectedSamples,
    encodedSamples,
    encoderDelaySamples: edit.mediaTime,
    mediaEndSamples: expectedMediaEnd,
    movieDurationUnits: movieDuration,
    movieTimescale: parsed.mvhd.timescale,
    presentationDurationSeconds: movieUnits / parsed.mvhd.timescale,
  };
}

export function wavBytes(pcm, sampleFrames, sampleRate = AUDIO_SAMPLE_RATE, channels = AUDIO_CHANNELS) {
  if (!(pcm instanceof Float32Array) || pcm.length !== sampleFrames * channels) throw new RuntimeError('WAV muxing received malformed planar PCM.');
  const dataBytes = sampleFrames * channels * 2;
  const output = new Uint8Array(44 + dataBytes);
  const view = new DataView(output.buffer);
  const ascii = (offset, value) => {
    for (let index = 0; index < value.length; index += 1) output[offset + index] = value.charCodeAt(index);
  };
  ascii(0, 'RIFF');
  view.setUint32(4, 36 + dataBytes, true);
  ascii(8, 'WAVE');
  ascii(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, channels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * channels * 2, true);
  view.setUint16(32, channels * 2, true);
  view.setUint16(34, 16, true);
  ascii(36, 'data');
  view.setUint32(40, dataBytes, true);
  let offset = 44;
  for (let frame = 0; frame < sampleFrames; frame += 1) {
    for (let channel = 0; channel < channels; channel += 1) {
      const sample = Math.max(-1, Math.min(1, pcm[channel * sampleFrames + frame]));
      view.setInt16(offset, sample < 0 ? Math.round(sample * 0x8000) : Math.round(sample * 0x7fff), true);
      offset += 2;
    }
  }
  return output;
}

export function isAudioEncoderAvailable() {
  return typeof globalThis.AudioEncoder === 'function' && typeof globalThis.AudioData === 'function';
}

export async function encodeAacWithWebCodecs(pcm, frames, options = {}) {
  if (!isAudioEncoderAvailable()) throw new RuntimeError('WebCodecs AudioEncoder is unavailable.');
  const sampleRate = options.sampleRate ?? AUDIO_SAMPLE_RATE;
  const channels = options.channels ?? AUDIO_CHANNELS;
  const bitrate = options.bitrate ?? DEFAULT_AUDIO_BITRATE;
  if (channels !== 2) throw new RuntimeError('WebCodecs AAC encoding requires stereo PCM.');
  if (!(pcm instanceof Float32Array) || pcm.length !== frames * channels) throw new RuntimeError('WebCodecs AAC encoding received malformed PCM.');
  const config = {codec: 'mp4a.40.2', sampleRate, numberOfChannels: channels, bitrate};
  const support = await AudioEncoder.isConfigSupported(config);
  if (!support.supported) throw new RuntimeError('This browser cannot encode AAC-LC audio with WebCodecs.');
  const chunks = [];
  let description = null;
  let encoderError = null;
  const encoder = new AudioEncoder({
    output: (chunk, metadata) => {
      const data = new Uint8Array(chunk.byteLength);
      chunk.copyTo(data);
      chunks.push({data, duration: chunk.duration ?? null, timestamp: chunk.timestamp});
      if (!description && metadata?.decoderConfig?.description) {
        const raw = metadata.decoderConfig.description;
        description = raw instanceof Uint8Array ? new Uint8Array(raw) : new Uint8Array(raw);
      }
    },
    error: error => { encoderError = error; },
  });
  try {
    encoder.configure(config);
    for (let offset = 0; offset < frames; offset += AAC_FRAME_SAMPLES) {
      if (encoderError) throw encoderError;
      while (encoder.encodeQueueSize >= 8) await new Promise(resolve => setTimeout(resolve, 2));
      const count = Math.min(AAC_FRAME_SAMPLES, frames - offset);
      const data = new Float32Array(AAC_FRAME_SAMPLES * channels);
      for (let channel = 0; channel < channels; channel += 1) {
        data.set(pcm.subarray(channel * frames + offset, channel * frames + offset + count), channel * AAC_FRAME_SAMPLES);
      }
      const audioData = new AudioData({
        format: 'f32-planar',
        sampleRate,
        numberOfFrames: AAC_FRAME_SAMPLES,
        numberOfChannels: channels,
        timestamp: Math.round(offset * 1_000_000 / sampleRate),
        data,
      });
      encoder.encode(audioData);
      audioData.close();
    }
    await encoder.flush();
    if (encoderError) throw encoderError;
    if (chunks.length === 0) throw new RuntimeError('WebCodecs AAC encoding returned no packets.');
    return {chunks, description, sampleRate, channels, bitrate, frameSamples: AAC_FRAME_SAMPLES};
  } catch (error) {
    if (encoderError) throw new RuntimeError(`WebCodecs AAC encoding failed: ${encoderError.message ?? encoderError}`);
    throw error instanceof RuntimeError ? error : new RuntimeError(`WebCodecs AAC encoding failed: ${error.message ?? error}`);
  } finally {
    if (encoder.state !== 'closed') encoder.close();
  }
}

const AAC_SAMPLE_RATES = [96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000, 7350];

export function buildAdts(aac, expectedSamples) {
  if (!aac || !Array.isArray(aac.chunks) || aac.chunks.length === 0) throw new RuntimeError('ADTS muxing received no AAC packets.');
  let profile = 1;
  let frequencyIndex = AAC_SAMPLE_RATES.indexOf(aac.sampleRate);
  let channelConfig = aac.channels;
  if (aac.description && aac.description.byteLength >= 2) {
    const objectType = (aac.description[0] >> 3) & 0x1f;
    profile = Math.max(0, objectType - 1);
    frequencyIndex = ((aac.description[0] & 0x07) << 1) | ((aac.description[1] >> 7) & 1);
    channelConfig = (aac.description[1] >> 3) & 0x0f;
  }
  if (frequencyIndex < 0 || frequencyIndex >= AAC_SAMPLE_RATES.length) throw new RuntimeError('AAC description has an invalid sampling frequency index.');
  if (channelConfig < 1 || channelConfig > 7) throw new RuntimeError('AAC description has an invalid channel configuration.');
  let total = 0;
  for (const chunk of aac.chunks) total += 7 + chunk.data.byteLength;
  const output = new Uint8Array(total);
  let offset = 0;
  for (const chunk of aac.chunks) {
    const length = 7 + chunk.data.byteLength;
    output[offset] = 0xff;
    output[offset + 1] = 0xf1;
    output[offset + 2] = ((profile & 0x03) << 6) | ((frequencyIndex & 0x0f) << 2) | ((channelConfig >> 2) & 0x01);
    output[offset + 3] = ((channelConfig & 0x03) << 6) | ((length >> 11) & 0x03);
    output[offset + 4] = (length >> 3) & 0xff;
    output[offset + 5] = ((length & 0x07) << 5) | 0x1f;
    output[offset + 6] = 0xfc;
    output.set(chunk.data, offset + 7);
    offset += length;
  }
  const encodedSamples = aac.chunks.length * (aac.frameSamples ?? AAC_FRAME_SAMPLES);
  return {bytes: output, encodedSamples, expectedSamples, packets: aac.chunks.length};
}

export {AAC_FRAME_SAMPLES, AUDIO_CHANNELS, AUDIO_SAMPLE_RATE, DEFAULT_AUDIO_BITRATE};
