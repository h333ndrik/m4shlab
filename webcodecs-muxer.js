import { makeBox, fullBox, makeChunkOffset, makeStsc, makeStss, makeStsz, makeStts, u32 } from './merge.js';

const TIMESCALE = 15360;
const SAMPLE_DURATION = 512;
const MOVIE_TIMESCALE = 1000;

function asciiBytes(value) {
  const output = new Uint8Array(value.length);
  for (let i = 0; i < value.length; i += 1) output[i] = value.charCodeAt(i);
  return output;
}

function u16(value) {
  const output = new Uint8Array(2);
  new DataView(output.buffer).setUint16(0, value);
  return output;
}

function fixed16(value) {
  return u32(Math.round(value * 65536));
}

function matrix() {
  const output = new Uint8Array(36);
  const view = new DataView(output.buffer);
  view.setUint32(0, 0x00010000);
  view.setUint32(16, 0x00010000);
  view.setUint32(32, 0x40000000);
  return output;
}

function makeMvhd(duration) {
  return fullBox('mvhd', 0, 0, [
    u32(0), u32(0), u32(MOVIE_TIMESCALE), u32(duration),
    u32(0x00010000), u16(0x0100), u16(0), new Uint8Array(8), matrix(),
    new Uint8Array(24), u32(2),
  ]);
}

function makeTkhd(duration, width, height) {
  return fullBox('tkhd', 0, 3, [
    u32(0), u32(0), u32(1), u32(0), u32(duration),
    new Uint8Array(8), u16(0), u16(0), u16(0), u16(0), matrix(),
    fixed16(width), fixed16(height),
  ]);
}

function makeMdhd(duration) {
  return fullBox('mdhd', 0, 0, [
    u32(0), u32(0), u32(TIMESCALE), u32(duration), u16(0x55c4), u16(0),
  ]);
}

function makeHdlr() {
  return fullBox('hdlr', 0, 0, [u32(0), asciiBytes('vide'), new Uint8Array(12), asciiBytes('VideoHandler\u0000')]);
}

function makeVmhd() {
  return fullBox('vmhd', 0, 1, [u16(0), u16(0), u16(0), u16(0)]);
}

function makeDinf() {
  const url = fullBox('url ', 0, 1);
  const dref = fullBox('dref', 0, 0, [u32(1), url]);
  return makeBox('dinf', [dref]);
}

function makeAvc1(description, width, height) {
  const header = new Uint8Array(78);
  const view = new DataView(header.buffer);
  view.setUint16(6, 1);
  view.setUint16(24, width);
  view.setUint16(26, height);
  view.setUint32(28, 0x00480000);
  view.setUint32(32, 0x00480000);
  view.setUint16(40, 1);
  header[42] = 0;
  view.setUint16(74, 0x0018);
  view.setUint16(76, 0xffff);
  return makeBox('avc1', [header, makeBox('avcC', [description])]);
}

function makeStbl(chunks, description, width, height, chunkOffset, use64, keyframes) {
  const sizes = chunks.map(chunk => chunk.data.byteLength);
  const durations = chunks.map(() => SAMPLE_DURATION);
  return makeBox('stbl', [
    fullBox('stsd', 0, 0, [u32(1), makeAvc1(description, width, height)]),
    makeStts(durations),
    makeStss(keyframes),
    makeStsc(chunks.length),
    makeStsz(sizes),
    makeChunkOffset(chunkOffset, use64),
  ]);
}

function buildMoov(chunks, description, width, height, chunkOffset, use64, keyframes, duration) {
  const stbl = makeStbl(chunks, description, width, height, chunkOffset, use64, keyframes);
  const minf = makeBox('minf', [makeVmhd(), makeDinf(), stbl]);
  const mdia = makeBox('mdia', [makeMdhd(duration), makeHdlr(), minf]);
  const trak = makeBox('trak', [makeTkhd(Math.round(duration * MOVIE_TIMESCALE / TIMESCALE), width, height), mdia]);
  return makeBox('moov', [makeMvhd(Math.round(duration * MOVIE_TIMESCALE / TIMESCALE)), trak]);
}

export function chooseNormalizationTarget(...clips) {
  const width = Math.max(...clips.map(clip => clip.width || 0), 2);
  const height = Math.max(...clips.map(clip => clip.height || 0), 2);
  return {
    width: Math.floor(width / 2) * 2,
    height: Math.floor(height / 2) * 2,
  };
}

export function buildNormalizedMp4({chunks, description, width, height, timescale = TIMESCALE}) {
  if (!Array.isArray(chunks) || chunks.length === 0) throw new Error('Normalized MP4 requires at least one encoded chunk');
  if (!(description instanceof Uint8Array) || description.byteLength === 0) throw new Error('Normalized MP4 requires an avcC decoder description');
  if (timescale !== TIMESCALE) throw new Error(`Unsupported normalized timescale ${timescale}`);
  const evenWidth = Math.floor(width / 2) * 2;
  const evenHeight = Math.floor(height / 2) * 2;
  if (evenWidth < 2 || evenHeight < 2) throw new Error('Normalized dimensions must be at least 2×2');
  for (const chunk of chunks) {
    if (!(chunk.data instanceof Uint8Array) || chunk.data.byteLength === 0) throw new Error('Normalized chunks must contain data');
  }
  const keyframes = chunks.flatMap((chunk, index) => chunk.key ? [index + 1] : []);
  if (keyframes[0] !== 1) throw new Error('Normalized video must begin with a key chunk');

  const ftyp = makeBox('ftyp', [asciiBytes('isom'), u32(512), asciiBytes('isom'), asciiBytes('iso2'), asciiBytes('avc1'), asciiBytes('mp41')]);
  const mdat = makeBox('mdat', chunks.map(chunk => chunk.data));
  const mdatHeaderSize = mdat.byteLength - chunks.reduce((total, chunk) => total + chunk.data.byteLength, 0);
  const duration = chunks.length * SAMPLE_DURATION;
  let chunkOffset = 0;
  let use64 = false;
  let moov = null;
  for (let attempt = 0; attempt < 6; attempt += 1) {
    moov = buildMoov(chunks, description, evenWidth, evenHeight, chunkOffset, use64, keyframes, duration);
    const predicted = ftyp.byteLength + moov.byteLength + mdatHeaderSize;
    const predictedUse64 = predicted > 0xffffffff;
    if (predicted === chunkOffset && predictedUse64 === use64) break;
    chunkOffset = predicted;
    use64 = predictedUse64;
  }
  moov = buildMoov(chunks, description, evenWidth, evenHeight, chunkOffset, use64, keyframes, duration);
  const parts = [ftyp, moov, mdat];
  const length = parts.reduce((total, part) => total + part.byteLength, 0);
  const output = new Uint8Array(length);
  let offset = 0;
  for (const part of parts) {
    output.set(part, offset);
    offset += part.byteLength;
  }
  return {
    bytes: output,
    report: {
      width: evenWidth,
      height: evenHeight,
      timescale,
      samples: chunks.length,
      durationUnits: duration,
      durationSeconds: duration / timescale,
      keyframes,
      mdatPayloadBytes: chunks.reduce((total, chunk) => total + chunk.data.byteLength, 0),
      chunks,
      description,
    },
  };
}
