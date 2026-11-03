import { parseMp4, childBoxes, Mp4Error } from './parser/mp4.js';
import { extractNals } from './parser/nal.js';
import { parseSps } from './parser/sps.js';
import { countPictureSamples, resolveClassicMoshSettings } from './classic-mosh.js';

const IDR_NAL_TYPE = 5;
const SEI_NAL_TYPE = 6;
const SPS_NAL_TYPE = 7;
const PPS_NAL_TYPE = 8;
const REMOVED_B_NAL_TYPES = new Set([IDR_NAL_TYPE, SEI_NAL_TYPE, SPS_NAL_TYPE, PPS_NAL_TYPE]);
const TRANSITION_METHODS = new Set(['cut', 'classic-mosh', 'melt', 'loop', 'reset-pulse']);
const MELT_REPEAT_MIN = 2;
const MELT_REPEAT_MAX = 12;
const LOOP_FRAMES_MIN = 2;
const LOOP_FRAMES_MAX = 48;
const RESET_INTERVAL_MIN = 4;
const RESET_INTERVAL_MAX = 48;

export class CompatibilityError extends Error {
  constructor(report) {
    super(report.message);
    this.name = 'CompatibilityError';
    this.report = report;
  }
}

function concatBytes(parts) {
  const length = parts.reduce((total, part) => total + part.byteLength, 0);
  const result = new Uint8Array(length);
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.byteLength;
  }
  return result;
}

function bytesEqual(left, right) {
  if (left.byteLength !== right.byteLength) return false;
  for (let i = 0; i < left.byteLength; i += 1) {
    if (left[i] !== right[i]) return false;
  }
  return true;
}

function byteSetsEqual(left, right) {
  return left.length === right.length && left.every((value, index) => bytesEqual(value, right[index]));
}

async function hashBytes(parts) {
  const joined = concatBytes(parts);
  if (globalThis.crypto?.subtle) {
    const digest = await globalThis.crypto.subtle.digest('SHA-256', joined);
    return Array.from(new Uint8Array(digest), value => value.toString(16).padStart(2, '0')).join('');
  }
  let first = 0x811c9dc5;
  let second = 0x9e3779b9;
  for (const value of joined) {
    first = Math.imul(first ^ value, 0x01000193) >>> 0;
    second = Math.imul(second ^ value, 0x85ebca6b) >>> 0;
  }
  return `fnv-${first.toString(16).padStart(8, '0')}${second.toString(16).padStart(8, '0')}`;
}

export function parseAvcConfig(bytes, avcC) {
  const start = avcC.payloadStart;
  if (avcC.payloadEnd - start < 7) throw new Mp4Error('Truncated avcC box');
  let offset = start + 5;
  const spsCount = bytes[offset++] & 0x1f;
  const sps = [];
  for (let i = 0; i < spsCount; i += 1) {
    if (offset + 2 > avcC.payloadEnd) throw new Mp4Error('Truncated avcC SPS length');
    const length = (bytes[offset] << 8) | bytes[offset + 1];
    offset += 2;
    if (offset + length > avcC.payloadEnd) throw new Mp4Error('Truncated avcC SPS payload');
    sps.push(bytes.subarray(offset, offset + length));
    offset += length;
  }
  if (offset >= avcC.payloadEnd) throw new Mp4Error('Truncated avcC PPS count');
  const ppsCount = bytes[offset++];
  const pps = [];
  for (let i = 0; i < ppsCount; i += 1) {
    if (offset + 2 > avcC.payloadEnd) throw new Mp4Error('Truncated avcC PPS length');
    const length = (bytes[offset] << 8) | bytes[offset + 1];
    offset += 2;
    if (offset + length > avcC.payloadEnd) throw new Mp4Error('Truncated avcC PPS payload');
    pps.push(bytes.subarray(offset, offset + length));
    offset += length;
  }
  return {
    profileIdc: bytes[start + 1],
    profileCompatibility: bytes[start + 2],
    levelIdc: bytes[start + 3],
    lengthSize: (bytes[start + 4] & 0x03) + 1,
    sps,
    pps,
    raw: bytes.subarray(start, avcC.payloadEnd),
  };
}

function profileName(profileIdc) {
  const names = new Map([
    [66, 'Baseline'],
    [77, 'Main'],
    [88, 'Extended'],
    [100, 'High'],
    [110, 'High 10'],
    [122, 'High 4:2:2'],
    [244, 'High 4:4:4'],
  ]);
  return names.get(profileIdc) ?? `profile ${profileIdc}`;
}

function chromaName(chromaFormatIdc) {
  const names = new Map([[0, 'monochrome'], [1, '4:2:0'], [2, '4:2:2'], [3, '4:4:4']]);
  return names.get(chromaFormatIdc) ?? `chroma ${chromaFormatIdc}`;
}

function inspectClip(bytes, parsed) {
  const track = parsed.videoTrack;
  const config = parseAvcConfig(bytes, track.avcC);
  const spsInfo = config.sps.length ? parseSps(config.sps[0]) : null;
  if (!spsInfo) throw new Mp4Error('No SPS found in the AVC configuration');
  if (config.pps.length === 0) throw new Mp4Error('No PPS found in the AVC configuration');
  if (!track.mdhd || !track.stts) throw new Mp4Error('Video track is missing mdhd or stts timing data');
  if (track.stts.sampleCount !== track.samples.length) throw new Mp4Error('stts sample count does not match the sample table');
  if (track.ctts && track.ctts.sampleCount !== track.samples.length) throw new Mp4Error('ctts sample count does not match the sample table');
  return { bytes, parsed, track, config, spsInfo };
}

function makeCheck(key, label, aValue, bValue, options = {}) {
  const match = options.predicate ? options.predicate() : aValue === bValue;
  return {
    key,
    label,
    a: aValue,
    b: bValue,
    match,
    required: options.required ?? true,
    note: options.note ?? '',
  };
}

export async function checkCompatibility(inputA, inputB, parsedA = parseMp4(inputA), parsedB = parseMp4(inputB)) {
  let a;
  let b;
  try {
    a = inspectClip(inputA, parsedA);
    b = inspectClip(inputB, parsedB);
  } catch (error) {
    return {
      compatible: false,
      message: `Compatibility check failed: ${error.message}`,
      checks: [],
      warnings: [],
      a: null,
      b: null,
    };
  }

  const [spsHashA, spsHashB, ppsHashA, ppsHashB] = await Promise.all([
    hashBytes(a.config.sps),
    hashBytes(b.config.sps),
    hashBytes(a.config.pps),
    hashBytes(b.config.pps),
  ]);
  const spsMatch = byteSetsEqual(a.config.sps, b.config.sps);
  const ppsMatch = byteSetsEqual(a.config.pps, b.config.pps);
  const aNals = extractNals(inputA, a.track);
  const bNals = extractNals(inputB, b.track);
  const aFirstSampleNals = aNals.filter(nal => nal.sampleIndex === a.track.samples[0]?.index);
  const aFirstIdrCount = aFirstSampleNals.filter(nal => nal.type === IDR_NAL_TYPE).length;
  const bIdrNals = bNals.filter(nal => nal.type === IDR_NAL_TYPE);
  const firstBIdrSample = bIdrNals.length ? bIdrNals[0].sampleIndex : null;
  const bHasSlicesAfterIdr = firstBIdrSample !== null && bNals.some(nal => nal.sampleIndex > firstBIdrSample && !REMOVED_B_NAL_TYPES.has(nal.type));

  const checks = [
    makeCheck('resolution', 'resolution',
      `${a.spsInfo.width}×${a.spsInfo.height}`,
      `${b.spsInfo.width}×${b.spsInfo.height}`,
      { predicate: () => a.spsInfo.width === b.spsInfo.width && a.spsInfo.height === b.spsInfo.height }),
    makeCheck('profile', 'profile_idc',
      `${a.spsInfo.profileIdc} ${profileName(a.spsInfo.profileIdc)}`,
      `${b.spsInfo.profileIdc} ${profileName(b.spsInfo.profileIdc)}`,
      { predicate: () => a.spsInfo.profileIdc === b.spsInfo.profileIdc }),
    makeCheck('constraints', 'profile constraints',
      `0x${a.spsInfo.constraintFlags.toString(16).padStart(2, '0')}`,
      `0x${b.spsInfo.constraintFlags.toString(16).padStart(2, '0')}`,
      { predicate: () => a.spsInfo.constraintFlags === b.spsInfo.constraintFlags }),
    makeCheck('level', 'level_idc',
      String(a.spsInfo.levelIdc),
      String(b.spsInfo.levelIdc),
      { predicate: () => a.spsInfo.levelIdc === b.spsInfo.levelIdc }),
    makeCheck('chroma', 'chroma format',
      chromaName(a.spsInfo.chromaFormatIdc),
      chromaName(b.spsInfo.chromaFormatIdc),
      { predicate: () => a.spsInfo.chromaFormatIdc === b.spsInfo.chromaFormatIdc }),
    makeCheck('bitDepth', 'bit depth',
      `${a.spsInfo.bitDepthLuma}/${a.spsInfo.bitDepthChroma}`,
      `${b.spsInfo.bitDepthLuma}/${b.spsInfo.bitDepthChroma}`,
      { predicate: () => a.spsInfo.bitDepthLuma === b.spsInfo.bitDepthLuma && a.spsInfo.bitDepthChroma === b.spsInfo.bitDepthChroma }),
    makeCheck('timescale', 'video timescale',
      String(a.track.mdhd.timescale),
      String(b.track.mdhd.timescale),
      { predicate: () => a.track.mdhd.timescale === b.track.mdhd.timescale }),
    makeCheck('lengthSize', 'NAL length size',
      String(a.track.lengthSize),
      String(b.track.lengthSize),
      { predicate: () => a.track.lengthSize === b.track.lengthSize }),
    makeCheck('spsPayload', 'SPS payload',
      `${spsHashA.slice(0, 12)}…`,
      `${spsHashB.slice(0, 12)}…`,
      { predicate: () => spsMatch, required: false, note: spsMatch ? 'identical' : 'differs · using A’s parameters' }),
    makeCheck('ppsPayload', 'PPS payload',
      `${ppsHashA.slice(0, 12)}…`,
      `${ppsHashB.slice(0, 12)}…`,
      { predicate: () => ppsMatch, note: ppsMatch ? 'identical' : 'must match for compatible H.264 slices' }),
    makeCheck('aIdrStart', 'A starts with an IDR',
      `${aFirstIdrCount} IDR NAL${aFirstIdrCount === 1 ? '' : 's'}`,
      '—',
      { predicate: () => aFirstIdrCount > 0 }),
    makeCheck('bIdrStart', 'B has an IDR to remove',
      '—',
      firstBIdrSample === null ? 'none' : `sample ${firstBIdrSample}`,
      { predicate: () => firstBIdrSample !== null }),
    makeCheck('bSlices', 'B has slices after its first IDR',
      '—',
      bHasSlicesAfterIdr ? 'yes' : 'no',
      { predicate: () => bHasSlicesAfterIdr }),
  ];

  const failures = checks.filter(check => check.required && !check.match);
  const warnings = checks.filter(check => !check.required && !check.match);
  const compatible = failures.length === 0;
  const clipSummary = {
    a: {
      width: a.spsInfo.width,
      height: a.spsInfo.height,
      profileIdc: a.spsInfo.profileIdc,
      profile: profileName(a.spsInfo.profileIdc),
      levelIdc: a.spsInfo.levelIdc,
      chroma: chromaName(a.spsInfo.chromaFormatIdc),
      timescale: a.track.mdhd.timescale,
      samples: a.track.samples.length,
      spsHash: spsHashA,
      ppsHash: ppsHashA,
    },
    b: {
      width: b.spsInfo.width,
      height: b.spsInfo.height,
      profileIdc: b.spsInfo.profileIdc,
      profile: profileName(b.spsInfo.profileIdc),
      levelIdc: b.spsInfo.levelIdc,
      chroma: chromaName(b.spsInfo.chromaFormatIdc),
      timescale: b.track.mdhd.timescale,
      samples: b.track.samples.length,
      spsHash: spsHashB,
      ppsHash: ppsHashB,
    },
  };

  let message = 'Compatible pair. The merge uses A’s SPS/PPS and sample description.';
  if (!compatible) {
    const detail = failures.map(check => `${check.label} ${check.a} ≠ ${check.b}`).join('; ');
    message = `Incompatible pair: ${detail}. Record both clips with the same device/settings, or convert them to H.264 with identical parameters.`;
  } else if (!spsMatch) {
    message = 'Compatible core parameters. SPS bytes differ, so the merge uses A’s SPS/PPS and sample description.';
  }

  return {
    compatible,
    message,
    checks,
    warnings,
    a: clipSummary.a,
    b: clipSummary.b,
    firstBIdrSample,
    spsMatch,
    ppsMatch,
  };
}

