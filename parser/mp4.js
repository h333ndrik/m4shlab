const MAX_SAFE_BIGINT = BigInt(Number.MAX_SAFE_INTEGER);

export class Mp4Error extends Error {
  constructor(message) {
    super(message);
    this.name = 'Mp4Error';
  }
}

function ascii(bytes, start, length) {
  let value = '';
  for (let i = 0; i < length; i += 1) value += String.fromCharCode(bytes[start + i]);
  return value;
}

function viewOf(bytes) {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
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

function readUint64(view, offset) {
  const value = view.getBigUint64(offset);
  if (value > MAX_SAFE_BIGINT) throw new Mp4Error(`64-bit value at ${offset} exceeds JavaScript's safe integer range`);
  return Number(value);
}

function writeUint64(view, offset, value) {
  view.setBigUint64(offset, BigInt(value));
}

function boxHeader(bytes, offset, limit) {
  if (offset + 8 > limit) throw new Mp4Error(`Truncated box header at byte ${offset}`);
  const view = viewOf(bytes);
  let size = view.getUint32(offset);
  const type = ascii(bytes, offset + 4, 4);
  let headerSize = 8;
  let extended = false;

  if (size === 1) {
    if (offset + 16 > limit) throw new Mp4Error(`Truncated extended box header at byte ${offset}`);
    size = readUint64(view, offset + 8);
    headerSize = 16;
    extended = true;
  } else if (size === 0) {
    size = limit - offset;
  }

  if (size < headerSize) throw new Mp4Error(`Invalid ${type} box size ${size} at byte ${offset}`);
  if (offset + size > limit) throw new Mp4Error(`${type} box at byte ${offset} extends past its parent`);
  return { type, start: offset, size, headerSize, extended, payloadStart: offset + headerSize, payloadEnd: offset + size, end: offset + size };
}

export function parseBoxes(bytes, start = 0, end = bytes.byteLength) {
  const boxes = [];
  let offset = start;
  while (offset < end) {
    const box = boxHeader(bytes, offset, end);
    boxes.push(box);
    offset = box.end;
  }
  if (offset !== end) throw new Mp4Error(`Box stream ended at ${offset}, expected ${end}`);
  return boxes;
}

export function childBoxes(bytes, box) {
  return parseBoxes(bytes, box.payloadStart, box.payloadEnd);
}

export function childBox(bytes, boxes, type, required = true) {
  const found = boxes.find((candidate) => candidate.type === type);
  if (!found && required) throw new Mp4Error(`Missing ${type} box inside ${box.type}`);
  return found;
}

function uint32At(bytes, offset) {
  return viewOf(bytes).getUint32(offset);
}

function parseStsz(bytes, box) {
  const payloadLength = box.payloadEnd - box.payloadStart;
  if (payloadLength < 12) throw new Mp4Error('Truncated stsz box');
  const constantSize = uint32At(bytes, box.payloadStart + 4);
  const sampleCount = uint32At(bytes, box.payloadStart + 8);
  const requiredLength = 12 + (constantSize === 0 ? sampleCount * 4 : 0);
  if (payloadLength < requiredLength) throw new Mp4Error('Truncated stsz sample table');

  const sizes = new Uint32Array(sampleCount);
  if (constantSize === 0) {
    for (let i = 0; i < sampleCount; i += 1) sizes[i] = uint32At(bytes, box.payloadStart + 12 + i * 4);
  } else {
    sizes.fill(constantSize);
  }

  return {
    type: 'stsz',
    box,
    constantSize,
    sampleCount,
    sizes,
    sizeOffset(sampleIndex) {
      return this.constantSize === 0 ? box.payloadStart + 12 + sampleIndex * 4 : box.payloadStart + 4;
    },
  };
}

function parseStz2(bytes, box) {
  const payloadLength = box.payloadEnd - box.payloadStart;
  if (payloadLength < 12) throw new Mp4Error('Truncated stz2 box');
  const fieldSize = bytes[box.payloadStart + 7];
  if (fieldSize !== 4 && fieldSize !== 8 && fieldSize !== 16) throw new Mp4Error(`Unsupported stz2 field size ${fieldSize}`);
  const sampleCount = uint32At(bytes, box.payloadStart + 8);
  const entryBytes = Math.ceil((sampleCount * fieldSize) / 8);
  if (payloadLength < 12 + entryBytes) throw new Mp4Error('Truncated stz2 sample table');
  const sizes = new Uint32Array(sampleCount);
  const dataStart = box.payloadStart + 12;

  for (let i = 0; i < sampleCount; i += 1) {
    if (fieldSize === 4) {
      const value = bytes[dataStart + Math.floor(i / 2)];
      sizes[i] = i % 2 === 0 ? value >> 4 : value & 0x0f;
    } else if (fieldSize === 8) {
      sizes[i] = bytes[dataStart + i];
    } else {
      sizes[i] = (bytes[dataStart + i * 2] << 8) | bytes[dataStart + i * 2 + 1];
    }
  }

  return {
    type: 'stz2',
    box,
    fieldSize,
    sampleCount,
    sizes,
    sizeOffset(sampleIndex) {
      if (fieldSize === 16) return dataStart + sampleIndex * 2;
      if (fieldSize === 8) return dataStart + sampleIndex;
      return dataStart + Math.floor(sampleIndex / 2);
    },
  };
}

function parseTimeInfo(bytes, box) {
  if (box.payloadEnd - box.payloadStart < 20) throw new Mp4Error(`Truncated ${box.type} box`);
  const version = bytes[box.payloadStart];
  const view = viewOf(bytes);
  if (version === 1) {
    if (box.payloadEnd - box.payloadStart < 32) throw new Mp4Error(`Truncated version 1 ${box.type} box`);
    return {
      box,
      version,
      creationTime: readUint64(view, box.payloadStart + 4),
      modificationTime: readUint64(view, box.payloadStart + 12),
      timescale: view.getUint32(box.payloadStart + 20),
      duration: readUint64(view, box.payloadStart + 24),
      timescaleOffset: box.payloadStart + 20,
      durationOffset: box.payloadStart + 24,
    };
  }
  return {
    box,
    version,
    creationTime: view.getUint32(box.payloadStart + 4),
    modificationTime: view.getUint32(box.payloadStart + 8),
    timescale: view.getUint32(box.payloadStart + 12),
    duration: view.getUint32(box.payloadStart + 16),
    timescaleOffset: box.payloadStart + 12,
    durationOffset: box.payloadStart + 16,
  };
}

function parseTkhd(bytes, box) {
  if (box.payloadEnd - box.payloadStart < 24) return null;
  const version = bytes[box.payloadStart];
  const payloadLength = box.payloadEnd - box.payloadStart;
  if (version === 1) {
    if (payloadLength < 36) throw new Mp4Error('Truncated version 1 tkhd box');
    return {
      box,
      version,
      trackId: viewOf(bytes).getUint32(box.payloadStart + 20),
      duration: readUint64(viewOf(bytes), box.payloadStart + 28),
      durationOffset: box.payloadStart + 28,
    };
  }
  return {
    box,
    version,
    trackId: viewOf(bytes).getUint32(box.payloadStart + 12),
    duration: viewOf(bytes).getUint32(box.payloadStart + 20),
    durationOffset: box.payloadStart + 20,
  };
}

function parseCtts(bytes, box) {
  const payloadLength = box.payloadEnd - box.payloadStart;
  if (payloadLength < 8) throw new Mp4Error('Truncated ctts box');
  const version = bytes[box.payloadStart];
  if (version !== 0 && version !== 1) throw new Mp4Error(`Unsupported ctts version ${version}`);
  const entryCount = uint32At(bytes, box.payloadStart + 4);
  if (payloadLength < 8 + entryCount * 8) throw new Mp4Error('Truncated ctts entries');
  const entries = [];
  const offsets = [];
  let sampleCount = 0;
  for (let i = 0; i < entryCount; i += 1) {
    const offset = box.payloadStart + 8 + i * 8;
    const count = uint32At(bytes, offset);
    const rawOffset = uint32At(bytes, offset + 4);
    const sampleOffset = version === 1 && rawOffset >= 0x80000000 ? rawOffset - 0x100000000 : rawOffset;
    if (count === 0) throw new Mp4Error(`Invalid ctts entry ${i}`);
    entries.push({ count, offset: sampleOffset });
    for (let sample = 0; sample < count; sample += 1) offsets.push(sampleOffset);
    sampleCount += count;
  }
  return { box, version, entries, offsets, sampleCount };
}

function parseStts(bytes, box) {
  const payloadLength = box.payloadEnd - box.payloadStart;
  if (payloadLength < 8) throw new Mp4Error('Truncated stts box');
  const entryCount = uint32At(bytes, box.payloadStart + 4);
  if (payloadLength < 8 + entryCount * 8) throw new Mp4Error('Truncated stts entries');
  const entries = [];
  const durations = [];
  let sampleCount = 0;
  for (let i = 0; i < entryCount; i += 1) {
    const offset = box.payloadStart + 8 + i * 8;
    const count = uint32At(bytes, offset);
    const delta = uint32At(bytes, offset + 4);
    if (count === 0 || delta === 0) throw new Mp4Error(`Invalid stts entry ${i}`);
    entries.push({ count, delta });
    sampleCount += count;
    for (let sample = 0; sample < count; sample += 1) durations.push(delta);
  }
  return { box, entries, durations, sampleCount };
}

function parseStsc(bytes, box) {
  const payloadLength = box.payloadEnd - box.payloadStart;
  if (payloadLength < 8) throw new Mp4Error('Truncated stsc box');
  const entryCount = uint32At(bytes, box.payloadStart + 4);
  if (payloadLength < 8 + entryCount * 12) throw new Mp4Error('Truncated stsc entries');
  const entries = [];
  let previousFirstChunk = 0;
  for (let i = 0; i < entryCount; i += 1) {
    const offset = box.payloadStart + 8 + i * 12;
    const entry = {
      firstChunk: uint32At(bytes, offset),
      samplesPerChunk: uint32At(bytes, offset + 4),
      sampleDescriptionIndex: uint32At(bytes, offset + 8),
    };
    if (entry.firstChunk < 1 || entry.firstChunk <= previousFirstChunk || entry.samplesPerChunk < 1) {
      throw new Mp4Error(`Invalid stsc entry ${i}`);
    }
    entries.push(entry);
    previousFirstChunk = entry.firstChunk;
  }
  if (entries.length === 0) throw new Mp4Error('Empty stsc box');
  return entries;
}

function parseChunkOffsets(bytes, box) {
  const payloadLength = box.payloadEnd - box.payloadStart;
  if (payloadLength < 8) throw new Mp4Error(`Truncated ${box.type} box`);
  const entryCount = uint32At(bytes, box.payloadStart + 4);
  const width = box.type === 'co64' ? 8 : 4;
  if (payloadLength < 8 + entryCount * width) throw new Mp4Error(`Truncated ${box.type} entries`);
  const values = new Array(entryCount);
  const dataStart = box.payloadStart + 8;

  for (let i = 0; i < entryCount; i += 1) {
    const offset = dataStart + i * width;
    values[i] = width === 8 ? readUint64(viewOf(bytes), offset) : uint32At(bytes, offset);
  }

  return {
    type: box.type,
    box,
    width,
    values,
    entryOffset(chunkIndex) {
      return dataStart + chunkIndex * width;
    },
  };
}

function parseAvcConfiguration(bytes, entry, entryBoxes) {
  const avcC = childBox(entry, entryBoxes, 'avcC', false);
  if (!avcC) throw new Mp4Error(`Video sample entry ${entry.type} has no avcC configuration`);
  if (avcC.payloadEnd - avcC.payloadStart < 7) throw new Mp4Error('Truncated avcC box');
  const lengthSize = (bytes[avcC.payloadStart + 4] & 0x03) + 1;
  if (lengthSize === 3) throw new Mp4Error('Invalid H.264 NAL length size');
  return { avcC, lengthSize };
}

function parseStsd(bytes, box) {
  const payloadLength = box.payloadEnd - box.payloadStart;
  if (payloadLength < 8) throw new Mp4Error('Truncated stsd box');
  const entryCount = uint32At(bytes, box.payloadStart + 4);
  if (entryCount < 1) throw new Mp4Error('stsd contains no sample entries');
  const entries = parseBoxes(bytes, box.payloadStart + 8, box.payloadEnd);
  if (entries.length < entryCount) throw new Mp4Error('stsd entry count exceeds parsed entries');
  return entries;
}

function parseTrack(bytes, trak, mdatRanges) {
  const trakChildren = childBoxes(bytes, trak);
  const mdia = childBox(trak, trakChildren, 'mdia');
  const mdiaChildren = childBoxes(bytes, mdia);
  const hdlr = childBox(mdia, mdiaChildren, 'hdlr');
  if (hdlr.payloadStart + 12 > hdlr.payloadEnd) throw new Mp4Error('Truncated hdlr box');
  const handler = ascii(bytes, hdlr.payloadStart + 8, 4);
  const minf = childBox(mdia, mdiaChildren, 'minf', handler === 'vide' || handler === 'soun');
  if (!minf) return { handler, trak, complete: false };

  const mdhdBox = childBox(mdia, mdiaChildren, 'mdhd', false);
  const tkhdBox = childBox(trak, trakChildren, 'tkhd', false);
  const mdhd = mdhdBox ? parseTimeInfo(bytes, mdhdBox) : null;
  const tkhd = tkhdBox ? parseTkhd(bytes, tkhdBox) : null;
  const minfChildren = childBoxes(bytes, minf);
  const stbl = childBox(minf, minfChildren, 'stbl');
  const stblBoxes = childBoxes(bytes, stbl);
  const stsdBox = childBox(stbl, stblBoxes, 'stsd');
  const stscBox = childBox(stbl, stblBoxes, 'stsc');
  const sttsBox = childBox(stbl, stblBoxes, 'stts', false);
  const cttsBox = childBox(stbl, stblBoxes, 'ctts', false);
  const stcoBox = stblBoxes.find((candidate) => candidate.type === 'stco' || candidate.type === 'co64');
  const stszBox = stblBoxes.find((candidate) => candidate.type === 'stsz' || candidate.type === 'stz2');
  if (!stcoBox || !stszBox) throw new Mp4Error(`Track handler ${handler} has no supported sample size/chunk offset table`);

  const sampleSizes = stszBox.type === 'stsz' ? parseStsz(bytes, stszBox) : parseStz2(bytes, stszBox);
  const chunkOffsets = parseChunkOffsets(bytes, stcoBox);
  const stsc = parseStsc(bytes, stscBox);
  const stts = sttsBox ? parseStts(bytes, sttsBox) : null;
  const ctts = cttsBox ? parseCtts(bytes, cttsBox) : null;
  const sampleEntries = parseStsd(bytes, stsdBox);
  const samples = [];

  let sampleIndex = 0;
  for (let chunkIndex = 0; chunkIndex < chunkOffsets.values.length; chunkIndex += 1) {
    const chunkNumber = chunkIndex + 1;
    let active = stsc[0];
    for (const entry of stsc) {
      if (entry.firstChunk > chunkNumber) break;
      active = entry;
    }

    let sampleOffset = chunkOffsets.values[chunkIndex];
    for (let inChunk = 0; inChunk < active.samplesPerChunk; inChunk += 1) {
      if (sampleIndex >= sampleSizes.sampleCount) throw new Mp4Error(`Chunk table references more samples than stsz (${sampleSizes.sampleCount})`);
      const size = sampleSizes.sizes[sampleIndex];
      if (sampleOffset + size > bytes.byteLength) throw new Mp4Error(`Sample ${sampleIndex} extends past end of file`);
      if (!mdatRanges.some((range) => sampleOffset >= range.payloadStart && sampleOffset + size <= range.payloadEnd)) {
        throw new Mp4Error(`Sample ${sampleIndex} is outside every mdat box`);
      }
      samples.push({
        index: sampleIndex,
        chunkIndex,
        offset: sampleOffset,
        size,
        sampleDescriptionIndex: active.sampleDescriptionIndex,
      });
      sampleOffset += size;
      sampleIndex += 1;
    }
  }

  if (sampleIndex !== sampleSizes.sampleCount) throw new Mp4Error(`Chunk table maps ${sampleIndex} samples, stsz declares ${sampleSizes.sampleCount}`);

  let video = null;
  if (handler === 'vide') {
    const avcEntry = sampleEntries.find((entry) => entry.type === 'avc1' || entry.type === 'avc3');
    if (!avcEntry) throw new Mp4Error('Video track is not H.264 (expected an avc1 or avc3 sample entry)');
    if (avcEntry.payloadStart + 78 > avcEntry.payloadEnd) throw new Mp4Error('Truncated visual sample entry');
    const entryChildren = parseBoxes(bytes, avcEntry.payloadStart + 78, avcEntry.payloadEnd);
    const config = parseAvcConfiguration(bytes, avcEntry, entryChildren);
    const width = avcEntry.payloadStart + 26 <= avcEntry.payloadEnd ? (bytes[avcEntry.payloadStart + 24] << 8) | bytes[avcEntry.payloadStart + 25] : 0;
    const height = avcEntry.payloadStart + 28 <= avcEntry.payloadEnd ? (bytes[avcEntry.payloadStart + 26] << 8) | bytes[avcEntry.payloadStart + 27] : 0;
    video = { sampleEntry: avcEntry, lengthSize: config.lengthSize, avcC: config.avcC, width, height };
  }

  return {
    handler,
    trak,
    complete: true,
    stsd: { box: stsdBox, entries: sampleEntries },
    stsc,
    stts,
    ctts,
    mdhd,
    tkhd,
    sampleSizes,
    chunkOffsets,
    samples,
    video,
    lengthSize: video?.lengthSize,
    avcC: video?.avcC,
    width: video?.width,
    height: video?.height,
  };
}

export function parseMp4(bytes) {
  if (!(bytes instanceof Uint8Array)) throw new TypeError('parseMp4 expects a Uint8Array');
  if (bytes.byteLength < 8) throw new Mp4Error('File is too short to be an MP4');
  const boxes = parseBoxes(bytes);
  const moov = childBox({ type: 'file' }, boxes, 'moov');
  const mdatRanges = boxes.filter((box) => box.type === 'mdat');
  if (mdatRanges.length === 0) throw new Mp4Error('No mdat box found');

  const moovChildren = childBoxes(bytes, moov);
  const mvhdBox = childBox(moov, moovChildren, 'mvhd', false);
  const mvhd = mvhdBox ? parseTimeInfo(bytes, mvhdBox) : null;
  const tracks = moovChildren.filter((box) => box.type === 'trak').map((trak) => parseTrack(bytes, trak, mdatRanges));
  const videoTracks = tracks.filter((track) => track.video);
  if (videoTracks.length === 0) throw new Mp4Error('No H.264 video track found');
  if (videoTracks.length > 1) throw new Mp4Error('Phase A supports one video track per file');

  return {
    bytes,
    boxes,
    moov,
    mvhd,
    mdatRanges,
    tracks,
    videoTrack: videoTracks[0],
  };
}

function countRemovedBefore(ranges, offset) {
  let total = 0;
  for (const range of ranges) {
    if (range.end <= offset) total += range.end - range.start;
  }
  return total;
}

function patchBoxSize(bytes, box, newSize) {
  const view = viewOf(bytes);
  if (box.headerSize === 16) {
    writeUint64(view, box.start + 8, newSize);
  } else {
    if (newSize > 0xffffffff) throw new Mp4Error('Output box exceeds 32-bit MP4 size limit');
    view.setUint32(box.start, newSize);
  }
}

function patchSampleSize(bytes, table, sampleIndex, newSize) {
  const view = viewOf(bytes);
  if (table.type === 'stsz' && table.constantSize !== 0) {
    view.setUint32(table.box.payloadStart + 4, newSize);
    return;
  }

  if (table.type === 'stz2') {
    const maximum = table.fieldSize === 4 ? 15 : table.fieldSize === 8 ? 255 : 65535;
    if (newSize > maximum) throw new Mp4Error(`Modified sample ${sampleIndex} is too large for stz2/${table.fieldSize}`);
    if (table.fieldSize === 16) {
      view.setUint16(table.sizeOffset(sampleIndex), newSize);
    } else if (table.fieldSize === 8) {
      view.setUint8(table.sizeOffset(sampleIndex), newSize);
    } else {
      const offset = table.sizeOffset(sampleIndex);
      bytes[offset] = sampleIndex % 2 === 0
        ? (bytes[offset] & 0x0f) | (newSize << 4)
        : (bytes[offset] & 0xf0) | newSize;
    }
    return;
  }

  view.setUint32(table.sizeOffset(sampleIndex), newSize);
}

export function rewriteMp4(mp4, edits) {
  const input = mp4.bytes;
  const patched = new Uint8Array(input);
  const removedRanges = [...edits.removedRanges].sort((a, b) => a.start - b.start);
  const sampleSizeChanges = edits.sampleSizeChanges ?? [];
  const sizeTable = mp4.videoTrack.sampleSizes;
  if (sizeTable.type === 'stsz' && sizeTable.constantSize !== 0) {
    const changed = sampleSizeChanges.filter((change) => change.newSize !== change.oldSize);
    const uniqueSizes = new Set(changed.map((change) => change.newSize));
    if (changed.length > 0 && (changed.length !== sizeTable.sampleCount || uniqueSizes.size !== 1)) {
      throw new Mp4Error('This file uses a constant-size stsz table that cannot represent the modified samples');
    }
  }

  for (const change of sampleSizeChanges) {
    if (change.newSize === change.oldSize) continue;
    patchSampleSize(patched, mp4.videoTrack.sampleSizes, change.sampleIndex, change.newSize);
  }

  for (const track of mp4.tracks) {
    if (!track.complete || !track.chunkOffsets) continue;
    for (let i = 0; i < track.chunkOffsets.values.length; i += 1) {
      const oldOffset = track.chunkOffsets.values[i];
      const newOffset = oldOffset - countRemovedBefore(removedRanges, oldOffset);
      const entryOffset = track.chunkOffsets.entryOffset(i);
      if (track.chunkOffsets.width === 8) writeUint64(viewOf(patched), entryOffset, newOffset);
      else viewOf(patched).setUint32(entryOffset, newOffset);
    }
  }

  const parts = [];
  let removedTotal = 0;
  for (const box of mp4.boxes) {
    if (box.type !== 'mdat') {
      parts.push(patched.subarray(box.start, box.end));
      continue;
    }

    const localRanges = removedRanges.filter((range) => range.start >= box.payloadStart && range.end <= box.payloadEnd);
    const removedInBox = localRanges.reduce((total, range) => total + range.end - range.start, 0);
    const newBoxSize = box.size - removedInBox;
    patchBoxSize(patched, box, newBoxSize);
    parts.push(patched.subarray(box.start, box.payloadStart));

    let cursor = box.payloadStart;
    for (const range of localRanges) {
      if (range.start < cursor) throw new Mp4Error('Overlapping removed byte ranges');
      parts.push(input.subarray(cursor, range.start));
      cursor = range.end;
    }
    parts.push(input.subarray(cursor, box.payloadEnd));
    removedTotal += removedInBox;
  }

  if (removedTotal !== removedRanges.reduce((total, range) => total + range.end - range.start, 0)) {
    throw new Mp4Error('Removed ranges are not fully contained in mdat boxes');
  }

  const output = concatBytes(parts);
  for (const track of mp4.tracks) {
    if (!track.complete) continue;
    for (const sample of track.samples) {
      if (sample.offset + sample.size > input.byteLength) throw new Mp4Error(`Invalid source sample ${sample.index}`);
    }
  }
  return { output, patched };
}
