import { parseMp4, rewriteMp4 } from './parser/mp4.js';
import { extractNals } from './parser/nal.js';

const IDR_NAL_TYPE = 5;

function u32(value) {
  return value >>> 0;
}

export function moshH264(inputBytes, parsedMp4 = parseMp4(inputBytes)) {
  if (!(inputBytes instanceof Uint8Array)) throw new TypeError('moshH264 expects a Uint8Array');
  const videoTrack = parsedMp4.videoTrack;
  const nals = extractNals(inputBytes, videoTrack);
  const idrNals = nals.filter((nal) => nal.type === IDR_NAL_TYPE);

  if (idrNals.length < 2) {
    return {
      output: new Uint8Array(inputBytes),
      cut: new Uint8Array(inputBytes),
      removedRanges: [],
      moshable: false,
      report: {
        moshable: false,
        reason: 'At least two IDR units are required to establish a first GOP boundary.',
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

  const boundaryNal = idrNals[1];
  const removedNals = idrNals.filter((nal) => nal.start >= boundaryNal.start);
  const removedBySample = new Map();
  for (const nal of removedNals) {
    const ranges = removedBySample.get(nal.sampleIndex) ?? [];
    ranges.push(nal);
    removedBySample.set(nal.sampleIndex, ranges);
  }

  const sampleSizeChanges = [];
  for (const sample of videoTrack.samples) {
    const removed = removedBySample.get(sample.index);
    if (!removed) continue;
    const removedLength = removed.reduce((total, nal) => total + nal.end - nal.start, 0);
    sampleSizeChanges.push({ sampleIndex: sample.index, oldSize: sample.size, newSize: sample.size - removedLength });
  }

  const removedRanges = removedNals.map((nal) => ({
    start: nal.start,
    end: nal.end,
    length: nal.end - nal.start,
    sampleIndex: nal.sampleIndex,
    nalIndex: nal.nalIndex,
  }));

  const { output } = rewriteMp4(parsedMp4, { removedRanges, sampleSizeChanges });
  const removedBytes = removedNals.reduce((total, nal) => total + nal.end - nal.start, 0);

  return {
    output,
    cut: new Uint8Array(inputBytes),
    removedRanges,
    moshable: true,
    report: {
      moshable: true,
      sourceBytes: inputBytes.byteLength,
      outputBytes: output.byteLength,
      removedBytes,
      removedIdrCount: removedNals.length,
      preservedIdrCount: idrNals.length - removedNals.length,
      boundary: {
        fileOffset: boundaryNal.start,
        sampleIndex: boundaryNal.sampleIndex,
        nalIndex: boundaryNal.nalIndex,
      },
      idrUnits: idrNals.map((nal) => ({
        ...summarizeNal(nal),
        action: nal.start >= boundaryNal.start ? 'removed' : 'preserved',
      })),
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