function makeBox(type, parts) {
  const payloadLength = parts.reduce((total, part) => total + part.byteLength, 0);
  const totalLength = payloadLength + 8;
  const extended = totalLength > 0xffffffff;
  const headerSize = extended ? 16 : 8;
  const output = new Uint8Array(payloadLength + headerSize);
  const view = new DataView(output.buffer);
  if (extended) {
    view.setUint32(0, 1);
    view.setBigUint64(8, BigInt(payloadLength + headerSize));
  } else {
    view.setUint32(0, totalLength);
  }
  for (let i = 0; i < 4; i += 1) output[4 + i] = type.charCodeAt(i);
  let offset = headerSize;
  for (const part of parts) {
    output.set(part, offset);
    offset += part.byteLength;
  }
  return output;
}

function fullBox(type, version, flags, parts = []) {
  const header = new Uint8Array(4);
  const view = new DataView(header.buffer);
  view.setUint8(0, version);
  view.setUint32(0, (version << 24) | flags);
  return makeBox(type, [header, ...parts]);
}

function u32(value) {
  const bytes = new Uint8Array(4);
  new DataView(bytes.buffer).setUint32(0, value);
  return bytes;
}

function makeStts(durations) {
  const entries = [];
  for (const delta of durations) {
    const previous = entries[entries.length - 1];
    if (previous && previous.delta === delta) previous.count += 1;
    else entries.push({ count: 1, delta });
  }
  const parts = [u32(entries.length)];
  for (const entry of entries) parts.push(u32(entry.count), u32(entry.delta));
  return fullBox('stts', 0, 0, parts);
}

function makeCtts(offsets) {
  if (offsets.every(offset => offset === 0)) return null;
  const version = offsets.some(offset => offset < 0) ? 1 : 0;
  const entries = [];
  for (const offset of offsets) {
    const previous = entries[entries.length - 1];
    if (previous && previous.offset === offset) previous.count += 1;
    else entries.push({ count: 1, offset });
  }
  const parts = [u32(entries.length)];
  for (const entry of entries) {
    const offset = new Uint8Array(4);
    const view = new DataView(offset.buffer);
    if (version === 1) view.setInt32(0, entry.offset);
    else view.setUint32(0, entry.offset);
    parts.push(u32(entry.count), offset);
  }
  return fullBox('ctts', version, 0, parts);
}

function makeStsc(sampleCount) {
  return fullBox('stsc', 0, 0, [u32(1), u32(1), u32(sampleCount), u32(1)]);
}

function makeStsz(sizes) {
  const parts = [u32(0), u32(sizes.length)];
  for (const size of sizes) parts.push(u32(size));
  return fullBox('stsz', 0, 0, parts);
}

function makeChunkOffset(offset, use64) {
  if (use64) {
    const bytes = new Uint8Array(8);
    new DataView(bytes.buffer).setBigUint64(0, BigInt(offset));
    return fullBox('co64', 0, 0, [u32(1), bytes]);
  }
  if (offset > 0xffffffff) throw new Mp4Error('Chunk offset exceeds 32-bit stco range');
  return fullBox('stco', 0, 0, [u32(1), u32(offset)]);
}

function makeStss(sampleNumbers = [1]) {
  const parts = [u32(sampleNumbers.length)];
  for (const sampleNumber of sampleNumbers) parts.push(u32(sampleNumber));
  return fullBox('stss', 0, 0, parts);
}

function copiedBox(bytes, box) {
  return bytes.subarray(box.start, box.end);
}

function patchedDurationBox(bytes, info, duration) {
  const output = new Uint8Array(info.box.size);
  output.set(bytes.subarray(info.box.start, info.box.end));
  const relative = info.durationOffset - info.box.start;
  const view = new DataView(output.buffer);
  if (info.version === 1) {
    view.setBigUint64(relative, BigInt(duration));
  } else {
    if (duration > 0xffffffff) throw new Mp4Error(`${info.box.type} duration exceeds version 0 range`);
    view.setUint32(relative, duration);
  }
  return output;
}

function rebuildMoov(inputA, parsedA, sizes, durations, compositionOffsets, chunkOffset, use64) {
  const bytes = inputA;
  const track = parsedA.videoTrack;
  const trakChildren = childBoxes(bytes, track.trak);
  const mdia = trakChildren.find(box => box.type === 'mdia');
  if (!mdia) throw new Mp4Error('A video track has no mdia box');
  const mdiaChildren = childBoxes(bytes, mdia);
  const minf = mdiaChildren.find(box => box.type === 'minf');
  if (!minf) throw new Mp4Error('A video track has no minf box');
  const minfChildren = childBoxes(bytes, minf);

  const ctts = makeCtts(compositionOffsets);
  const stbl = makeBox('stbl', [
    copiedBox(bytes, track.stsd.box),
    makeStts(durations),
    ...(ctts ? [ctts] : []),
    makeStss(),
    makeStsc(sizes.length),
    makeStsz(sizes),
    makeChunkOffset(chunkOffset, use64),
  ]);
  const newMinf = makeBox('minf', [
    ...minfChildren.filter(box => box.type !== 'stbl').map(box => copiedBox(bytes, box)),
    stbl,
  ]);
  const newMdhd = patchedDurationBox(bytes, track.mdhd, durations.reduce((total, value) => total + value, 0));
  const newMdia = makeBox('mdia', [
    newMdhd,
    ...mdiaChildren.filter(box => box.type !== 'mdhd' && box.type !== 'minf').map(box => copiedBox(bytes, box)),
    newMinf,
  ]);
  const newTkhd = patchedDurationBox(bytes, track.tkhd, Math.round(durations.reduce((total, value) => total + value, 0) * parsedA.mvhd.timescale / track.mdhd.timescale));
  const newTrak = makeBox('trak', [newTkhd, newMdia]);
  const moovChildren = childBoxes(bytes, parsedA.moov);
  const newMvhd = patchedDurationBox(bytes, parsedA.mvhd, Math.round(durations.reduce((total, value) => total + value, 0) * parsedA.mvhd.timescale / track.mdhd.timescale));
  return makeBox('moov', [
    newMvhd,
    newTrak,
    ...moovChildren.filter(box => box.type !== 'mvhd' && box.type !== 'trak').map(box => copiedBox(bytes, box)),
  ]);
}

function prepareB(inputB, parsedB, options = {}) {
  const track = parsedB.videoTrack;
  const nals = extractNals(inputB, track);
  const bySample = new Map();
  for (const nal of nals) {
    const items = bySample.get(nal.sampleIndex) ?? [];
    items.push(nal);
    bySample.set(nal.sampleIndex, items);
  }
  const firstIdr = nals.find(nal => nal.type === IDR_NAL_TYPE);
  if (!firstIdr) throw new Mp4Error('Clip B has no IDR NAL unit');
  if (parsedB.videoTrack.stts.durations.length !== track.samples.length) throw new Mp4Error('B stts sample count does not match its sample table');

  const settings = resolveClassicMoshSettings(track, firstIdr.sampleIndex, options);
  if (settings.maximumFrames < 1) throw new Mp4Error('Clip B has no frames after its first GOP boundary for Classic Mosh.');
  const restoreWithinClip = settings.ending === 'restore'
    && settings.recoverySampleIndex < track.samples.length;
  const boundarySample = track.samples[firstIdr.sampleIndex];
  const boundarySampleBytes = inputB.subarray(boundarySample.offset, boundarySample.offset + boundarySample.size);
  const boundaryNals = bySample.get(firstIdr.sampleIndex) ?? [];
  const samples = [];
  const removedCounts = { idr: 0, sei: 0, sps: 0, pps: 0 };
  const removedIdrSamples = new Set();
  let skippedPrefix = 0;
  let skippedEmpty = 0;
  let reInserted = false;

  for (const sample of track.samples) {
    if (restoreWithinClip && sample.index === settings.recoverySampleIndex) {
      samples.push({
        sourceSampleIndex: sample.index,
        data: boundarySampleBytes,
        duration: track.stts.durations[firstIdr.sampleIndex],
        compositionOffset: track.ctts?.offsets[firstIdr.sampleIndex] ?? 0,
        retainedNals: boundaryNals,
        reInsertedIdr: true,
      });
      reInserted = true;
    }

    const sampleNals = bySample.get(sample.index) ?? [];
    if (sample.index === firstIdr.sampleIndex) {
      skippedPrefix += 1;
      removedIdrSamples.add(sample.index);
      for (const nal of sampleNals) {
        if (nal.type === IDR_NAL_TYPE) removedCounts.idr += 1;
        if (nal.type === SEI_NAL_TYPE) removedCounts.sei += 1;
        if (nal.type === SPS_NAL_TYPE) removedCounts.sps += 1;
        if (nal.type === PPS_NAL_TYPE) removedCounts.pps += 1;
      }
      continue;
    }

    const retained = sampleNals.filter(nal => {
      if (nal.type === IDR_NAL_TYPE) {
        if (restoreWithinClip && sample.index < settings.recoverySampleIndex) {
          removedCounts.idr += 1;
          removedIdrSamples.add(sample.index);
          return false;
        }
        return true;
      }
      if (!REMOVED_B_NAL_TYPES.has(nal.type)) return true;
      if (nal.type === SEI_NAL_TYPE) removedCounts.sei += 1;
      if (nal.type === SPS_NAL_TYPE) removedCounts.sps += 1;
      if (nal.type === PPS_NAL_TYPE) removedCounts.pps += 1;
      return false;
    });
    if (retained.length === 0) {
      skippedEmpty += 1;
      continue;
    }
    samples.push({
      sourceSampleIndex: sample.index,
      data: concatBytes(retained.map(nal => inputB.subarray(nal.start, nal.end))),
      duration: track.stts.durations[sample.index],
      compositionOffset: track.ctts?.offsets[sample.index] ?? 0,
      retainedNals: retained,
      reInsertedIdr: false,
    });
  }

  const pictureSamples = samples.filter(sample => sample.retainedNals.some(nal => nal.type === 1 || nal.type === IDR_NAL_TYPE)).length;
  const laterIdrCount = samples.reduce((total, sample) => total
    + sample.retainedNals.filter(nal => !sample.reInsertedIdr && nal.type === IDR_NAL_TYPE).length, 0);
  return {
    firstIdrSample: firstIdr.sampleIndex,
    idrSamples: [...new Set(nals.filter(nal => nal.type === IDR_NAL_TYPE).map(nal => nal.sampleIndex))].sort((a, b) => a - b),
    skippedPrefix,
    skippedEmpty,
    removedCounts,
    removedIdrSamples: [...removedIdrSamples].sort((a, b) => a - b),
    laterIdrCount,
    pictureSamples,
    reInsertedIdrPositions: reInserted ? [settings.recoverySampleIndex] : [],
    settings,
    samples,
  };
}

