import { parseMp4, childBoxes, Mp4Error } from './parser/mp4.js';
import { extractNals } from './parser/nal.js';
import { parseSps } from './parser/sps.js';

const IDR_NAL_TYPE = 5;
const SEI_NAL_TYPE = 6;
const SPS_NAL_TYPE = 7;
const PPS_NAL_TYPE = 8;
const REMOVED_B_NAL_TYPES = new Set([IDR_NAL_TYPE, SEI_NAL_TYPE, SPS_NAL_TYPE, PPS_NAL_TYPE]);

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

function prepareB(inputB, parsedB) {
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

  const samples = [];
  const removedCounts = { idr: 0, sei: 0, sps: 0, pps: 0 };
  let skippedPrefix = 0;
  let skippedEmpty = 0;
  for (const sample of track.samples) {
    const sampleNals = bySample.get(sample.index) ?? [];
    if (sample.index === firstIdr.sampleIndex) {
      skippedPrefix += 1;
      for (const nal of sampleNals) {
        if (nal.type === IDR_NAL_TYPE) removedCounts.idr += 1;
        if (nal.type === SEI_NAL_TYPE) removedCounts.sei += 1;
        if (nal.type === SPS_NAL_TYPE) removedCounts.sps += 1;
        if (nal.type === PPS_NAL_TYPE) removedCounts.pps += 1;
      }
      continue;
    }

    const retained = sampleNals.filter(nal => {
      if (nal.type === IDR_NAL_TYPE) return true;
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
      duration: parsedB.videoTrack.stts.durations[sample.index],
      compositionOffset: parsedB.videoTrack.ctts?.offsets[sample.index] ?? 0,
      retainedNals: retained,
    });
  }
  return {
    firstIdrSample: firstIdr.sampleIndex,
    idrSamples: [...new Set(nals.filter(nal => nal.type === IDR_NAL_TYPE).map(nal => nal.sampleIndex))].sort((a, b) => a - b),
    skippedPrefix,
    skippedEmpty,
    removedCounts,
    laterIdrCount: samples.reduce((total, sample) => total + sample.retainedNals.filter(nal => nal.type === IDR_NAL_TYPE).length, 0),
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
  bits.readUnsignedExpGolomb();
  bits.readUnsignedExpGolomb();
  return {rbsp, bits, frameNumberBit: bits.bit};
}

function readSliceFrameNumber(nalData, log2MaxFrameNum) {
  const {rbsp, bits, frameNumberBit} = sliceHeaderState(nalData);
  if (frameNumberBit + log2MaxFrameNum > rbsp.byteLength * 8) throw new Mp4Error('H.264 slice is too short to read frame_num');
  return bits.readBits(log2MaxFrameNum);
}

function patchSliceFrameNumber(nalData, log2MaxFrameNum, frameNumber) {
  const {rbsp, frameNumberBit} = sliceHeaderState(nalData);
  if (frameNumberBit + log2MaxFrameNum > rbsp.byteLength * 8) throw new Mp4Error('H.264 slice is too short to patch frame_num');
  const value = frameNumber % (2 ** log2MaxFrameNum);
  for (let i = 0; i < log2MaxFrameNum; i += 1) {
    const position = frameNumberBit + i;
    if ((value >> (log2MaxFrameNum - 1 - i)) & 1) rbsp[position >> 3] |= 1 << (7 - (position & 7));
    else rbsp[position >> 3] &= ~(1 << (7 - (position & 7)));
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

function patchSampleFrameNumber(sampleData, lengthSize, log2MaxFrameNum, frameNumber) {
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
    const patched = (nal[0] & 0x1f) === 1 ? patchSliceFrameNumber(nal, log2MaxFrameNum, frameNumber) : nal;
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
  if (bSps.picOrderCntType !== 2) {
    if (preparedB.idrSamples.length > 1) {
      throw new Mp4Error('Multi-GOP B frame-number alignment requires pic_order_cnt_type 2 (no picture-order reordering).');
    }
    return {applied: false, reason: 'single-gop-picture-reordering'};
  }
  if (aSps.log2MaxFrameNum !== bSps.log2MaxFrameNum) {
    throw new Mp4Error(`Multi-GOP B frame-number alignment requires matching log2_max_frame_num (${aSps.log2MaxFrameNum} ≠ ${bSps.log2MaxFrameNum}).`);
  }

  const aSlices = extractNals(inputA, parsedA.videoTrack).filter(nal => nal.type === 1 || nal.type === IDR_NAL_TYPE);
  const lastASlice = aSlices[aSlices.length - 1];
  if (!lastASlice) throw new Mp4Error('Clip A has no slice for frame-number alignment');
  const aLastFrameNum = readSliceFrameNumber(lastASlice.data, bSps.log2MaxFrameNum);
  const modulo = 2 ** bSps.log2MaxFrameNum;
  const nextIdrSample = preparedB.idrSamples[1] ?? parsedB.videoTrack.samples.length;
  let patchedSamples = 0;
  let patchedNals = 0;

  for (const sample of preparedB.samples) {
    if (sample.sourceSampleIndex >= nextIdrSample) break;
    const frameNumber = (aLastFrameNum + (sample.sourceSampleIndex - preparedB.firstIdrSample)) % modulo;
    const patched = patchSampleFrameNumber(sample.data, parsedB.videoTrack.lengthSize, bSps.log2MaxFrameNum, frameNumber);
    if (patched.patchedNals === 0) continue;
    sample.data = patched.data;
    patchedSamples += 1;
    patchedNals += patched.patchedNals;
  }
  if (patchedNals === 0) throw new Mp4Error('Multi-GOP B has no first-GOP slices to align');

  return {
    applied: true,
    aLastFrameNum,
    nextIdrSample,
    patchedSamples,
    patchedNals,
    log2MaxFrameNum: bSps.log2MaxFrameNum,
    picOrderCntType: bSps.picOrderCntType,
    emulationPrevention: 'RBSP bytes are unescaped, patched, then re-escaped with fresh emulation-prevention bytes',
  };
}

export async function mergeMoshH264(inputA, inputB, parsedA = parseMp4(inputA), parsedB = parseMp4(inputB)) {
  if (!(inputA instanceof Uint8Array) || !(inputB instanceof Uint8Array)) throw new TypeError('mergeMoshH264 expects two Uint8Array clips');
  const compatibility = await checkCompatibility(inputA, inputB, parsedA, parsedB);
  if (!compatibility.compatible) throw new CompatibilityError(compatibility);
  if (!parsedA.mvhd || !parsedA.videoTrack.tkhd || !parsedA.videoTrack.mdhd) throw new Mp4Error('Clip A is missing required duration metadata');
  if (parsedA.videoTrack.stts.durations.length !== parsedA.videoTrack.samples.length) throw new Mp4Error('A stts sample count does not match its sample table');

  const preparedB = prepareB(inputB, parsedB);
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
  if (sizes.length === 0) throw new Mp4Error('Merged video has no samples');

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
  const outputNals = extractNals(output, outputMp4.videoTrack);
  const idrNals = outputNals.filter(nal => nal.type === IDR_NAL_TYPE);
  const firstSampleNals = outputNals.filter(nal => nal.sampleIndex === 0);
  const leadingIdrNalCount = firstSampleNals.filter(nal => nal.type === IDR_NAL_TYPE).length;
  const startsWithSingleIdr = leadingIdrNalCount === 1;

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
      bIdrCountRemaining: preparedB.laterIdrCount,
      frameAlignment,
      leadingIdrNalCount,
      startsWithIdrFrame: leadingIdrNalCount > 0,
      startsWithSingleIdr,
      audio: 'omitted in Phase B',
    },
  };
}

export { fullBox, makeBox, makeChunkOffset, makeStsc, makeStss, makeStsz, makeStts, u32 };
