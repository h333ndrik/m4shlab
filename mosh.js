import { parseMp4, rewriteMp4 } from './parser/mp4.js';
import { extractNals } from './parser/nal.js';
import { buildMergedTrack } from './merge.js';
import { countPictureSamples, resolveClassicMoshSettings, ValueError } from './classic-mosh.js';

const IDR_NAL_TYPE = 5;

function u32(value) {
  return value >>> 0;
}

function concatBytes(parts) {
  const length = parts.reduce((total, part) => total + part.byteLength, 0);
  const output = new Uint8Array(length);
  let offset = 0;
  for (const part of parts) {
    output.set(part, offset);
    offset += part.byteLength;
  }
  return output;
}

function sampleDataWithoutIdrs(inputBytes, nals, sampleIndex) {
  return concatBytes(nals
    .filter(nal => nal.sampleIndex === sampleIndex && nal.type !== IDR_NAL_TYPE)
    .map(nal => inputBytes.subarray(nal.start, nal.end)));
}

export function moshH264(inputBytes, parsedMp4 = parseMp4(inputBytes), options = {}) {
  if (!(inputBytes instanceof Uint8Array)) throw new TypeError('moshH264 expects a Uint8Array');
  const videoTrack = parsedMp4.videoTrack;
  const nals = extractNals(inputBytes, videoTrack);
  const idrNals = nals.filter((nal) => nal.type === IDR_NAL_TYPE);

  if (idrNals.length < 2) {
    const ending = options.ending ?? 'restore';
    if (ending !== 'restore' && ending !== 'continue') throw new ValueError('ending must be "restore" or "continue".');
    return {
      output: new Uint8Array(inputBytes),
      cut: new Uint8Array(inputBytes),
      removedRanges: [],
      moshable: false,
      report: {
        moshable: false,
        reason: 'At least two IDR units are required to establish a first GOP boundary.',
        ending,
        duration_frames: 0,
        re_inserted_idr_positions: [],
        sourceBytes: inputBytes.byteLength,
        outputBytes: inputBytes.byteLength,
        removedBytes: 0,
        removedIdrCount: 0,
        preservedIdrCount: idrNals.length,
        idrUnits: idrNals.map(summarizeNal),
        removedByteRanges: [],
        detail: 'Two IDR units are required: an initial anchor and one later boundary to remove.',
      },
    };
  }

  const boundaryNal = idrNals[1];
  const settings = resolveClassicMoshSettings(videoTrack, boundaryNal.sampleIndex, options);
  if (settings.maximumFrames < 1) {
    return {
      output: new Uint8Array(inputBytes),
      cut: new Uint8Array(inputBytes),
      removedRanges: [],
      moshable: false,
      report: {
        moshable: false,
        reason: 'No frames remain after the first GOP boundary for a Classic Mosh window.',
        ending: settings.ending,
        duration_frames: 0,
        re_inserted_idr_positions: [],
        sourceBytes: inputBytes.byteLength,
        outputBytes: inputBytes.byteLength,
        removedBytes: 0,
        removedIdrCount: 0,
        preservedIdrCount: idrNals.length,
        idrUnits: idrNals.map(summarizeNal),
        removedByteRanges: [],
      },
    };
  }

  const restoresWithinClip = settings.ending === 'restore'
    && settings.recoverySampleIndex < videoTrack.samples.length;
  const removalEndSample = restoresWithinClip ? settings.recoverySampleIndex : Number.POSITIVE_INFINITY;
  const removedNals = idrNals.filter(nal => nal.sampleIndex >= boundaryNal.sampleIndex && nal.sampleIndex < removalEndSample);
  const removedRanges = removedNals.map((nal) => ({
    start: nal.start,
    end: nal.end,
    length: nal.end - nal.start,
    sampleIndex: nal.sampleIndex,
    nalIndex: nal.nalIndex,
  }));
  const removedBytes = removedNals.reduce((total, nal) => total + nal.end - nal.start, 0);
  const reInsertedIdrPositions = restoresWithinClip ? [settings.recoverySampleIndex] : [];

  let output;
  let outputSampleCount;
  let reInsertedIdrOutputPositions = [];
  if (restoresWithinClip) {
    const boundarySample = videoTrack.samples[boundaryNal.sampleIndex];
    const boundarySampleBytes = inputBytes.subarray(boundarySample.offset, boundarySample.offset + boundarySample.size);
    const sampleParts = [];
    const durations = [];
    const compositionOffsets = [];
    for (const sample of videoTrack.samples) {
      if (sample.index === settings.recoverySampleIndex) {
        reInsertedIdrOutputPositions = [sampleParts.length];
        sampleParts.push(boundarySampleBytes);
        durations.push(videoTrack.stts.durations[boundaryNal.sampleIndex]);
        compositionOffsets.push(videoTrack.ctts?.offsets[boundaryNal.sampleIndex] ?? 0);
      }
      const removeIdr = sample.index >= boundaryNal.sampleIndex && sample.index < settings.recoverySampleIndex;
      if (sample.index === boundaryNal.sampleIndex) continue;
      const sampleData = removeIdr
        ? sampleDataWithoutIdrs(inputBytes, nals, sample.index)
        : inputBytes.subarray(sample.offset, sample.offset + sample.size);
      if (sampleData.byteLength === 0) continue;
      sampleParts.push(sampleData);
      durations.push(videoTrack.stts.durations[sample.index]);
      compositionOffsets.push(videoTrack.ctts?.offsets[sample.index] ?? 0);
    }
    const built = buildMergedTrack(inputBytes, parsedMp4, sampleParts, durations, compositionOffsets);
    output = built.output;
    outputSampleCount = built.outputMp4.videoTrack.samples.length;
  } else {
    const sampleSizeChanges = [];
    const removedBySample = new Map();
    for (const nal of removedNals) {
      const ranges = removedBySample.get(nal.sampleIndex) ?? [];
      ranges.push(nal);
      removedBySample.set(nal.sampleIndex, ranges);
    }
    for (const sample of videoTrack.samples) {
      const removed = removedBySample.get(sample.index);
      if (!removed) continue;
      const removedLength = removed.reduce((total, nal) => total + nal.end - nal.start, 0);
      sampleSizeChanges.push({ sampleIndex: sample.index, oldSize: sample.size, newSize: sample.size - removedLength });
    }
    output = rewriteMp4(parsedMp4, { removedRanges, sampleSizeChanges }).output;
    outputSampleCount = videoTrack.samples.length;
  }

  return {
    output,
    cut: new Uint8Array(inputBytes),
    removedRanges,
    moshable: true,
    report: {
      moshable: true,
      sourceBytes: inputBytes.byteLength,
      outputBytes: output.byteLength,
      outputSamples: outputSampleCount,
      expectedDecodedFrames: restoresWithinClip
        ? countPictureSamples(output, parseMp4(output).videoTrack)
        : countPictureSamples(inputBytes, videoTrack) - removedNals.length,
      removedBytes,
      removedIdrCount: removedNals.length,
      preservedIdrCount: idrNals.length - removedNals.length + reInsertedIdrPositions.length,
      boundary: {
        fileOffset: boundaryNal.start,
        sampleIndex: boundaryNal.sampleIndex,
        nalIndex: boundaryNal.nalIndex,
      },
      duration_seconds: settings.durationSeconds,
      duration_frames: settings.durationFrames,
      requested_duration_frames: settings.requestedFrames,
      maximum_duration_frames: settings.maximumFrames,
      fps: settings.fps,
      ending: settings.ending,
      clamped: settings.clamped,
      clamp_note: settings.clamped
        ? `Requested ${settings.requestedFrames} frames; clamped to ${settings.durationFrames} available frames.`
        : '',
      re_inserted_idr_positions: reInsertedIdrPositions,
      re_inserted_idr_output_positions: reInsertedIdrOutputPositions,
      idrUnits: [
        ...idrNals.map((nal) => ({
          ...summarizeNal(nal),
          action: nal.sampleIndex >= boundaryNal.sampleIndex && nal.sampleIndex < removalEndSample
            ? 'removed'
            : 'preserved',
        })),
        ...(restoresWithinClip ? [{
          ...summarizeNal(boundaryNal),
          sampleIndex: settings.recoverySampleIndex,
          outputSampleIndex: reInsertedIdrOutputPositions[0],
          action: 'reinserted',
        }] : []),
      ],
      removedByteRanges: removedRanges,
    },
  };
}

function summarizeNal(nal) {
  return {
    sampleIndex: u32(nal.sampleIndex),
    nalIndex: u32(nal.nalIndex),
    type: nal.type,
    typeName: nal.typeName,
    start: nal.start,
    end: nal.end,
    length: nal.end - nal.start,
  };
}

export { ValueError };