function unescapeRbsp(bytes) {
  const output = new Uint8Array(bytes.byteLength);
  let length = 0;
  let zeros = 0;
  for (const value of bytes) {
    if (zeros >= 2 && value === 3) {
      zeros = 0;
      continue;
    }
    output[length++] = value;
    zeros = value === 0 ? zeros + 1 : 0;
  }
  return output.subarray(0, length);
}

function escapeRbsp(bytes) {
  const parts = [];
  let zeros = 0;
  for (const value of bytes) {
    if (zeros >= 2 && value <= 3) {
      parts.push(3);
      zeros = 0;
    }
    parts.push(value);
    zeros = value === 0 ? zeros + 1 : 0;
  }
  return Uint8Array.from(parts);
}

class SliceHeaderBits {
  constructor(bytes) {
    this.bytes = bytes;
    this.bit = 0;
  }

  readBit() {
    if (this.bit >= this.bytes.byteLength * 8) throw new Mp4Error('Truncated H.264 slice header');
    const value = (this.bytes[this.bit >> 3] >> (7 - (this.bit & 7))) & 1;
    this.bit += 1;
    return value;
  }

  readBits(count) {
    let value = 0;
    for (let i = 0; i < count; i += 1) value = (value * 2) + this.readBit();
    return value;
  }

  readUnsignedExpGolomb() {
    let zeros = 0;
    while (this.readBit() === 0) {
      zeros += 1;
      if (zeros > 31) throw new Mp4Error('Invalid Exp-Golomb value in H.264 slice header');
    }
    return (2 ** zeros) - 1 + (zeros === 0 ? 0 : this.readBits(zeros));
  }
}

function sliceHeaderState(nalData) {
  const rbsp = unescapeRbsp(nalData.subarray(1));
  const bits = new SliceHeaderBits(rbsp);
  bits.readUnsignedExpGolomb();
  const sliceType = bits.readUnsignedExpGolomb();
  bits.readUnsignedExpGolomb();
  return {rbsp, bits, sliceType: sliceType % 5, frameNumberBit: bits.bit};
}

function inspectPictureReordering(inputB, parsedB) {
  const offsets = parsedB.videoTrack.ctts?.offsets ?? [];
  const compositionReordered = offsets.some(offset => offset !== 0);
  const bSlices = extractNals(inputB, parsedB.videoTrack)
    .filter(nal => nal.type === 1 || nal.type === IDR_NAL_TYPE)
    .filter(nal => sliceHeaderState(nal.data).sliceType === 1);
  return {
    compositionReordered,
    bSliceCount: bSlices.length,
    noReordering: !compositionReordered && bSlices.length === 0,
  };
}

function integerOption(value, fallback, min, max, label) {
  const resolved = value === undefined || value === null ? fallback : Number(value);
  if (!Number.isInteger(resolved) || resolved < min || resolved > max) {
    throw new Mp4Error(`${label} must be an integer from ${min} to ${max}.`);
  }
  return resolved;
}

function loopReleaseSchedule(count, loopFrames) {
  if (!Number.isInteger(count) || count < 1) throw new Mp4Error('Loop Release needs at least one incoming sample.');
  const positions = [];
  const blocks = [];
  for (const repeats of [3, 2]) {
    const length = Math.min(loopFrames, Math.floor((Math.floor(count / 2) - positions.length) / repeats));
    if (length < 2) continue;
    const emittedStart = positions.length;
    const donorPositions = Array.from({length}, (_, index) => emittedStart + index);
    for (let copy = 0; copy < repeats; copy += 1) positions.push(...donorPositions);
    blocks.push({emittedStart, donorPositions, length, repeats});
  }
  if (blocks.length === 0) {
    throw new Mp4Error(`Loop Release does not have enough frames to repeat a group three times with a ${loopFrames}-frame maximum. Choose a shorter loop or normalize the clip.`);
  }
  const tailStart = positions.length;
  for (let position = tailStart; position < count; position += 1) positions.push(position);
  return {
    positions,
    blocks,
    tailStart,
  };
}

function hasExplicitDuration(options = {}) {
  return options.durationFrames !== undefined
    || options.durationSeconds !== undefined
    || options.duration !== undefined;
}

function resolveEffectSettings(track, firstIdrSample, method, options) {
  const resolvedOptions = {...options};
  if ((method === 'melt' || method === 'loop') && resolvedOptions.ending === undefined) {
    resolvedOptions.ending = 'continue';
  }
  return resolveClassicMoshSettings(track, firstIdrSample, resolvedOptions);
}

function softenDonorPositions(positions) {
  const count = positions.length;
  const releaseOutputIndex = count - Math.max(1, Math.floor(count / 4));
  const softened = [];
  let previous = 0;
  for (let index = 0; index < count; index += 1) {
    const desired = positions[index];
    const lower = Math.max(0, releaseOutputIndex - 2 * (releaseOutputIndex - index));
    const value = index >= releaseOutputIndex
      ? index
      : Math.min(previous + 2, Math.max(previous, desired, lower));
    softened.push(value);
    previous = value;
  }
  return {positions: softened, releaseOutputIndex};
}

function effectParameters(method, options = {}) {
  if (method === 'melt') {
    if (options.smooth !== undefined && typeof options.smooth !== 'boolean') {
      throw new Mp4Error('Melt smooth must be a boolean.');
    }
    return {
      method,
      repeat: integerOption(options.repeat, 4, MELT_REPEAT_MIN, MELT_REPEAT_MAX, 'Melt repeat'),
      smooth: options.smooth === true,
      loopFrames: null,
    };
  }
  if (options.smooth === true) throw new Mp4Error('Gentler cadence is only available for Melt.');
  if (method === 'loop') {
    return {
      method,
      repeat: null,
      smooth: false,
      loopFrames: integerOption(options.loopFrames ?? options.loop_frames, 4, LOOP_FRAMES_MIN, LOOP_FRAMES_MAX, 'Loop frames'),
    };
  }
  if (method === 'reset-pulse') {
    return {
      method,
      repeat: integerOption(options.repeat, 4, MELT_REPEAT_MIN, MELT_REPEAT_MAX, 'Reset Pulse repeat'),
      resetInterval: integerOption(options.resetInterval ?? options.reset_interval, 12, RESET_INTERVAL_MIN, RESET_INTERVAL_MAX, 'Reset interval'),
      smooth: false,
      loopFrames: null,
    };
  }
  throw new Mp4Error(`Effect requires method "melt", "loop", or "reset-pulse", received "${method}".`);
}

export function inspectEffectEligibility(input, parsed = parseMp4(input)) {
  try {
    const track = parsed.videoTrack;
    const config = parseAvcConfig(input, track.avcC);
    const sps = config.sps.length ? parseSps(config.sps[0]) : null;
    if (!sps) throw new Mp4Error('No SPS found in the AVC configuration');
    const reordering = inspectPictureReordering(input, parsed);
    return {
      eligible: reordering.noReordering && (sps.picOrderCntType === 0 || sps.picOrderCntType === 2),
      picOrderCntType: sps.picOrderCntType,
      bSliceCount: reordering.bSliceCount,
      compositionReordered: reordering.compositionReordered,
      log2MaxFrameNum: sps.log2MaxFrameNum,
      log2MaxPicOrderCntLsb: sps.log2MaxPicOrderCntLsb,
    };
  } catch (error) {
    return {
      eligible: false,
      error: error instanceof Error ? error.message : String(error),
      picOrderCntType: null,
      bSliceCount: null,
      compositionReordered: null,
      log2MaxFrameNum: null,
      log2MaxPicOrderCntLsb: null,
    };
  }
}

function effectDisplayName(method) {
  if (method === 'melt') return 'Melt';
  if (method === 'loop') return 'Loop Release';
  return 'Reset Pulse';
}

function effectEligibilityError(method, label, eligibility) {
  const effects = effectDisplayName(method);
  if (eligibility.error) return `${effects} could not inspect clip ${label}: ${eligibility.error}`;
  if (eligibility.bSliceCount || eligibility.compositionReordered) {
    const evidence = [
      eligibility.bSliceCount ? `${eligibility.bSliceCount} B-slice NAL${eligibility.bSliceCount === 1 ? '' : 's'}` : null,
      eligibility.compositionReordered ? 'non-zero composition offsets' : null,
    ].filter(Boolean).join(' and ');
    throw new Mp4Error(`${effects} requires clips without B-frames; clip ${label} contains ${evidence}. Normalize the sequence first, or choose Cut/Classic Mosh.`);
  }
  if (eligibility.picOrderCntType === 1) {
    throw new Mp4Error(`${effects} does not support clip ${label} with pic_order_cnt_type 1. Normalize the sequence first, or choose Cut/Classic Mosh.`);
  }
  throw new Mp4Error(`${effects} requires a non-reordered H.264 clip ${label}. Normalize the sequence first, or choose Cut/Classic Mosh.`);
}

function assertEffectEligible(inputA, parsedA, inputB, parsedB, method) {
  const a = inspectEffectEligibility(inputA, parsedA);
  const b = inspectEffectEligibility(inputB, parsedB);
  if (!a.eligible) effectEligibilityError(method, 'A', a);
  if (!b.eligible) effectEligibilityError(method, 'B', b);
  return {a, b};
}

