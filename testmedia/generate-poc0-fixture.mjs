import {readFileSync, writeFileSync} from 'node:fs';
import {parseMp4} from '../parser/mp4.js';
import {extractNals} from '../parser/nal.js';
import {parseAvcConfig} from '../merge.js';
import {buildNormalizedMp4} from '../webcodecs-muxer.js';

class BitReader {
  constructor(bytes, bit = 0) {
    this.bytes = bytes;
    this.bit = bit;
  }

  readBit() {
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
    while (this.readBit() === 0) zeros += 1;
    return (2 ** zeros) - 1 + (zeros === 0 ? 0 : this.readBits(zeros));
  }
}

class BitWriter {
  constructor() {
    this.bits = [];
  }

  writeBit(value) {
    this.bits.push(value & 1);
  }

  writeBits(value, count) {
    for (let i = count - 1; i >= 0; i -= 1) this.writeBit((value >> i) & 1);
  }

  writeRange(bytes, start, end) {
    for (let bit = start; bit < end; bit += 1) {
      this.writeBit((bytes[bit >> 3] >> (7 - (bit & 7))) & 1);
    }
  }

  bytes() {
    const output = new Uint8Array(Math.ceil(this.bits.length / 8));
    for (let i = 0; i < this.bits.length; i += 1) output[i >> 3] |= this.bits[i] << (7 - (i & 7));
    return output;
  }
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

function replaceSpsWithPocType0(spsNal) {
  const rbsp = unescapeRbsp(spsNal.subarray(1));
  const reader = new BitReader(rbsp);
  const profileIdc = rbsp[0];
  reader.readBits(24);
  reader.readUe();
  const highProfiles = new Set([44, 83, 86, 100, 110, 118, 122, 128, 134, 135, 138, 139, 244]);
  if (highProfiles.has(profileIdc)) {
    const chromaFormatIdc = reader.readUe();
    if (chromaFormatIdc === 3) reader.readBit();
    reader.readUe();
    reader.readUe();
    reader.readBit();
    if (reader.readBit()) {
      const count = chromaFormatIdc === 3 ? 12 : 8;
      for (let i = 0; i < count; i += 1) {
        if (reader.readBit()) {
          let lastScale = 8;
          let nextScale = 8;
          for (let j = 0; j < (i < 6 ? 16 : 64); j += 1) {
            if (nextScale !== 0) {
              const value = reader.readUe();
              const delta = value % 2 === 0 ? -(Math.ceil(value / 2)) : Math.ceil(value / 2);
              nextScale = (lastScale + delta + 256) % 256;
            }
            lastScale = nextScale === 0 ? lastScale : nextScale;
          }
        }
      }
    }
  }
  reader.readUe();
  const pocTypeBit = reader.bit;
  const originalPocType = reader.readUe();
  const remaining = reader.bit;
  const writer = new BitWriter();
  writer.writeRange(rbsp, 0, pocTypeBit);
  writer.writeBit(1);
  writer.writeBit(1);
  writer.writeRange(rbsp, remaining, rbsp.byteLength * 8);
  return {nal: Uint8Array.from([spsNal[0], ...escapeRbsp(writer.bytes())]), originalPocType};
}

function replaceSps(description, spsNal) {
  const offset = 5;
  const spsCount = description[offset] & 0x1f;
  if (spsCount !== 1) throw new Error(`Fixture generator expects one SPS, found ${spsCount}`);
  let cursor = offset + 1;
  const oldLength = (description[cursor] << 8) | description[cursor + 1];
  cursor += 2 + oldLength;
  const ppsCount = description[cursor++];
  const parts = [description.subarray(0, offset + 1), new Uint8Array(2), spsNal, Uint8Array.of(ppsCount)];
  new DataView(parts[1].buffer).setUint16(0, spsNal.byteLength);
  for (let i = 0; i < ppsCount; i += 1) {
    const length = (description[cursor] << 8) | description[cursor + 1];
    cursor += 2;
    parts.push(description.subarray(cursor - 2, cursor + length));
    cursor += length;
  }
  const total = parts.reduce((sum, part) => sum + part.byteLength, 0);
  const output = new Uint8Array(total);
  let write = 0;
  for (const part of parts) {
    output.set(part, write);
    write += part.byteLength;
  }
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

function patchSlicePoc(nal, log2MaxFrameNum, pocLsb) {
  const type = nal[0] & 0x1f;
  if (type !== 1 && type !== 5) return nal;
  const rbsp = unescapeRbsp(nal.subarray(1));
  const reader = new BitReader(rbsp);
  reader.readUe();
  reader.readUe();
  reader.readUe();
  reader.readBits(log2MaxFrameNum);
  if (type === 5) reader.readUe();
  const writer = new BitWriter();
  writer.writeRange(rbsp, 0, reader.bit);
  writer.writeBits(pocLsb, 4);
  writer.writeRange(rbsp, reader.bit, rbsp.byteLength * 8);
  return Uint8Array.from([nal[0], ...escapeRbsp(writer.bytes())]);
}

function convert(inputPath, outputPath) {
  const bytes = new Uint8Array(readFileSync(inputPath));
  const parsed = parseMp4(bytes);
  const track = parsed.videoTrack;
  const config = parseAvcConfig(bytes, track.avcC);
  const rewritten = replaceSpsWithPocType0(config.sps[0]);
  if (rewritten.originalPocType !== 2) throw new Error(`${inputPath} does not use pic_order_cnt_type 2`);
  const nalsBySample = new Map();
  for (const nal of extractNals(bytes, track)) {
    const list = nalsBySample.get(nal.sampleIndex) ?? [];
    list.push(nal);
    nalsBySample.set(nal.sampleIndex, list);
  }
  const keySamples = new Set([...nalsBySample].filter(([, nals]) => nals.some(nal => nal.type === 5)).map(([index]) => index));
  const chunks = track.samples.map(sample => {
    const parts = [];
    for (const nal of nalsBySample.get(sample.index) ?? []) {
      const data = patchSlicePoc(nal.data, 4, sample.index % 16);
      parts.push(writeLengthPrefix(data.byteLength, track.lengthSize), data);
    }
    const length = parts.reduce((sum, part) => sum + part.byteLength, 0);
    const data = new Uint8Array(length);
    let offset = 0;
    for (const part of parts) {
      data.set(part, offset);
      offset += part.byteLength;
    }
    return {data, key: keySamples.has(sample.index)};
  });
  const description = replaceSps(config.raw, rewritten.nal);
  const muxed = buildNormalizedMp4({chunks, description, width: track.width, height: track.height});
  writeFileSync(outputPath, muxed.bytes);
}

convert(process.argv[2], process.argv[3]);