function prepareEffectB(inputB, parsedB, method, options = {}) {
  const effect = effectParameters(method, options);
  const track = parsedB.videoTrack;
  const explicitDuration = hasExplicitDuration(options);
  const nals = extractNals(inputB, track);
  const bySample = new Map();
  for (const nal of nals) {
    const items = bySample.get(nal.sampleIndex) ?? [];
    items.push(nal);
    bySample.set(nal.sampleIndex, items);
  }
  const firstIdr = nals.find(nal => nal.type === IDR_NAL_TYPE);
  if (!firstIdr) throw new Mp4Error('Clip B has no IDR NAL unit');
  const settings = resolveEffectSettings(track, firstIdr.sampleIndex, method, options);
  if (effect.smooth && !explicitDuration) throw new Mp4Error('Gentler Melt cadence requires an explicit duration window.');
  const sourceSamples = track.samples.map(sample => {
    const sampleNals = bySample.get(sample.index) ?? [];
    const retainedNals = sampleNals.filter(nal => {
      if (nal.type === IDR_NAL_TYPE) return true;
      return !REMOVED_B_NAL_TYPES.has(nal.type);
    });
    const idr = retainedNals.some(nal => nal.type === IDR_NAL_TYPE);
    const picture = idr || retainedNals.some(nal => nal.type === 1);
    return {
      sample,
      retainedNals,
      idr,
      picture,
      data: retainedNals.length ? concatBytes(retainedNals.map(nal => inputB.subarray(nal.start, nal.end))) : null,
      duration: track.stts.durations[sample.index],
      compositionOffset: track.ctts?.offsets[sample.index] ?? 0,
    };
  });
  const sourceByIndex = new Map(sourceSamples.map(source => [source.sample.index, source]));
  const removedCounts = {idr: 0, sei: 0, sps: 0, pps: 0};
  for (const nal of bySample.get(firstIdr.sampleIndex) ?? []) {
    if (nal.type === IDR_NAL_TYPE) removedCounts.idr += 1;
    if (nal.type === SEI_NAL_TYPE) removedCounts.sei += 1;
    if (nal.type === SPS_NAL_TYPE) removedCounts.sps += 1;
    if (nal.type === PPS_NAL_TYPE) removedCounts.pps += 1;
  }

  const availableAfterBoundary = sourceSamples.filter(source => source.sample.index > firstIdr.sampleIndex && source.data);
  const boundarySample = track.samples[firstIdr.sampleIndex];
  const boundarySource = {
    ...sourceByIndex.get(firstIdr.sampleIndex),
    data: inputB.subarray(boundarySample.offset, boundarySample.offset + boundarySample.size),
    retainedNals: bySample.get(firstIdr.sampleIndex) ?? [],
    idr: true,
  };
  const nonIdrDonors = availableAfterBoundary.filter(source => source.picture && !source.idr);
  let loopWindow = [];
  let loopSecondWindow = [];
  let loopSchedule = null;
  let loopPlan = null;
  let meltReleaseOutputIndex = null;
  if (effect.method === 'loop') {
    const windowFrames = explicitDuration ? settings.durationFrames : availableAfterBoundary.length;
    loopPlan = loopReleaseSchedule(windowFrames, effect.loopFrames);
    const describeBlock = block => ({
      emittedStart: block.emittedStart,
      donorStart: availableAfterBoundary[block.donorPositions[0]].sample.index,
      length: block.length,
      repeats: block.repeats,
      donorSamples: block.donorPositions.map(position => availableAfterBoundary[position].sample.index),
    });
    loopWindow = loopPlan.blocks[0].donorPositions
      .map(position => availableAfterBoundary[position].sample.index);
    loopSecondWindow = loopPlan.blocks[1]?.donorPositions
      .map(position => availableAfterBoundary[position].sample.index) ?? [];
    loopSchedule = {
      emittedSamples: loopPlan.positions.length,
      windowFrames,
      positions: loopPlan.positions,
      blocks: loopPlan.blocks.map(describeBlock),
      tailStart: loopPlan.tailStart,
      tailDonorStart: availableAfterBoundary[loopPlan.tailStart]?.sample.index ?? null,
    };
  }
  let meltPlan = null;
  if (effect.method === 'melt' && explicitDuration) {
    if (settings.durationFrames < 1) throw new Mp4Error('Melt needs a non-empty duration window.');
    if (nonIdrDonors.length === 0) throw new Mp4Error('Melt needs at least one non-IDR donor sample in clip B.');
    const baseDonorPositions = Array.from({length: settings.durationFrames}, (_, index) => Math.floor(index / effect.repeat));
    const softened = effect.smooth ? softenDonorPositions(baseDonorPositions) : null;
    const donorPositions = softened?.positions ?? baseDonorPositions;
    meltReleaseOutputIndex = softened?.releaseOutputIndex ?? null;
    const donorSources = donorPositions.map(position => nonIdrDonors[position]);
    const missing = donorSources.findIndex(source => !source);
    if (missing >= 0) {
      throw new Mp4Error(`Melt duration ${settings.durationFrames} needs donor sample ${firstIdr.sampleIndex + 1 + donorPositions[missing]}, but clip B has only ${nonIdrDonors.length} non-IDR donors.`);
    }
    const tailStartSample = donorSources[donorSources.length - 1].sample.index + 1;
    const tailSources = sourceSamples.filter(source => source.sample.index >= tailStartSample && source.data);
    meltPlan = {baseDonorPositions, donorPositions, donorSources, tailStartSample, tailSources};
  }
  const scheduled = [];
  const repeatedSourceSamples = new Set();
  let skippedPrefix = 0;
  let skippedEmpty = 0;
  let resetPulse = null;

  if (effect.method === 'reset-pulse') {
    if (settings.durationFrames < 1) throw new Mp4Error('Reset Pulse needs a non-empty Classic Mosh duration window.');
    if (effect.resetInterval >= settings.durationFrames) {
      throw new Mp4Error(`Reset interval ${effect.resetInterval} must be smaller than the ${settings.durationFrames}-frame Reset Pulse duration.`);
    }
    const intervals = [];
    for (let outputStart = 0; outputStart < settings.durationFrames; outputStart += effect.resetInterval) {
      const outputEnd = Math.min(settings.durationFrames, outputStart + effect.resetInterval);
      const donorSources = [];
      for (let position = outputStart + 1; position < outputEnd; position += 1) {
        const k = position - outputStart;
        const donorOrdinal = Math.floor((k - 1) / effect.repeat);
        const donor = nonIdrDonors[donorOrdinal];
        if (!donor) {
          throw new Mp4Error(`Reset Pulse interval ${intervals.length + 1} needs donor sample ${firstIdr.sampleIndex + 1 + donorOrdinal}, but clip B has only ${nonIdrDonors.length} non-IDR donors.`);
        }
        donorSources.push(donor);
      }
      intervals.push({intervalIndex: intervals.length, outputStart, outputEnd, donorSources});
    }
    const tailStartSample = firstIdr.sampleIndex + settings.durationFrames + 1;
    const tailSources = sourceSamples.filter(source => source.sample.index >= tailStartSample && source.data);
    resetPulse = {
      settings,
      boundarySource,
      donorPool: nonIdrDonors,
      intervals,
      tailStartSample,
      tailSources,
      restoreAtTail: settings.ending === 'restore' && tailStartSample < track.samples.length,
      resetPositions: [],
      intervalReports: [],
      tailResetPosition: null,
    };
  }

  const schedule = (source, copyIndex, extra = {}) => {
    if (!source.data) return false;
    scheduled.push({
      sourceSampleIndex: source.sample.index,
      copyIndex,
      data: source.data,
      duration: source.duration,
      compositionOffset: source.compositionOffset,
      retainedNals: source.retainedNals,
      isIdr: source.idr,
      ...extra,
    });
    return true;
  };

  let windowOutputSamples = null;
  let tailOutputStart = null;
  let tailDonorStartSample = null;
  let restoreResetPosition = null;

  if (effect.method === 'loop') {
    const occurrences = new Map();
    for (const position of loopSchedule.positions) {
      const source = availableAfterBoundary[position];
      if (!source) throw new Mp4Error(`Loop Release donor ${position} is outside clip B.`);
      const occurrence = occurrences.get(source.sample.index) ?? 0;
      schedule(source, occurrence);
      occurrences.set(source.sample.index, occurrence + 1);
      if (occurrence > 0) repeatedSourceSamples.add(source.sample.index);
    }
    windowOutputSamples = loopPlan.positions.length;
    if (explicitDuration) {
      const nextDonorPosition = loopPlan.positions[loopPlan.positions.length - 1] + 1;
      tailOutputStart = scheduled.length;
      tailDonorStartSample = availableAfterBoundary[nextDonorPosition]?.sample.index ?? null;
      if (settings.ending === 'restore' && tailDonorStartSample !== null) {
        restoreResetPosition = scheduled.length;
        schedule(boundarySource, -1, {reInsertedIdr: true, tailReset: true});
      }
      for (let position = nextDonorPosition; position < availableAfterBoundary.length; position += 1) {
        schedule(availableAfterBoundary[position], 0);
      }
    }
    skippedPrefix = 1;
    skippedEmpty = sourceSamples.filter(source => source.sample.index > firstIdr.sampleIndex && !source.data).length;
  } else if (effect.method === 'reset-pulse') {
    for (const interval of resetPulse.intervals) {
      const resetPosition = scheduled.length;
      resetPulse.resetPositions.push(resetPosition);
      schedule(resetPulse.boundarySource, interval.intervalIndex, {reInsertedIdr: true});
      const occurrences = new Map();
      const donorSamples = [];
      for (const donor of interval.donorSources) {
        const occurrence = occurrences.get(donor.sample.index) ?? 0;
        schedule(donor, occurrence);
        occurrences.set(donor.sample.index, occurrence + 1);
        donorSamples.push(donor.sample.index);
        if (occurrence > 0) repeatedSourceSamples.add(donor.sample.index);
      }
      resetPulse.intervalReports.push({
        intervalIndex: interval.intervalIndex,
        outputStart: interval.outputStart,
        outputEnd: interval.outputEnd,
        resetPosition,
        donorSamples,
        patchedSamples: donorSamples.length,
      });
    }
    windowOutputSamples = settings.durationFrames;
    tailOutputStart = scheduled.length;
    tailDonorStartSample = resetPulse.tailSources[0]?.sample.index ?? null;
    if (resetPulse.restoreAtTail) {
      resetPulse.tailResetPosition = scheduled.length;
      restoreResetPosition = scheduled.length;
      schedule(resetPulse.boundarySource, -1, {reInsertedIdr: true, tailReset: true});
    }
    for (const source of resetPulse.tailSources) schedule(source, 0);
    skippedPrefix = 1;
    skippedEmpty = sourceSamples.filter(source => source.sample.index > firstIdr.sampleIndex && !source.data).length;
  } else if (effect.method === 'melt' && meltPlan) {
    const occurrences = new Map();
    for (const donor of meltPlan.donorSources) {
      const occurrence = occurrences.get(donor.sample.index) ?? 0;
      schedule(donor, occurrence);
      occurrences.set(donor.sample.index, occurrence + 1);
      if (occurrence > 0) repeatedSourceSamples.add(donor.sample.index);
    }
    windowOutputSamples = meltPlan.donorSources.length;
    tailOutputStart = scheduled.length;
    tailDonorStartSample = meltPlan.tailSources[0]?.sample.index ?? null;
    if (settings.ending === 'restore' && meltPlan.tailSources.length > 0) {
      restoreResetPosition = scheduled.length;
      schedule(boundarySource, -1, {reInsertedIdr: true, tailReset: true});
    }
    for (const source of meltPlan.tailSources) schedule(source, 0);
    skippedPrefix = 1;
    skippedEmpty = sourceSamples.filter(source => source.sample.index > firstIdr.sampleIndex && !source.data).length;
  } else {
    for (const source of sourceSamples) {
      if (source.sample.index === firstIdr.sampleIndex) {
        skippedPrefix += 1;
        continue;
      }
      if (!source.data) {
        skippedEmpty += 1;
        continue;
      }
      if (source.idr) {
        schedule(source, 0);
        continue;
      }
      if (source.picture) {
        for (let copy = 0; copy < effect.repeat; copy += 1) {
          schedule(source, copy);
          if (copy > 0) repeatedSourceSamples.add(source.sample.index);
        }
        continue;
      }
      schedule(source, 0);
    }
  }

  const pictureSamples = scheduled.filter(sample => sample.retainedNals.some(nal => nal.type === 1 || nal.type === IDR_NAL_TYPE)).length;
  const idrSamples = [...new Set(nals.filter(nal => nal.type === IDR_NAL_TYPE).map(nal => nal.sampleIndex))].sort((a, b) => a - b);
  const originalScheduled = new Set(scheduled.filter(sample => !sample.reInsertedIdr).map(sample => sample.sourceSampleIndex));
  const reInsertedIdrPositions = scheduled.flatMap((sample, index) => sample.reInsertedIdr ? [index] : []);
  const effectWindow = {
    explicitDuration,
    durationFrames: settings.durationFrames,
    requestedDurationFrames: settings.requestedFrames,
    maximumDurationFrames: settings.maximumFrames,
    durationSeconds: settings.durationSeconds,
    fps: settings.fps,
    ending: settings.ending,
    clamped: settings.clamped,
    windowOutputSamples,
    smooth: effect.smooth === true,
    releaseOutputIndex: meltReleaseOutputIndex,
    baseDonorPositions: meltPlan?.baseDonorPositions ?? null,
    scheduledSourceSamples: windowOutputSamples === null
      ? []
      : scheduled.slice(0, windowOutputSamples).map(sample => sample.sourceSampleIndex),
    tail: tailOutputStart === null ? null : {
      outputStart: tailOutputStart,
      donorStartSample: tailDonorStartSample,
      restoreResetPosition,
    },
  };
  return {
    method: effect.method,
    effect,
    settings,
    effectWindow,
    firstIdrSample: firstIdr.sampleIndex,
    idrSamples,
    skippedPrefix,
    skippedEmpty,
    removedCounts,
    removedIdrSamples: idrSamples.filter(sampleIndex => !originalScheduled.has(sampleIndex)),
    reInsertedIdrPositions,
    laterIdrCount: scheduled.reduce((total, sample) => total
      + (sample.reInsertedIdr ? 0 : sample.retainedNals.filter(nal => nal.type === IDR_NAL_TYPE).length), 0),
    pictureSamples,
    loopWindow,
    loopSecondWindow,
    loopSchedule,
    resetPulse: resetPulse ? {
      resetInterval: effect.resetInterval,
      repeat: effect.repeat,
      durationFrames: resetPulse.settings.durationFrames,
      requestedDurationFrames: resetPulse.settings.requestedFrames,
      maximumDurationFrames: resetPulse.settings.maximumFrames,
      ending: resetPulse.settings.ending,
      clamped: resetPulse.settings.clamped,
      resetOutputPositions: resetPulse.resetPositions,
      intervals: resetPulse.intervalReports,
      tail: {
        outputStart: resetPulse.settings.durationFrames,
        donorStartSample: resetPulse.tailSources[0]?.sample.index ?? null,
        restoreResetPosition: resetPulse.tailResetPosition,
      },
      donorPoolSize: resetPulse.donorPool.length,
      patchCounts: resetPulse.intervalReports.map(interval => interval.patchedSamples),
    } : null,
    repeatedSourceSamples: [...repeatedSourceSamples].sort((a, b) => a - b),
    samples: scheduled,
  };
}

function readLastPictureState(input, parsed, sps) {
  const slices = extractNals(input, parsed.videoTrack).filter(nal => nal.type === 1 || nal.type === IDR_NAL_TYPE);
  const last = slices[slices.length - 1];
  if (!last) throw new Mp4Error('Clip A has no slice for frame-number alignment');
  const {bits, frameNumberBit} = sliceHeaderState(last.data);
  if (frameNumberBit + sps.log2MaxFrameNum > bits.bytes.byteLength * 8) {
    throw new Mp4Error('Clip A slice is too short to read frame_num');
  }
  const frameNumber = bits.readBits(sps.log2MaxFrameNum);
  let picOrderCntLsb = null;
  if (sps.picOrderCntType === 0) {
    if ((last.data[0] & 0x1f) === IDR_NAL_TYPE) bits.readUnsignedExpGolomb();
    picOrderCntLsb = bits.readBits(sps.log2MaxPicOrderCntLsb);
  }
  return {frameNumber, picOrderCntLsb};
}

function renumberEffectSamples(inputA, parsedA, inputB, parsedB, preparedB) {
  const bConfig = parseAvcConfig(inputB, parsedB.videoTrack.avcC);
  const bSps = bConfig.sps.length ? parseSps(bConfig.sps[0]) : null;
  const aConfig = parseAvcConfig(inputA, parsedA.videoTrack.avcC);
  const aSps = aConfig.sps.length ? parseSps(aConfig.sps[0]) : null;
  if (!bSps || !aSps) throw new Mp4Error('Timeline effects require SPS data for both clips');
  if (aSps.log2MaxFrameNum !== bSps.log2MaxFrameNum) {
    throw new Mp4Error(`Timeline effects require matching log2_max_frame_num (${aSps.log2MaxFrameNum} ≠ ${bSps.log2MaxFrameNum}).`);
  }
  if (aSps.picOrderCntType !== bSps.picOrderCntType) {
    throw new Mp4Error(`Timeline effects cannot combine pic_order_cnt_type ${aSps.picOrderCntType} with ${bSps.picOrderCntType}.`);
  }
  if (bSps.picOrderCntType === 0 && aSps.log2MaxPicOrderCntLsb !== bSps.log2MaxPicOrderCntLsb) {
    throw new Mp4Error(`Timeline effects require matching log2_max_pic_order_cnt_lsb (${aSps.log2MaxPicOrderCntLsb} ≠ ${bSps.log2MaxPicOrderCntLsb}).`);
  }

  const lastA = readLastPictureState(inputA, parsedA, bSps);
  const frameModulo = 2 ** bSps.log2MaxFrameNum;
  const pocModulo = bSps.picOrderCntType === 0 ? 2 ** bSps.log2MaxPicOrderCntLsb : null;
  let frameNumber = (lastA.frameNumber + 1) % frameModulo;
  let picOrderCntLsb = bSps.picOrderCntType === 0 ? (lastA.picOrderCntLsb + 1) % pocModulo : null;
  const firstFrameNumber = frameNumber;
  const firstPicOrderCntLsb = picOrderCntLsb;
  let patchedSamples = 0;
  let patchedNals = 0;
  let gopResets = 0;
  let patchedIdrNals = 0;
  const resetPositions = [];
  const segments = [];
  let segment = null;

  for (let outputIndex = 0; outputIndex < preparedB.samples.length; outputIndex += 1) {
    const sample = preparedB.samples[outputIndex];
    if (sample.isIdr) {
      gopResets += 1;
      resetPositions.push(outputIndex);
      frameNumber = 1;
      if (bSps.picOrderCntType === 0) {
        const previousPicOrderCntLsb = (picOrderCntLsb + pocModulo - 1) % pocModulo;
        picOrderCntLsb = previousPicOrderCntLsb === 0 ? 2 : 1;
        if (preparedB.method === 'reset-pulse' && !sample.reInsertedIdr) {
          const patchedIdr = patchIdrPictureOrderCount(sample.data, parsedB.videoTrack.lengthSize, bSps.log2MaxFrameNum, bSps.log2MaxPicOrderCntLsb);
          sample.data = patchedIdr.data;
          patchedIdrNals += patchedIdr.patchedNals;
        }
      }
      segment = {
        outputStart: outputIndex,
        reInsertedIdr: sample.reInsertedIdr === true,
        firstFrameNumber: 1,
        firstPicOrderCntLsb: bSps.picOrderCntType === 0 ? picOrderCntLsb : null,
        lastFrameNumber: 1,
        lastPicOrderCntLsb: bSps.picOrderCntType === 0 ? picOrderCntLsb : null,
        patchedSamples: 0,
        patchedNals: 0,
      };
      segments.push(segment);
      continue;
    }
    if (!sample.retainedNals.some(nal => nal.type === 1)) continue;
    const patched = patchSampleFrameNumber(
      sample.data,
      parsedB.videoTrack.lengthSize,
      bSps.log2MaxFrameNum,
      frameNumber,
      bSps.picOrderCntType === 0 ? {
        value: picOrderCntLsb,
        log2MaxPicOrderCntLsb: bSps.log2MaxPicOrderCntLsb,
      } : null,
    );
    if (patched.patchedNals === 0) throw new Mp4Error('A timeline effect scheduled a sample without a patchable non-IDR slice');
    sample.data = patched.data;
    patchedSamples += 1;
    patchedNals += patched.patchedNals;
    if (segment) {
      segment.patchedSamples += 1;
      segment.patchedNals += patched.patchedNals;
      segment.lastFrameNumber = frameNumber;
      segment.lastPicOrderCntLsb = bSps.picOrderCntType === 0 ? picOrderCntLsb : null;
    }
    frameNumber = (frameNumber + 1) % frameModulo;
    if (bSps.picOrderCntType === 0) picOrderCntLsb = (picOrderCntLsb + 1) % pocModulo;
  }

  if (patchedSamples === 0) throw new Mp4Error('A timeline effect scheduled no non-IDR samples to renumber');
  return {
    applied: true,
    method: preparedB.method,
    aLastFrameNum: lastA.frameNumber,
    firstEmittedFrameNum: firstFrameNumber,
    firstEmittedPicOrderCntLsb: firstPicOrderCntLsb,
    patchedSamples,
    patchedNals,
    patchedIdrNals,
    gopResets,
    resetPositions,
    segments,
    log2MaxFrameNum: bSps.log2MaxFrameNum,
    picOrderCntType: bSps.picOrderCntType,
    pictureOrderCountPatch: bSps.picOrderCntType === 0 ? {
      aLastPicOrderCntLsb: lastA.picOrderCntLsb,
      log2MaxPicOrderCntLsb: bSps.log2MaxPicOrderCntLsb,
    } : null,
    emulationPrevention: 'RBSP bytes are unescaped, patched, then re-escaped with fresh emulation-prevention bytes',
  };
}

function readSliceFrameNumber(nalData, log2MaxFrameNum) {
  const {rbsp, bits, frameNumberBit} = sliceHeaderState(nalData);
  if (frameNumberBit + log2MaxFrameNum > rbsp.byteLength * 8) throw new Mp4Error('H.264 slice is too short to read frame_num');
  return bits.readBits(log2MaxFrameNum);
}

function writeFixedBits(rbsp, position, count, value) {
  const masked = value % (2 ** count);
  for (let i = 0; i < count; i += 1) {
    const bitPosition = position + i;
    if ((masked >> (count - 1 - i)) & 1) rbsp[bitPosition >> 3] |= 1 << (7 - (bitPosition & 7));
    else rbsp[bitPosition >> 3] &= ~(1 << (7 - (bitPosition & 7)));
  }
}

function patchSliceHeader(nalData, log2MaxFrameNum, frameNumber, pictureOrderCount = null) {
  const {rbsp, frameNumberBit} = sliceHeaderState(nalData);
  if (frameNumberBit + log2MaxFrameNum > rbsp.byteLength * 8) throw new Mp4Error('H.264 slice is too short to patch frame_num');
  writeFixedBits(rbsp, frameNumberBit, log2MaxFrameNum, frameNumber);
  if (pictureOrderCount) {
    const state = sliceHeaderState(nalData);
    state.bits.readBits(log2MaxFrameNum);
    if ((nalData[0] & 0x1f) === IDR_NAL_TYPE) state.bits.readUnsignedExpGolomb();
    const position = state.bits.bit;
    if (position + pictureOrderCount.log2MaxPicOrderCntLsb > rbsp.byteLength * 8) {
      throw new Mp4Error('H.264 slice is too short to patch pic_order_cnt_lsb');
    }
    writeFixedBits(rbsp, position, pictureOrderCount.log2MaxPicOrderCntLsb, pictureOrderCount.value);
  }
  const escaped = escapeRbsp(rbsp);
  const output = new Uint8Array(escaped.byteLength + 1);
  output[0] = nalData[0];
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

function patchIdrPictureOrderCount(sampleData, lengthSize, log2MaxFrameNum, log2MaxPicOrderCntLsb) {
  const view = new DataView(sampleData.buffer, sampleData.byteOffset, sampleData.byteLength);
  const parts = [];
  let patchedNals = 0;
  let offset = 0;
  while (offset < sampleData.byteLength) {
    if (offset + lengthSize > sampleData.byteLength) throw new Mp4Error('Encoded sample has a truncated NAL length prefix');
    const length = lengthSize === 1 ? view.getUint8(offset)
      : lengthSize === 2 ? view.getUint16(offset)
        : lengthSize === 3 ? ((view.getUint8(offset) << 16) | view.getUint16(offset + 1))
          : view.getUint32(offset);
    const start = offset + lengthSize;
    const end = start + length;
    if (length === 0 || end > sampleData.byteLength) throw new Mp4Error('Encoded sample contains an invalid NAL length');
    const nal = sampleData.subarray(start, end);
    let patched = nal;
    if ((nal[0] & 0x1f) === IDR_NAL_TYPE) {
      const state = sliceHeaderState(nal);
      state.bits.readBits(log2MaxFrameNum);
      state.bits.readUnsignedExpGolomb();
      const position = state.bits.bit;
      if (position + log2MaxPicOrderCntLsb > state.rbsp.byteLength * 8) {
        throw new Mp4Error('H.264 IDR slice is too short to patch pic_order_cnt_lsb');
      }
      writeFixedBits(state.rbsp, position, log2MaxPicOrderCntLsb, 0);
      const escaped = escapeRbsp(state.rbsp);
      patched = new Uint8Array(escaped.byteLength + 1);
      patched[0] = nal[0];
      patched.set(escaped, 1);
      patchedNals += 1;
    }
    parts.push(writeLengthPrefix(patched.byteLength, lengthSize), patched);
    offset = end;
  }
  return {data: concatBytes(parts), patchedNals};
}

function patchSampleFrameNumber(sampleData, lengthSize, log2MaxFrameNum, frameNumber, pictureOrderCount = null) {
  const view = new DataView(sampleData.buffer, sampleData.byteOffset, sampleData.byteLength);
  const parts = [];
  let patchedNals = 0;
  let offset = 0;
  while (offset < sampleData.byteLength) {
    if (offset + lengthSize > sampleData.byteLength) throw new Mp4Error('Encoded sample has a truncated NAL length prefix');
    const length = lengthSize === 1 ? view.getUint8(offset)
      : lengthSize === 2 ? view.getUint16(offset)
        : lengthSize === 3 ? ((view.getUint8(offset) << 16) | view.getUint16(offset + 1))
          : view.getUint32(offset);
    const start = offset + lengthSize;
    const end = start + length;
    if (length === 0 || end > sampleData.byteLength) throw new Mp4Error('Encoded sample contains an invalid NAL length');
    const nal = sampleData.subarray(start, end);
    const patched = (nal[0] & 0x1f) === 1 ? patchSliceHeader(nal, log2MaxFrameNum, frameNumber, pictureOrderCount) : nal;
    if (patched !== nal) patchedNals += 1;
    parts.push(writeLengthPrefix(patched.byteLength, lengthSize), patched);
    offset = end;
  }
  const output = concatBytes(parts);
  return {data: output, patchedNals};
}

function alignFirstBGop(inputA, parsedA, inputB, parsedB, preparedB) {
  const bConfig = parseAvcConfig(inputB, parsedB.videoTrack.avcC);
  const bSps = bConfig.sps.length ? parseSps(bConfig.sps[0]) : null;
  const aConfig = parseAvcConfig(inputA, parsedA.videoTrack.avcC);
  const aSps = aConfig.sps.length ? parseSps(aConfig.sps[0]) : null;
  if (!bSps) throw new Mp4Error('Clip B has no SPS for frame-number alignment');
  if (!aSps) throw new Mp4Error('Clip A has no SPS for frame-number alignment');
  const reordering = inspectPictureReordering(inputB, parsedB);
  if (bSps.picOrderCntType !== 2 && !reordering.noReordering) {
    if (preparedB.idrSamples.length > 1) {
      const evidence = [
        reordering.compositionReordered ? 'ctts contains non-zero composition offsets' : null,
        reordering.bSliceCount ? `${reordering.bSliceCount} B-slice NAL${reordering.bSliceCount === 1 ? '' : 's'}` : null,
      ].filter(Boolean).join('; ');
      throw new Mp4Error(`Multi-GOP B frame-number alignment rejected: pic_order_cnt_type ${bSps.picOrderCntType} stream has picture reordering (${evidence}).`);
    }
    return {applied: false, reason: 'single-gop-picture-reordering'};
  }
  if (aSps.log2MaxFrameNum !== bSps.log2MaxFrameNum) {
    throw new Mp4Error(`Multi-GOP B frame-number alignment requires matching log2_max_frame_num (${aSps.log2MaxFrameNum} ≠ ${bSps.log2MaxFrameNum}).`);
  }
  if (bSps.picOrderCntType !== 2 && aSps.picOrderCntType !== bSps.picOrderCntType) {
    throw new Mp4Error(`Frame-number alignment cannot combine A pic_order_cnt_type ${aSps.picOrderCntType} with B pic_order_cnt_type ${bSps.picOrderCntType}.`);
  }
  if (bSps.picOrderCntType === 0 && aSps.log2MaxPicOrderCntLsb !== bSps.log2MaxPicOrderCntLsb) {
    throw new Mp4Error(`Frame-number alignment requires matching log2_max_pic_order_cnt_lsb (${aSps.log2MaxPicOrderCntLsb} ≠ ${bSps.log2MaxPicOrderCntLsb}).`);
  }

  const aSlices = extractNals(inputA, parsedA.videoTrack).filter(nal => nal.type === 1 || nal.type === IDR_NAL_TYPE);
  const lastASlice = aSlices[aSlices.length - 1];
  if (!lastASlice) throw new Mp4Error('Clip A has no slice for frame-number alignment');
  const aLastFrameNum = readSliceFrameNumber(lastASlice.data, bSps.log2MaxFrameNum);
  let aLastPicOrderCntLsb = null;
  if (bSps.picOrderCntType === 0) {
    const {bits, frameNumberBit} = sliceHeaderState(lastASlice.data);
    bits.readBits(bSps.log2MaxFrameNum);
    if ((lastASlice.data[0] & 0x1f) === IDR_NAL_TYPE) bits.readUnsignedExpGolomb();
    if (frameNumberBit + bSps.log2MaxFrameNum + bSps.log2MaxPicOrderCntLsb > bits.bytes.byteLength * 8) {
      throw new Mp4Error('Clip A slice is too short to read pic_order_cnt_lsb');
    }
    aLastPicOrderCntLsb = bits.readBits(bSps.log2MaxPicOrderCntLsb);
  }
  const modulo = 2 ** bSps.log2MaxFrameNum;
  const pocModulo = bSps.picOrderCntType === 0 ? 2 ** bSps.log2MaxPicOrderCntLsb : null;
  const hasRecoveryIdr = preparedB.reInsertedIdrPositions.length > 0;
  const nextIdrSample = hasRecoveryIdr
    ? preparedB.reInsertedIdrPositions[0]
    : preparedB.idrSamples[1] ?? parsedB.videoTrack.samples.length;
  let patchedSamples = 0;
  let patchedNals = 0;

  for (const sample of preparedB.samples) {
    if (sample.sourceSampleIndex >= nextIdrSample) break;
    if (sample.reInsertedIdr) continue;
    const frameNumber = (aLastFrameNum + (sample.sourceSampleIndex - preparedB.firstIdrSample)) % modulo;
    const pictureOrderCount = bSps.picOrderCntType === 0 ? {
      value: (aLastPicOrderCntLsb + (sample.sourceSampleIndex - preparedB.firstIdrSample)) % pocModulo,
      log2MaxPicOrderCntLsb: bSps.log2MaxPicOrderCntLsb,
    } : null;
    const patched = patchSampleFrameNumber(sample.data, parsedB.videoTrack.lengthSize, bSps.log2MaxFrameNum, frameNumber, pictureOrderCount);
    if (patched.patchedNals === 0) continue;
    sample.data = patched.data;
    patchedSamples += 1;
    patchedNals += patched.patchedNals;
  }
  if (patchedNals === 0 && !hasRecoveryIdr) throw new Mp4Error('Multi-GOP B has no first-GOP slices to align');

  return {
    applied: patchedNals > 0,
    reason: patchedNals === 0 ? 'recovery-idr-before-first-delta' : undefined,
    recoveryIdrSourceSample: hasRecoveryIdr ? nextIdrSample : null,
    aLastFrameNum,
    nextIdrSample,
    patchedSamples,
    patchedNals,
    log2MaxFrameNum: bSps.log2MaxFrameNum,
    picOrderCntType: bSps.picOrderCntType,
    pictureOrderCountPatch: bSps.picOrderCntType === 0 ? {
      aLastPicOrderCntLsb,
      log2MaxPicOrderCntLsb: bSps.log2MaxPicOrderCntLsb,
    } : null,
    pictureReordering: reordering,
    emulationPrevention: 'RBSP bytes are unescaped, patched, then re-escaped with fresh emulation-prevention bytes',
  };
}

export async function mergeMoshH264(inputA, inputB, parsedA = parseMp4(inputA), parsedB = parseMp4(inputB), options = {}) {
  if (!(inputA instanceof Uint8Array) || !(inputB instanceof Uint8Array)) throw new TypeError('mergeMoshH264 expects two Uint8Array clips');
  const compatibility = await checkCompatibility(inputA, inputB, parsedA, parsedB);
  if (!compatibility.compatible) throw new CompatibilityError(compatibility);
  if (!parsedA.mvhd || !parsedA.videoTrack.tkhd || !parsedA.videoTrack.mdhd) throw new Mp4Error('Clip A is missing required duration metadata');
  if (parsedA.videoTrack.stts.durations.length !== parsedA.videoTrack.samples.length) throw new Mp4Error('A stts sample count does not match its sample table');

  const preparedB = prepareB(inputB, parsedB, options);
  const frameAlignment = alignFirstBGop(inputA, parsedA, inputB, parsedB, preparedB);
  const aSamples = parsedA.videoTrack.samples.map(sample => inputA.subarray(sample.offset, sample.offset + sample.size));
  const bSamples = preparedB.samples.map(sample => sample.data);
  const sampleParts = [...aSamples, ...bSamples];
  const sizes = sampleParts.map(sample => sample.byteLength);
  const durations = [
    ...parsedA.videoTrack.stts.durations,
    ...preparedB.samples.map(sample => sample.duration),
  ];
  const compositionOffsets = [
    ...(parsedA.videoTrack.ctts?.offsets ?? parsedA.videoTrack.samples.map(() => 0)),
    ...preparedB.samples.map(sample => sample.compositionOffset),
  ];
  const built = buildMergedTrack(inputA, parsedA, sampleParts, durations, compositionOffsets);
  const {output, outputMp4, outputNals, chunkOffset, mergedDuration} = built;
  const idrNals = outputNals.filter(nal => nal.type === IDR_NAL_TYPE);
  const firstSampleNals = outputNals.filter(nal => nal.sampleIndex === 0);
  const leadingIdrNalCount = firstSampleNals.filter(nal => nal.type === IDR_NAL_TYPE).length;
  const leadingIdrSampleCount = leadingIdrNalCount > 0 ? 1 : 0;
  const startsWithSingleIdr = leadingIdrSampleCount === 1;

  return {
    output,
    cut: new Uint8Array(inputA),
    compatibility,
    report: {
      sourceABytes: inputA.byteLength,
      sourceBBytes: inputB.byteLength,
      outputBytes: output.byteLength,
      aSamples: aSamples.length,
      bSamples: parsedB.videoTrack.samples.length,
      bSamplesKept: bSamples.length,
      bSkippedPrefixSamples: preparedB.skippedPrefix,
      bSkippedEmptySamples: preparedB.skippedEmpty,
      bFirstIdrSample: preparedB.firstIdrSample,
      bRemovedNals: preparedB.removedCounts,
      bIdrSamples: preparedB.idrSamples,
      mergedSamples: sizes.length,
      mergedDurationUnits: mergedDuration,
      mergedDurationSeconds: mergedDuration / parsedA.videoTrack.mdhd.timescale,
      timescale: parsedA.videoTrack.mdhd.timescale,
      chunkOffset,
      mdatPayloadBytes: sampleParts.reduce((total, sample) => total + sample.byteLength, 0),
      sampleSizeSum: sizes.reduce((total, value) => total + value, 0),
      idrCount: idrNals.length,
      bIdrCountRemaining: preparedB.laterIdrCount + preparedB.reInsertedIdrPositions.length,
      bPictureSamples: preparedB.pictureSamples,
      bRemovedIdrSamples: preparedB.removedIdrSamples,
      durationFrames: preparedB.settings.durationFrames,
      requestedDurationFrames: preparedB.settings.requestedFrames,
      maximumDurationFrames: preparedB.settings.maximumFrames,
      durationSeconds: preparedB.settings.durationSeconds,
      fps: preparedB.settings.fps,
      ending: preparedB.settings.ending,
      clamped: preparedB.settings.clamped,
      reInsertedIdrPositions: preparedB.reInsertedIdrPositions,
      duration_frames: preparedB.settings.durationFrames,
      ending: preparedB.settings.ending,
      re_inserted_idr_positions: preparedB.reInsertedIdrPositions,
      frameAlignment,
      leadingIdrNalCount,
      leadingIdrSampleCount,
      startsWithIdrFrame: leadingIdrSampleCount === 1,
      startsWithSingleIdr,
      audio: 'omitted in Phase B',
    },
  };
}

export async function mergeEffectH264(inputA, inputB, parsedA = parseMp4(inputA), parsedB = parseMp4(inputB), options = {}) {
  if (!(inputA instanceof Uint8Array) || !(inputB instanceof Uint8Array)) throw new TypeError('mergeEffectH264 expects two Uint8Array clips');
  const method = options.method ?? options.effect;
  if (!['melt', 'loop', 'reset-pulse'].includes(method)) throw new TypeError('mergeEffectH264 expects method "melt", "loop", or "reset-pulse"');
  const compatibility = await checkCompatibility(inputA, inputB, parsedA, parsedB);
  if (!compatibility.compatible) throw new CompatibilityError(compatibility);
  if (!parsedA.mvhd || !parsedA.videoTrack.tkhd || !parsedA.videoTrack.mdhd) throw new Mp4Error('Clip A is missing required duration metadata');
  if (parsedA.videoTrack.stts.durations.length !== parsedA.videoTrack.samples.length) throw new Mp4Error('A stts sample count does not match its sample table');
  if (parsedB.videoTrack.stts.durations.length !== parsedB.videoTrack.samples.length) throw new Mp4Error('B stts sample count does not match its sample table');

  const eligibility = assertEffectEligible(inputA, parsedA, inputB, parsedB, method);
  const preparedB = prepareEffectB(inputB, parsedB, method, options);
  const frameAlignment = renumberEffectSamples(inputA, parsedA, inputB, parsedB, preparedB);
  const aSamples = parsedA.videoTrack.samples.map(sample => inputA.subarray(sample.offset, sample.offset + sample.size));
  const bSamples = preparedB.samples.map(sample => sample.data);
  const sampleParts = [...aSamples, ...bSamples];
  const durations = [
    ...parsedA.videoTrack.stts.durations,
    ...preparedB.samples.map(sample => sample.duration),
  ];
  const compositionOffsets = [
    ...(parsedA.videoTrack.ctts?.offsets ?? parsedA.videoTrack.samples.map(() => 0)),
    ...preparedB.samples.map(sample => sample.compositionOffset),
  ];
  const built = buildMergedTrack(inputA, parsedA, sampleParts, durations, compositionOffsets);
  const {output, outputMp4, outputNals, chunkOffset, mergedDuration} = built;
  const firstSampleNals = outputNals.filter(nal => nal.sampleIndex === 0);
  const leadingIdrNalCount = firstSampleNals.filter(nal => nal.type === IDR_NAL_TYPE).length;
  const leadingIdrSampleCount = leadingIdrNalCount > 0 ? 1 : 0;
  const mergedResetPulse = preparedB.resetPulse ? {
    ...preparedB.resetPulse,
    resetOutputPositions: preparedB.resetPulse.resetOutputPositions.map(position => aSamples.length + position),
    intervals: preparedB.resetPulse.intervals.map(interval => ({
      ...interval,
      resetPosition: aSamples.length + interval.resetPosition,
    })),
    tail: {
      ...preparedB.resetPulse.tail,
      outputStart: aSamples.length + preparedB.resetPulse.tail.outputStart,
      restoreResetPosition: preparedB.resetPulse.tail.restoreResetPosition === null
        ? null
        : aSamples.length + preparedB.resetPulse.tail.restoreResetPosition,
    },
  } : null;
  const mergedEffectWindow = {
    ...preparedB.effectWindow,
    tail: preparedB.effectWindow.tail ? {
      ...preparedB.effectWindow.tail,
      outputStart: aSamples.length + preparedB.effectWindow.tail.outputStart,
      restoreResetPosition: preparedB.effectWindow.tail.restoreResetPosition === null
        ? null
        : aSamples.length + preparedB.effectWindow.tail.restoreResetPosition,
    } : null,
  };
  const mergedReInsertedPositions = preparedB.reInsertedIdrPositions
    .map(position => aSamples.length + position);

  return {
    output,
    cut: new Uint8Array(inputA),
    compatibility,
    report: {
      method,
      effect: {
        ...preparedB.effect,
        loopWindow: preparedB.loopWindow,
        loopSecondWindow: preparedB.loopSecondWindow,
        loopSchedule: preparedB.loopSchedule,
        window: mergedEffectWindow,
        resetPulse: preparedB.resetPulse,
        repeatedSourceSamples: preparedB.repeatedSourceSamples,
        scheduledSourceSamples: preparedB.samples.map(sample => sample.sourceSampleIndex),
      },
      eligibility,
      sourceABytes: inputA.byteLength,
      sourceBBytes: inputB.byteLength,
      outputBytes: output.byteLength,
      aSamples: aSamples.length,
      bSamples: parsedB.videoTrack.samples.length,
      bSamplesKept: bSamples.length,
      bScheduledSamples: bSamples.length,
      bSkippedPrefixSamples: preparedB.skippedPrefix,
      bSkippedEmptySamples: preparedB.skippedEmpty,
      bFirstIdrSample: preparedB.firstIdrSample,
      bRemovedNals: preparedB.removedCounts,
      bIdrSamples: preparedB.idrSamples,
      bRemovedIdrSamples: preparedB.removedIdrSamples,
      bPictureSamples: preparedB.pictureSamples,
      bIdrCountRemaining: preparedB.laterIdrCount + preparedB.reInsertedIdrPositions.length,
      reInsertedIdrPositions: mergedReInsertedPositions,
      effectWindow: mergedEffectWindow,
      durationFrames: preparedB.settings.durationFrames,
      requestedDurationFrames: preparedB.settings.requestedFrames,
      maximumDurationFrames: preparedB.settings.maximumFrames,
      durationSeconds: preparedB.settings.durationSeconds,
      fps: preparedB.settings.fps,
      ending: preparedB.settings.ending,
      clamped: preparedB.settings.clamped,
      duration_frames: preparedB.settings.durationFrames,
      re_inserted_idr_positions: mergedReInsertedPositions,
      resetPulse: mergedResetPulse ? {
        ...mergedResetPulse,
        patchedSamples: frameAlignment.patchedSamples,
        patchedNals: frameAlignment.patchedNals,
        patchedIdrNals: frameAlignment.patchedIdrNals,
      } : null,
      mergedSamples: sampleParts.length,
      mergedDurationUnits: mergedDuration,
      mergedDurationSeconds: mergedDuration / parsedA.videoTrack.mdhd.timescale,
      timescale: parsedA.videoTrack.mdhd.timescale,
      chunkOffset,
      mdatPayloadBytes: sampleParts.reduce((total, sample) => total + sample.byteLength, 0),
      sampleSizeSum: sampleParts.reduce((total, sample) => total + sample.byteLength, 0),
      idrCount: outputNals.filter(nal => nal.type === IDR_NAL_TYPE).length,
      frameAlignment,
      leadingIdrNalCount,
      leadingIdrSampleCount,
      startsWithIdrFrame: leadingIdrSampleCount === 1,
      startsWithSingleIdr: leadingIdrSampleCount === 1,
      audio: 'omitted',
    },
  };
}

function buildMergedTrack(inputA, parsedA, sampleParts, durations, compositionOffsets) {
  if (sampleParts.length === 0) throw new Mp4Error('Merged video has no samples');
  const sizes = sampleParts.map(sample => sample.byteLength);
  const ftypParts = parsedA.boxes.filter(box => box.type === 'ftyp').map(box => inputA.subarray(box.start, box.end));
  if (ftypParts.length === 0) throw new Mp4Error('Clip A has no ftyp box');
  const ftyp = concatBytes(ftypParts);
  const mdat = makeBox('mdat', sampleParts);
  const mdatHeaderSize = mdat.byteLength - sampleParts.reduce((total, sample) => total + sample.byteLength, 0);

  let chunkOffset = 0;
  let use64 = false;
  let moov;
  for (let attempt = 0; attempt < 6; attempt += 1) {
    moov = rebuildMoov(inputA, parsedA, sizes, durations, compositionOffsets, chunkOffset, use64);
    const predictedOffset = ftyp.byteLength + moov.byteLength + mdatHeaderSize;
    const predictedUse64 = predictedOffset > 0xffffffff;
    if (predictedOffset === chunkOffset && predictedUse64 === use64) break;
    chunkOffset = predictedOffset;
    use64 = predictedUse64;
  }
  const finalMoov = rebuildMoov(inputA, parsedA, sizes, durations, compositionOffsets, chunkOffset, use64);
  const output = concatBytes([ftyp, finalMoov, mdat]);
  const mergedDuration = durations.reduce((total, value) => total + value, 0);
  const outputMp4 = parseMp4(output);
  return {
    output,
    outputMp4,
    outputNals: extractNals(output, outputMp4.videoTrack),
    chunkOffset,
    mergedDuration,
    sizes,
  };
}

export async function appendCutH264(inputA, inputB, parsedA = parseMp4(inputA), parsedB = parseMp4(inputB)) {
  if (!(inputA instanceof Uint8Array) || !(inputB instanceof Uint8Array)) throw new TypeError('appendCutH264 expects two Uint8Array clips');
  const compatibility = await checkCompatibility(inputA, inputB, parsedA, parsedB);
  if (!compatibility.compatible) throw new CompatibilityError(compatibility);
  if (!parsedA.mvhd || !parsedA.videoTrack.tkhd || !parsedA.videoTrack.mdhd) throw new Mp4Error('Clip A is missing required duration metadata');
  if (parsedA.videoTrack.stts.durations.length !== parsedA.videoTrack.samples.length) throw new Mp4Error('A stts sample count does not match its sample table');
  if (parsedB.videoTrack.stts.durations.length !== parsedB.videoTrack.samples.length) throw new Mp4Error('B stts sample count does not match its sample table');

  const aSamples = parsedA.videoTrack.samples.map(sample => inputA.subarray(sample.offset, sample.offset + sample.size));
  const bSamples = parsedB.videoTrack.samples.map(sample => inputB.subarray(sample.offset, sample.offset + sample.size));
  const sampleParts = [...aSamples, ...bSamples];
  const durations = [...parsedA.videoTrack.stts.durations, ...parsedB.videoTrack.stts.durations];
  const compositionOffsets = [
    ...(parsedA.videoTrack.ctts?.offsets ?? parsedA.videoTrack.samples.map(() => 0)),
    ...(parsedB.videoTrack.ctts?.offsets ?? parsedB.videoTrack.samples.map(() => 0)),
  ];
  const built = buildMergedTrack(inputA, parsedA, sampleParts, durations, compositionOffsets);
  return {
    output: built.output,
    cut: new Uint8Array(inputA),
    compatibility,
    report: {
      method: 'cut',
      sourceABytes: inputA.byteLength,
      sourceBBytes: inputB.byteLength,
      outputBytes: built.output.byteLength,
      aSamples: aSamples.length,
      bSamples: bSamples.length,
      bSamplesKept: bSamples.length,
      mergedSamples: sampleParts.length,
      mergedDurationUnits: built.mergedDuration,
      mergedDurationSeconds: built.mergedDuration / parsedA.videoTrack.mdhd.timescale,
      timescale: parsedA.videoTrack.mdhd.timescale,
      chunkOffset: built.chunkOffset,
      mdatPayloadBytes: sampleParts.reduce((total, sample) => total + sample.byteLength, 0),
      sampleSizeSum: built.sizes.reduce((total, value) => total + value, 0),
      idrCount: built.outputNals.filter(nal => nal.type === IDR_NAL_TYPE).length,
      frameAlignment: {applied: false, reason: 'cut'},
      audio: 'omitted',
    },
  };
}

export async function mergeSequenceH264(clips, methods = []) {
  if (!Array.isArray(clips) || clips.length < 1 || clips.length > 12) throw new TypeError('mergeSequenceH264 expects 1 to 12 clips');
  if (!Array.isArray(methods) || methods.length !== clips.length - 1) throw new TypeError('mergeSequenceH264 expects one method per boundary');
  const transitions = methods.map(entry => {
    const value = typeof entry === 'string' ? {method: entry} : entry;
    if (!value || !TRANSITION_METHODS.has(value.method)) return null;
    return {
      method: value.method,
      durationFrames: value.durationFrames,
      durationSeconds: value.durationSeconds ?? value.duration,
      ending: value.ending ?? (value.method === 'melt' || value.method === 'loop' ? 'continue' : 'restore'),
      repeat: value.repeat,
      smooth: value.smooth === true,
      loopFrames: value.loopFrames ?? value.loop_frames,
      resetInterval: value.resetInterval ?? value.reset_interval,
    };
  });
  if (transitions.some(transition => transition === null)) throw new TypeError('Transition methods must be cut, classic-mosh, melt, loop, or reset-pulse');
  for (const clip of clips) {
    if (!(clip?.bytes instanceof Uint8Array)) throw new TypeError('mergeSequenceH264 clips require bytes');
  }

  const first = clips[0];
  let currentBytes = new Uint8Array(first.bytes);
  let currentParsed = first.parsed ?? parseMp4(currentBytes);
  let expectedDecodedFrames = countPictureSamples(currentBytes, currentParsed.videoTrack);
  const boundaries = [];
  let sourceSamples = currentParsed.videoTrack.samples.length;
  let moshBoundaries = 0;
  let effectBoundaries = 0;
  let sourceBytes = first.bytes.byteLength;

  for (let index = 0; index < transitions.length; index += 1) {
    const transition = transitions[index];
    const method = transition.method;
    const incoming = clips[index + 1];
    const incomingParsed = incoming.parsed ?? parseMp4(incoming.bytes);
    let step;
    if (method === 'cut') {
      step = await appendCutH264(currentBytes, incoming.bytes, currentParsed, incomingParsed);
    } else if (method === 'melt' || method === 'loop' || method === 'reset-pulse') {
      step = await mergeEffectH264(currentBytes, incoming.bytes, currentParsed, incomingParsed, {
        method,
        repeat: transition.repeat,
        loopFrames: transition.loopFrames,
        resetInterval: transition.resetInterval,
        durationFrames: transition.durationFrames,
        durationSeconds: transition.durationSeconds,
        ending: transition.ending,
        smooth: transition.smooth,
      });
    } else {
      step = await mergeMoshH264(currentBytes, incoming.bytes, currentParsed, incomingParsed, {
        durationFrames: transition.durationFrames,
        durationSeconds: transition.durationSeconds,
        ending: transition.ending,
      });
    }
    sourceSamples += incomingParsed.videoTrack.samples.length;
    sourceBytes += incoming.bytes.byteLength;
    if (method === 'classic-mosh') {
      moshBoundaries += 1;
      expectedDecodedFrames += step.report.bPictureSamples;
    } else if (method === 'melt' || method === 'loop' || method === 'reset-pulse') {
      effectBoundaries += 1;
      expectedDecodedFrames += step.report.bPictureSamples;
    } else {
      expectedDecodedFrames += countPictureSamples(incoming.bytes, incomingParsed.videoTrack);
    }
    boundaries.push({
      boundaryIndex: index,
      fromClip: index,
      toClip: index + 1,
      method,
      compatibility: step.compatibility,
      report: step.report,
    });
    currentBytes = step.output;
    currentParsed = parseMp4(currentBytes);
  }

  const outputMp4 = currentParsed;
  const outputNals = extractNals(currentBytes, outputMp4.videoTrack);
  const mergedSamples = outputMp4.videoTrack.samples.length;
  return {
    output: currentBytes,
    cut: new Uint8Array(first.bytes),
    report: {
      clipCount: clips.length,
      transitionCount: transitions.length,
      methods: transitions.map(transition => transition.method),
      sourceSamples,
      moshBoundaries,
      effectBoundaries,
      cutBoundaries: transitions.filter(transition => transition.method === 'cut').length,
      mergedSamples,
      expectedDecodedFrames,
      sourceBytes,
      outputBytes: currentBytes.byteLength,
      mergedDurationUnits: outputMp4.videoTrack.stts.durations.reduce((total, value) => total + value, 0),
      mergedDurationSeconds: outputMp4.videoTrack.stts.durations.reduce((total, value) => total + value, 0) / outputMp4.videoTrack.mdhd.timescale,
      timescale: outputMp4.videoTrack.mdhd.timescale,
      idrCount: outputNals.filter(nal => nal.type === IDR_NAL_TYPE).length,
      boundaries: boundaries.map(boundary => ({
        boundaryIndex: boundary.boundaryIndex,
        fromClip: boundary.fromClip,
        toClip: boundary.toClip,
        method: boundary.method,
        mergedSamples: boundary.report.mergedSamples,
        removedSamples: Math.max(0, boundary.report.bSamples - boundary.report.bSamplesKept),
        removedIdrSamples: boundary.report.bRemovedIdrSamples ?? [],
        durationFrames: boundary.report.durationFrames ?? null,
        duration_frames: boundary.report.duration_frames ?? null,
        ending: boundary.report.ending ?? null,
        clamped: boundary.report.clamped ?? false,
        effect: boundary.report.effect ?? null,
        resetPulse: boundary.report.resetPulse ?? null,
        reInsertedIdrPositions: boundary.report.reInsertedIdrPositions ?? [],
        re_inserted_idr_positions: boundary.report.re_inserted_idr_positions ?? [],
        frameAlignment: boundary.report.frameAlignment,
        compatibility: compatibilityReportSummary(boundary.compatibility),
      })),
      audio: 'omitted',
    },
  };
}

function compatibilityReportSummary(compatibility) {
  return {
    compatible: compatibility.compatible,
    spsMatch: compatibility.spsMatch,
    ppsMatch: compatibility.ppsMatch,
    failedChecks: compatibility.checks.filter(check => check.required && !check.match).map(check => check.key),
  };
}

export { buildMergedTrack, fullBox, makeBox, makeChunkOffset, makeStsc, makeStss, makeStsz, makeStts, u32 };
