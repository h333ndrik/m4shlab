import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { childBoxes, parseBoxes, parseMp4 } from '../parser/mp4.js';
import { extractNals } from '../parser/nal.js';
import { HEVC_IRAP_MAX, HEVC_IRAP_MIN, extractHevcNals, parseHevcConfig } from '../parser/hevc.js';
import { moshH264 } from '../mosh.js';
import { CompatibilityError, appendCutH264, checkCompatibility, mergeEffectH264, mergeMoshH264, mergeSequenceH264, parseAvcConfig } from '../merge.js';
import { buildNormalizedMp4, chooseNormalizationTarget } from '../webcodecs-muxer.js';
import { MAX_TARGET_LONG_SIDE, capNormalizationDimensions } from '../conversion-settings.js';
import { parseSps } from '../parser/sps.js';
import { ValueError, frameRateForTrack } from '../classic-mosh.js';
import { assembleAudioTimeline, buildAdts, retimeMuxedAudio, RuntimeError, samplesPerFrame, wavBytes } from '../audio.js';
import { SpeedValueError, atempoChain, atempoFilter, normalizeSpeed, speedFramePlan } from '../speed.js';
import { RANDOM_METHODS, RandomizeError, canRandomize, randomizeTransition, validateRandomTransition } from '../randomize.js';

const projectRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const fixturePath = join(projectRoot, 'testmedia', 'synthetic-h264.mp4');
const multiSliceIdrPath = join(projectRoot, 'testmedia', 'synthetic-multislice-idr.mp4');
const multiSliceMoshPath = join(projectRoot, 'testmedia', 'synthetic-multislice-mosh-test-output.mp4');
const modifiedPath = join(projectRoot, 'testmedia', 'synthetic-mosh-test-output.mp4');
const tierOneFixtures = {
  quicktime: join(projectRoot, 'testmedia', 'synthetic-quicktime.mov'),
  hevc: join(projectRoot, 'testmedia', 'synthetic-hevc.mov'),
  hevcSmall: join(projectRoot, 'testmedia', 'synthetic-hevc-small.mov'),
  fragmented: join(projectRoot, 'testmedia', 'synthetic-fragmented.mp4'),
};
const phaseBFixtures = {
  a: join(projectRoot, 'testmedia', 'synthetic-b-a.mp4'),
  b: join(projectRoot, 'testmedia', 'synthetic-b-b.mp4'),
  mismatch: join(projectRoot, 'testmedia', 'synthetic-b-mismatch.mp4'),
  timescale: join(projectRoot, 'testmedia', 'synthetic-b-timescale.mp4'),
};
const audioFixtures = {
  a: join(projectRoot, 'testmedia', 'synthetic-audio-a.mp4'),
  b: join(projectRoot, 'testmedia', 'synthetic-audio-b.mp4'),
  silentB: join(projectRoot, 'testmedia', 'synthetic-audio-silent-b.mp4'),
};
const multiGopFixtures = {
  a: join(projectRoot, 'testmedia', 'synthetic-multigop-a.mp4'),
  b: join(projectRoot, 'testmedia', 'synthetic-multigop-b.mp4'),
  poc0A: join(projectRoot, 'testmedia', 'synthetic-multigop-poc0-a.mp4'),
  poc0B: join(projectRoot, 'testmedia', 'synthetic-multigop-poc0-b.mp4'),
  poc0C: join(projectRoot, 'testmedia', 'synthetic-multigop-poc0-c.mp4'),
};
const mergedPath = join(projectRoot, 'testmedia', 'synthetic-b-merged-test-output.mp4');
const multiGopMergedPath = join(projectRoot, 'testmedia', 'synthetic-multigop-merged-test-output.mp4');
const multiGopPoc0MergedPath = join(projectRoot, 'testmedia', 'synthetic-multigop-poc0-merged-test-output.mp4');
const meltOutputPath = join(projectRoot, 'testmedia', 'synthetic-melt-test-output.mp4');
const loopOutputPath = join(projectRoot, 'testmedia', 'synthetic-loop-test-output.mp4');
const poc0MeltOutputPath = join(projectRoot, 'testmedia', 'synthetic-poc0-melt-test-output.mp4');
const meltDurationOutputPath = join(projectRoot, 'testmedia', 'synthetic-melt-duration-test-output.mp4');
const meltRestoreOutputPath = join(projectRoot, 'testmedia', 'synthetic-melt-restore-test-output.mp4');
const meltGentleOutputPath = join(projectRoot, 'testmedia', 'synthetic-melt-gentle-test-output.mp4');
const loopDurationOutputPath = join(projectRoot, 'testmedia', 'synthetic-loop-duration-test-output.mp4');
const resetPulseOutputPath = join(projectRoot, 'testmedia', 'synthetic-reset-pulse-test-output.mp4');
const resetPulsePoc0OutputPath = join(projectRoot, 'testmedia', 'synthetic-reset-pulse-poc0-test-output.mp4');
const resetPulseRestoreOutputPath = join(projectRoot, 'testmedia', 'synthetic-reset-pulse-restore-test-output.mp4');
const resetPulseCutOutputPath = join(projectRoot, 'testmedia', 'synthetic-reset-pulse-cut-test-output.mp4');
const resetPulseMoshOutputPath = join(projectRoot, 'testmedia', 'synthetic-reset-pulse-mosh-test-output.mp4');
const sequenceMoshPath = join(projectRoot, 'testmedia', 'synthetic-sequence-mosh-test-output.mp4');
const sequenceMixedPath = join(projectRoot, 'testmedia', 'synthetic-sequence-mixed-test-output.mp4');
const normalizedMuxPath = join(projectRoot, 'testmedia', 'synthetic-webcodecs-mux-output.mp4');
const phaseARestorePath = join(projectRoot, 'testmedia', 'synthetic-phase-a-restore-output.mp4');
const phaseAContinuePath = join(projectRoot, 'testmedia', 'synthetic-phase-a-continue-output.mp4');
const phaseBRestorePath = join(projectRoot, 'testmedia', 'synthetic-phase-b-restore-output.mp4');

function command(program, args, label) {
  const result = spawnSync(program, args, { cwd: projectRoot, encoding: 'utf8' });
  if (result.error) throw new Error(`${label} could not start: ${result.error.message}`);
  if (result.status !== 0) {
    throw new Error(`${label} failed (${result.status}):\n${result.stderr || result.stdout}`);
  }
  return result;
}

function pass(message) {
  console.log(`PASS ${message}`);
}

function unescapeRbspPayload(nalData) {
  const input = nalData.subarray(1);
  const output = new Uint8Array(input.byteLength);
  let length = 0;
  let zeros = 0;
  for (const value of input) {
    if (zeros >= 2 && value === 3) {
      zeros = 0;
      continue;
    }
    output[length++] = value;
    zeros = value === 0 ? zeros + 1 : 0;
  }
  return output.subarray(0, length);
}

function readBitAt(bytes, bit) {
  return (bytes[bit >> 3] >> (7 - (bit & 7))) & 1;
}

function skipUnsignedExpGolomb(bytes, state) {
  let zeros = 0;
  while (readBitAt(bytes, state.bit) === 0) {
    zeros += 1;
    state.bit += 1;
    if (zeros > 31) throw new Error('Invalid Exp-Golomb value in test slice header');
  }
  state.bit += 1 + zeros;
}

function readFixedBitsTest(bytes, state, count) {
  let value = 0;
  for (let index = 0; index < count; index += 1) {
    value = value * 2 + readBitAt(bytes, state.bit);
    state.bit += 1;
  }
  return value;
}

function readUnsignedExpGolombTest(bytes, state) {
  let zeros = 0;
  while (readBitAt(bytes, state.bit) === 0) {
    zeros += 1;
    state.bit += 1;
    if (zeros > 31) throw new Error('Invalid Exp-Golomb value in test slice header');
  }
  state.bit += 1;
  return (2 ** zeros) - 1 + (zeros === 0 ? 0 : readFixedBitsTest(bytes, state, zeros));
}

function readSliceCounters(nalData, sps) {
  const rbsp = unescapeRbspPayload(nalData);
  const state = {bit: 0};
  readUnsignedExpGolombTest(rbsp, state);
  readUnsignedExpGolombTest(rbsp, state);
  readUnsignedExpGolombTest(rbsp, state);
  const frameNumber = readFixedBitsTest(rbsp, state, sps.log2MaxFrameNum);
  if ((nalData[0] & 0x1f) === 5) readUnsignedExpGolombTest(rbsp, state);
  const picOrderCntLsb = sps.picOrderCntType === 0
    ? readFixedBitsTest(rbsp, state, sps.log2MaxPicOrderCntLsb)
    : null;
  return {frameNumber, picOrderCntLsb};
}

function slicePatchBitRange(nalData, sps) {
  const rbsp = unescapeRbspPayload(nalData);
  const state = {bit: 0};
  skipUnsignedExpGolomb(rbsp, state);
  skipUnsignedExpGolomb(rbsp, state);
  skipUnsignedExpGolomb(rbsp, state);
  const start = state.bit;
  const end = start + sps.log2MaxFrameNum + (sps.picOrderCntType === 0 ? sps.log2MaxPicOrderCntLsb : 0);
  return {rbsp, start, end};
}

function assertEffectNalPayloads(outputNals, aNalCount, sourceNals, scheduledSources, sps, label, options = {}) {
  const expected = scheduledSources.flatMap(sampleIndex => sourceNals
    .filter(nal => nal.sampleIndex === sampleIndex)
    .filter(nal => options.preserveAllSampleNals || nal.type === 5 || ![6, 7, 8].includes(nal.type)));
  const actual = outputNals.slice(aNalCount);
  assert.equal(actual.length, expected.length, `${label} NAL count`);
  assert.deepEqual(actual.map(nal => nal.type), expected.map(nal => nal.type), `${label} NAL order`);
  let headerBitsChanged = 0;
  for (let i = 0; i < expected.length; i += 1) {
    if (expected[i].type !== 1) {
      assert.deepEqual(actual[i].data, expected[i].data, `${label} non-slice NAL ${i} changed`);
      continue;
    }
    const source = slicePatchBitRange(expected[i].data, sps);
    const patched = slicePatchBitRange(actual[i].data, sps);
    assert.equal(patched.rbsp.byteLength, source.rbsp.byteLength, `${label} slice ${i} RBSP length changed`);
    for (let bit = 0; bit < source.rbsp.byteLength * 8; bit += 1) {
      const differs = readBitAt(source.rbsp, bit) !== readBitAt(patched.rbsp, bit);
      if (!differs) continue;
      assert.ok(bit >= source.start && bit < source.end, `${label} slice ${i} changed payload bit ${bit} outside frame_num/POC fields`);
      headerBitsChanged += 1;
    }
  }
  assert.ok(headerBitsChanged > 0, `${label} did not renumber any slice headers`);
}

const requiredFixtures = [fixturePath, multiSliceIdrPath, ...Object.values(tierOneFixtures), ...Object.values(phaseBFixtures), ...Object.values(audioFixtures), ...Object.values(multiGopFixtures)];
if (requiredFixtures.some(path => !existsSync(path))) {
  console.log('One or more fixtures are missing; generating local test media with ffmpeg.');
  command('bash', ['testmedia/generate.sh'], 'fixture generation');
}

const input = new Uint8Array(readFileSync(fixturePath));
const parsed = parseMp4(input);
const sourceNals = extractNals(input, parsed.videoTrack);
const idrSampleIndexes = [...new Set(sourceNals.filter((nal) => nal.type === 5).map((nal) => nal.sampleIndex))];

assert.equal(parsed.videoTrack.handler, 'vide');
assert.equal(parsed.videoTrack.lengthSize, 4);
assert.equal(parsed.videoTrack.samples.length, 75);
assert.deepEqual(idrSampleIndexes, [0, 25, 50]);
assert.deepEqual(sourceNals.slice(0, 2).map((nal) => nal.type), [6, 5]);
assert.deepEqual(sourceNals.filter((nal) => nal.type === 5).map((nal) => nal.sampleIndex), [0, 25, 50]);
pass('synthetic fixture has the expected 75 samples and fixed 25-frame GOPs with IDRs at samples 0, 25, and 50');

const result = moshH264(input, parsed);
assert.equal(result.moshable, true);
assert.equal(result.report.boundary.sampleIndex, 25);
assert.equal(result.report.removedIdrCount, 2);
assert.equal(result.report.preservedIdrCount, 1);
assert.deepEqual(result.report.idrUnits.map((unit) => unit.sampleIndex), [0, 25, 50]);
assert.deepEqual(result.report.removedByteRanges.map((range) => range.sampleIndex), [25, 50]);
pass('mosh removes exactly the post-boundary IDR units in sample order (samples 25 and 50)');

const modified = parseMp4(result.output);
const modifiedNals = extractNals(result.output, modified.videoTrack);
const boundary = result.report.boundary.fileOffset;
const expectedNals = sourceNals.filter((nal) => nal.type !== 5 || nal.start < boundary);

assert.equal(modifiedNals.length, expectedNals.length);
assert.deepEqual(modifiedNals.map((nal) => nal.type), expectedNals.map((nal) => nal.type));
for (let i = 0; i < expectedNals.length; i += 1) {
  assert.equal(modifiedNals[i].data.byteLength, expectedNals[i].data.byteLength, `NAL ${i} length changed`);
  assert.deepEqual(modifiedNals[i].data, expectedNals[i].data, `NAL ${i} bytes changed`);
}
pass(`all ${modifiedNals.length} retained NAL units are byte-identical and in their original order`);

function boxData(bytes, box) {
  return bytes.subarray(box.payloadStart, box.payloadEnd);
}

assert.deepEqual(boxData(result.output, modified.videoTrack.avcC), boxData(input, parsed.videoTrack.avcC));
const sourceSpsPps = sourceNals.filter((nal) => nal.type === 7 || nal.type === 8).map((nal) => nal.data);
const modifiedSpsPps = modifiedNals.filter((nal) => nal.type === 7 || nal.type === 8).map((nal) => nal.data);
assert.deepEqual(modifiedSpsPps, sourceSpsPps);
pass('avcC configuration and every in-band SPS/PPS unit are preserved');

const removedBytes = result.report.removedByteRanges.reduce((total, range) => total + range.length, 0);
assert.equal(result.report.removedBytes, removedBytes);
assert.equal(result.output.byteLength, input.byteLength - removedBytes);
assert.equal(result.report.outputBytes, result.output.byteLength);
pass(`output shrinks by exactly the removed unit bytes (${removedBytes} bytes)`);

assert.equal(result.cut.byteLength, input.byteLength);
assert.deepEqual(result.cut, input);
pass('untouched Cut control copy is byte-identical to the source');

writeFileSync(modifiedPath, result.output);
const ffprobe = command('ffprobe', [
  '-v', 'error',
  '-select_streams', 'v:0',
  '-count_frames',
  '-show_entries', 'stream=codec_name,width,height,nb_read_frames',
  '-of', 'default=noprint_wrappers=1',
  modifiedPath,
], 'modified-file decode probe');
assert.match(ffprobe.stdout, /codec_name=h264/);
const decodedFrames = Number(/nb_read_frames=(\d+)/.exec(ffprobe.stdout)?.[1] ?? 0);
assert.ok(decodedFrames > 0, 'Modified file must yield at least one decoded frame');
pass(`export decodes with ffprobe: H.264 ${parsed.videoTrack.width}x${parsed.videoTrack.height}, ${decodedFrames} decoded frames`);

const truncated = result.output.subarray(0, Math.floor(result.output.byteLength / 2));
assert.throws(() => parseMp4(truncated), /extends past|outside|Truncated|Invalid|ended/);
pass('a deliberately truncated file is rejected instead of being presented as a valid mosh');

const multiSliceInput = new Uint8Array(readFileSync(multiSliceIdrPath));
const multiSliceParsed = parseMp4(multiSliceInput);
const multiSliceNals = extractNals(multiSliceInput, multiSliceParsed.videoTrack);
const multiSliceIdrSamples = [...new Set(multiSliceNals.filter(nal => nal.type === 5).map(nal => nal.sampleIndex))];
assert.equal(multiSliceParsed.videoTrack.samples.length, 75);
assert.deepEqual(multiSliceIdrSamples, [0, 25, 50]);
assert.equal(multiSliceNals.filter(nal => nal.sampleIndex === 0 && nal.type === 5).length, 2);
assert.equal(multiSliceNals.filter(nal => nal.sampleIndex === 25 && nal.type === 5).length, 2);
const multiSliceMosh = moshH264(multiSliceInput, multiSliceParsed);
assert.equal(multiSliceMosh.moshable, true);
assert.equal(multiSliceMosh.report.boundary.sampleIndex, 25);
assert.equal(multiSliceMosh.report.boundary.nalIndex, 0);
assert.equal(multiSliceMosh.report.removedIdrCount, 4);
assert.equal(multiSliceMosh.report.removedIdrSampleCount, 2);
assert.equal(multiSliceMosh.report.preservedIdrCount, 2);
assert.equal(multiSliceMosh.report.expectedDecodedFrames, 73);
const multiSliceMoshParsed = parseMp4(multiSliceMosh.output);
const multiSliceMoshNals = extractNals(multiSliceMosh.output, multiSliceMoshParsed.videoTrack);
const initialAccessUnit = multiSliceNals.filter(nal => nal.sampleIndex === 0);
const retainedInitialAccessUnit = multiSliceMoshNals.filter(nal => nal.sampleIndex === 0);
assert.deepEqual(retainedInitialAccessUnit.map(nal => nal.type), initialAccessUnit.map(nal => nal.type));
for (let i = 0; i < initialAccessUnit.length; i += 1) {
  assert.deepEqual(retainedInitialAccessUnit[i].data, initialAccessUnit[i].data, `Initial access-unit NAL ${i} changed`);
}
assert.equal(retainedInitialAccessUnit.filter(nal => nal.type === 5).length, 2);
assert.ok(multiSliceMoshNals.every(nal => nal.type !== 5 || nal.sampleIndex === 0));
assert.equal(multiSliceMoshNals.length, multiSliceNals.length - 4);
writeFileSync(multiSliceMoshPath, multiSliceMosh.output);
const multiSliceProbe = command('ffprobe', [
  '-v', 'error', '-select_streams', 'v:0', '-count_frames',
  '-show_entries', 'stream=codec_name,width,height,nb_read_frames',
  '-of', 'default=noprint_wrappers=1', multiSliceMoshPath,
], 'multi-slice Phase A decode probe');
const multiSliceDecodedFrames = Number(/nb_read_frames=(\d+)/.exec(multiSliceProbe.stdout)?.[1] ?? 0);
assert.equal(multiSliceDecodedFrames, 73);
command('ffmpeg', ['-v', 'error', '-i', multiSliceMoshPath, '-f', 'null', '-'], 'multi-slice Phase A strict decode');
pass(`multi-slice Phase A keeps both initial IDR slices, starts at sample 25, removes all four boundary/GOP slices, and decodes ${multiSliceDecodedFrames}/73 retained frames`);

const multiSliceMergeBInput = new Uint8Array(readFileSync(phaseBFixtures.b));
const multiSliceMergeBParsed = parseMp4(multiSliceMergeBInput);
const multiSliceMerge = await mergeMoshH264(multiSliceInput, multiSliceMergeBInput, multiSliceParsed, multiSliceMergeBParsed);
assert.equal(multiSliceMerge.report.leadingIdrNalCount, 2);
assert.equal(multiSliceMerge.report.leadingIdrSampleCount, 1);
assert.equal(multiSliceMerge.report.startsWithSingleIdr, true);
pass('merge leading-IDR reporting treats a multi-slice access unit as one leading IDR sample');


const quickTimeInput = new Uint8Array(readFileSync(tierOneFixtures.quicktime));
const hevcInput = new Uint8Array(readFileSync(tierOneFixtures.hevc));
const fragmentedInput = new Uint8Array(readFileSync(tierOneFixtures.fragmented));

const quickTimeParsed = parseMp4(quickTimeInput);
const quickTimeNals = extractNals(quickTimeInput, quickTimeParsed.videoTrack);
assert.ok(quickTimeParsed.boxes.some(box => box.type === 'wide'), 'QuickTime fixture should exercise a wide placeholder box');
assert.equal(quickTimeParsed.videoTrack.stsd.entries[0].type, 'avc1');
assert.equal(quickTimeParsed.videoTrack.samples.length, 25);
assert.equal(quickTimeNals.length, 26);
assert.deepEqual(quickTimeNals.slice(0, 2).map(nal => nal.type), [6, 5]);
pass('QuickTime MOV with H.264 and a wide placeholder parses 25 samples / 26 NAL units');

const sizeZeroInput = new Uint8Array(input);
const sourceBoxes = parseBoxes(sizeZeroInput, 0, sizeZeroInput.byteLength, {allowSizeZero: true});
const sourceMdat = sourceBoxes.find(box => box.type === 'mdat');
assert.equal(sourceMdat.end, sizeZeroInput.byteLength, 'Size-0 test requires mdat at EOF');
new DataView(sizeZeroInput.buffer).setUint32(sourceMdat.start, 0);
const sizeZeroParsed = parseMp4(sizeZeroInput);
assert.equal(sizeZeroParsed.videoTrack.samples.length, 75);
assert.equal(sizeZeroParsed.mdatRanges[0].size, sourceMdat.size);
pass('top-level size-0 mdat extends to EOF and parses all 75 samples');

const normalizationTarget = chooseNormalizationTarget({width: 320, height: 240}, {width: 256, height: 240});
assert.deepEqual(normalizationTarget, {width: 320, height: 240});
assert.deepEqual(
  chooseNormalizationTarget({width: 321, height: 241}, {width: 200, height: 100}),
  {width: 320, height: 240},
  'The common normalization target must be even and shared by both clips',
);
assert.deepEqual(
  chooseNormalizationTarget({width: 1440, height: 1920}, {width: 768, height: 1024}),
  {width: 540, height: 720},
);
assert.equal(Math.max(...Object.values(chooseNormalizationTarget({width: 3840, height: 2160}))), MAX_TARGET_LONG_SIDE);
assert.deepEqual(capNormalizationDimensions(1000, 500), {width: 720, height: 360});
assert.deepEqual(capNormalizationDimensions(320, 240), {width: 320, height: 240});
pass(`normalization resolution logic selects one identical even target and caps the long side at ${MAX_TARGET_LONG_SIDE}px`);

const muxDescription = input.subarray(parsed.videoTrack.avcC.payloadStart, parsed.videoTrack.avcC.payloadEnd);
const muxChunks = parsed.videoTrack.samples.slice(0, 8).map((sample, index) => ({
  data: input.slice(sample.offset, sample.offset + sample.size),
  key: index === 0,
}));
const normalizedMux = buildNormalizedMp4({chunks: muxChunks, description: muxDescription, width: 320, height: 240});
writeFileSync(normalizedMuxPath, normalizedMux.bytes);
const normalizedMuxParsed = parseMp4(normalizedMux.bytes);
const normalizedMuxTrack = normalizedMuxParsed.videoTrack;
const normalizedStszSum = normalizedMuxTrack.sampleSizes.sizes.reduce((total, value) => total + value, 0);
const normalizedMdatLength = normalizedMuxParsed.mdatRanges[0].payloadEnd - normalizedMuxParsed.mdatRanges[0].payloadStart;
const normalizedSttsSum = normalizedMuxTrack.stts.durations.reduce((total, value) => total + value, 0);
assert.equal(normalizedMuxTrack.samples.length, muxChunks.length);
assert.equal(normalizedStszSum, normalizedMdatLength);
assert.equal(normalizedStszSum, normalizedMux.report.mdatPayloadBytes);
assert.ok(normalizedMuxTrack.samples.every((sample, index, samples) => index === 0 || sample.offset > samples[index - 1].offset));
assert.deepEqual(Array.from(normalizedMuxTrack.sampleSizes.sizes), muxChunks.map(chunk => chunk.data.byteLength));
assert.equal(normalizedSttsSum, normalizedMuxTrack.mdhd.duration);
assert.equal(normalizedSttsSum, normalizedMux.report.durationUnits);
assert.equal(normalizedMuxTrack.stsc.length, 1);
assert.equal(normalizedMuxTrack.stsc[0].samplesPerChunk, muxChunks.length);
const normalizedTrak = childBoxes(normalizedMux.bytes, normalizedMuxTrack.trak);
const normalizedMdia = normalizedTrak.find(box => box.type === 'mdia');
const normalizedMinf = childBoxes(normalizedMux.bytes, normalizedMdia).find(box => box.type === 'minf');
const normalizedStbl = childBoxes(normalizedMux.bytes, normalizedMinf).find(box => box.type === 'stbl');
const normalizedStss = childBoxes(normalizedMux.bytes, normalizedStbl).find(box => box.type === 'stss');
const normalizedStssView = new DataView(normalizedMux.bytes.buffer, normalizedMux.bytes.byteOffset, normalizedMux.bytes.byteLength);
assert.equal(normalizedStssView.getUint32(normalizedStss.payloadStart + 4), 1);
assert.equal(normalizedStssView.getUint32(normalizedStss.payloadStart + 8), 1);
assert.throws(() => buildNormalizedMp4({
  chunks: muxChunks.map(chunk => ({...chunk, key: false})),
  description: muxDescription,
  width: 320,
  height: 240,
}), /must begin with a key chunk/);
pass(`WebCodecs muxer emits ${muxChunks.length} samples with matching stsz/mdat (${normalizedStszSum} B), monotonic offsets, one stss entry, and ${normalizedSttsSum} time units`);

function patchChunkOffsets(bytes, chunkOffsets, delta) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (let i = 0; i < chunkOffsets.values.length; i += 1) {
    view.setUint32(chunkOffsets.entryOffset(i), chunkOffsets.values[i] + delta);
  }
}

const mdatForWide = parsed.mdatRanges[0];
const wideBytes = new Uint8Array(input.byteLength + 8);
wideBytes.set(input.subarray(0, mdatForWide.start), 0);
new DataView(wideBytes.buffer).setUint32(mdatForWide.start, 8);
for (let i = 0; i < 4; i += 1) wideBytes[mdatForWide.start + 4 + i] = 'wide'.charCodeAt(i);
wideBytes.set(input.subarray(mdatForWide.start), mdatForWide.start + 8);
patchChunkOffsets(wideBytes, parsed.videoTrack.chunkOffsets, 8);
const wideParsed = parseMp4(wideBytes);
assert.ok(wideParsed.boxes.some(box => box.type === 'wide'));
assert.equal(wideParsed.videoTrack.samples.length, 75);
pass('a standalone wide placeholder box is skipped without disturbing sample offsets');

const mdatForExtended = parsed.mdatRanges[0];
const extendedInput = new Uint8Array(input.byteLength + 8);
extendedInput.set(input.subarray(0, mdatForExtended.start + 8), 0);
const extendedView = new DataView(extendedInput.buffer);
extendedView.setUint32(mdatForExtended.start, 1);
extendedView.setBigUint64(mdatForExtended.start + 8, BigInt(mdatForExtended.size + 8));
extendedInput.set(input.subarray(mdatForExtended.payloadStart), mdatForExtended.start + 16);
patchChunkOffsets(extendedInput, parsed.videoTrack.chunkOffsets, 8);
const extendedParsed = parseMp4(extendedInput);
assert.equal(extendedParsed.mdatRanges[0].extended, true);
assert.equal(extendedParsed.videoTrack.samples.length, 75);
pass('64-bit mdat heading parses with all 75 sample offsets intact');

assert.throws(
  () => parseMp4(hevcInput),
  error => error.code === 'UNSUPPORTED_CODEC' && error.message === 'This file contains HEVC (hvc1). Convert to H.264 or use convert-on-load.',
);
pass('HEVC input reports the actionable codec error instead of a box-walk error');

const hevcParsed = parseMp4(hevcInput, {allowHevc: true});
const hevcTrack = hevcParsed.videoTrack;
assert.equal(hevcTrack.codecFamily, 'hevc');
assert.equal(hevcTrack.codecType, 'hvc1');
assert.equal(hevcTrack.samples.length, 25);
assert.equal(hevcTrack.width, 320);
assert.equal(hevcTrack.height, 240);
const hevcConfig = parseHevcConfig(hevcInput, hevcTrack.hvcC, hevcTrack.codecType);
assert.equal(hevcConfig.lengthSize, 4);
assert.equal(hevcConfig.profileIdc, 1);
assert.equal(hevcConfig.levelIdc, 60);
assert.match(hevcConfig.codecString, /^hvc1\.1\.6\.L60(?:\.90)?$/);
assert.ok(hevcConfig.arrays.length > 0);
const hevcNals = extractHevcNals(hevcInput, hevcTrack);
assert.ok(hevcNals.length >= 25);
assert.ok(hevcNals.every(nal => Number.isInteger(nal.unitType) && nal.unitType >= 0 && nal.unitType <= 63));
assert.ok(hevcNals.some(nal => nal.sampleIndex === 0 && nal.unitType >= HEVC_IRAP_MIN && nal.unitType <= HEVC_IRAP_MAX));
pass(`HEVC hvcC and ${hevcNals.length} length-prefixed NAL units parse behind an explicit option without entering the H.264 NAL parser`);

assert.throws(
  () => parseMp4(fragmentedInput),
  error => error.code === 'FRAGMENTED_MP4' && error.message === 'Fragmented MP4 is not supported; convert to a conventional MP4.',
);
pass('fragmented MP4 reports the actionable fragmentation error');


const phaseAInput = new Uint8Array(readFileSync(phaseBFixtures.a));
const phaseBInput = new Uint8Array(readFileSync(phaseBFixtures.b));
const mismatchInput = new Uint8Array(readFileSync(phaseBFixtures.mismatch));
const timescaleInput = new Uint8Array(readFileSync(phaseBFixtures.timescale));
const phaseAParsed = parseMp4(phaseAInput);
const phaseBParsed = parseMp4(phaseBInput);

const compatible = await checkCompatibility(phaseAInput, phaseBInput, phaseAParsed, phaseBParsed);
assert.equal(compatible.compatible, true);
assert.equal(compatible.spsMatch, true);
assert.equal(compatible.ppsMatch, true);
assert.deepEqual(
  compatible.checks.filter(check => check.required).map(check => check.key),
  ['resolution', 'profile', 'constraints', 'level', 'chroma', 'bitDepth', 'timescale', 'lengthSize', 'ppsPayload', 'aIdrStart', 'bIdrStart', 'bSlices'],
);
assert.ok(compatible.checks.every(check => check.match), 'All required compatibility checks must match for the fixture pair');
pass('Phase B compatibility accepts the matching 320x240 High-profile pair with identical SPS/PPS and timescale');

const mismatch = await checkCompatibility(phaseAInput, mismatchInput);
assert.equal(mismatch.compatible, false);
assert.ok(mismatch.checks.some(check => check.key === 'resolution' && !check.match));
assert.match(mismatch.message, /resolution 320×240 ≠ 256×240/);
assert.match(mismatch.message, /same device\/settings/);
assert.match(mismatch.message, /identical parameters/);
pass('Phase B rejects the resolution mismatch with an actionable compatibility message');

const timescaleMismatch = await checkCompatibility(phaseAInput, timescaleInput);
assert.equal(timescaleMismatch.compatible, false);
assert.ok(timescaleMismatch.checks.some(check => check.key === 'timescale' && !check.match));
assert.match(timescaleMismatch.message, /video timescale 12800 ≠ 25600/);
assert.match(timescaleMismatch.message, /same device\/settings/);
pass('Phase B rejects the mdhd timescale mismatch with an actionable compatibility message');

await assert.rejects(
  () => mergeMoshH264(phaseAInput, mismatchInput),
  error => error instanceof CompatibilityError && /resolution/.test(error.message),
);
pass('Phase B refuses to emit an MP4 for an incompatible pair');

const mergeResult = await mergeMoshH264(phaseAInput, phaseBInput, phaseAParsed, phaseBParsed);
assert.equal(mergeResult.report.startsWithSingleIdr, true);
assert.equal(mergeResult.report.idrCount, 1);
assert.equal(mergeResult.report.bIdrCountRemaining, 0);
assert.equal(mergeResult.report.bSkippedPrefixSamples, 1);
assert.equal(mergeResult.report.bSamplesKept, phaseBParsed.videoTrack.samples.length - 1);
assert.equal(mergeResult.report.mergedSamples, phaseAParsed.videoTrack.samples.length + phaseBParsed.videoTrack.samples.length - 1);
assert.equal(mergeResult.report.audio, 'omitted in Phase B');
pass(`Phase B merge skips B sample 0 and emits ${mergeResult.report.mergedSamples} samples with one leading IDR and no B IDR`);

const phaseANals = extractNals(phaseAInput, phaseAParsed.videoTrack);
const phaseBNals = extractNals(phaseBInput, phaseBParsed.videoTrack);
const firstBIdrSample = phaseBNals.find(nal => nal.type === 5).sampleIndex;
const expectedMergedNals = [
  ...phaseANals,
  ...phaseBNals.filter(nal => nal.sampleIndex > firstBIdrSample && ![5, 6, 7, 8].includes(nal.type)),
];
const mergedParsed = parseMp4(mergeResult.output);
const mergedNals = extractNals(mergeResult.output, mergedParsed.videoTrack);
assert.equal(mergedNals.length, expectedMergedNals.length);
assert.deepEqual(mergedNals.map(nal => nal.type), expectedMergedNals.map(nal => nal.type));
for (let i = 0; i < expectedMergedNals.length; i += 1) {
  assert.deepEqual(mergedNals[i].data, expectedMergedNals[i].data, `Merged NAL ${i} bytes changed`);
}
assert.deepEqual(
  phaseAInput.subarray(phaseAParsed.videoTrack.avcC.payloadStart, phaseAParsed.videoTrack.avcC.payloadEnd),
  mergeResult.output.subarray(mergedParsed.videoTrack.avcC.payloadStart, mergedParsed.videoTrack.avcC.payloadEnd),
  'Merged avcC must remain identical to clip A',
);
pass(`all ${mergedNals.length} retained merge NAL units are byte-identical to their A/B sources and in order; A avcC is preserved`);

const mergedVideo = mergedParsed.videoTrack;
const mdatContentLength = mergedParsed.mdatRanges.reduce((total, box) => total + box.payloadEnd - box.payloadStart, 0);
const stszSum = [...mergedVideo.sampleSizes.sizes].reduce((total, value) => total + value, 0);
assert.equal(stszSum, mdatContentLength);
assert.equal(stszSum, mergeResult.report.mdatPayloadBytes);
assert.equal(mergedVideo.samples.length, mergeResult.report.mergedSamples);
assert.ok(mergedVideo.samples.every((sample, index, samples) => index === 0 || sample.offset > samples[index - 1].offset), 'Sample offsets must be strictly increasing');
assert.equal(mergedVideo.chunkOffsets.values.length, 1);
assert.equal(mergedVideo.chunkOffsets.values[0], mergedParsed.mdatRanges[0].payloadStart);
assert.equal(mergedVideo.stsc.length, 1);
assert.equal(mergedVideo.stsc[0].samplesPerChunk, mergedVideo.samples.length);
assert.equal(mergedVideo.stts.sampleCount, mergedVideo.samples.length);
const sttsDuration = mergedVideo.stts.durations.reduce((total, value) => total + value, 0);
assert.equal(sttsDuration, mergeResult.report.mergedDurationUnits);
assert.equal(mergedVideo.mdhd.duration, sttsDuration);
assert.equal(mergedVideo.tkhd.duration, Math.round(sttsDuration * mergedParsed.mvhd.timescale / mergedVideo.mdhd.timescale));
assert.equal(mergedParsed.mvhd.duration, mergedVideo.tkhd.duration);
assert.equal(mergedVideo.ctts.sampleCount, mergedVideo.samples.length);
pass(`sample tables are consistent: stsz sum ${stszSum} B, monotonic offsets, one chunk, stts sum ${sttsDuration} units`);

assert.equal(mergeResult.cut.byteLength, phaseAInput.byteLength);
assert.deepEqual(mergeResult.cut, phaseAInput);
pass('Phase B Cut control is byte-identical to clip A');

writeFileSync(mergedPath, mergeResult.output);
const mergedProbe = command('ffprobe', [
  '-v', 'error',
  '-select_streams', 'v:0',
  '-count_frames',
  '-show_entries', 'stream=codec_name,width,height,nb_read_frames',
  '-of', 'default=noprint_wrappers=1',
  mergedPath,
], 'merged-file decode probe');
assert.match(mergedProbe.stdout, /codec_name=h264/);
const mergedDecodedFrames = Number(/nb_read_frames=(\d+)/.exec(mergedProbe.stdout)?.[1] ?? 0);
const expectedFrames = phaseAParsed.videoTrack.samples.length + phaseBParsed.videoTrack.samples.length - 1;
assert.equal(mergedDecodedFrames, expectedFrames);
const streamTypes = command('ffprobe', [
  '-v', 'error',
  '-show_entries', 'stream=codec_type',
  '-of', 'default=noprint_wrappers=1:nokey=1',
  mergedPath,
], 'merged stream inventory');
assert.equal(streamTypes.stdout.trim(), 'video');
pass(`merged export decodes as H.264 320x240 with exactly ${expectedFrames} frames and no audio stream`);

const multiGopAInput = new Uint8Array(readFileSync(multiGopFixtures.a));
const multiGopBInput = new Uint8Array(readFileSync(multiGopFixtures.b));
const multiGopAParsed = parseMp4(multiGopAInput);
const multiGopBParsed = parseMp4(multiGopBInput);
const multiGopBNals = extractNals(multiGopBInput, multiGopBParsed.videoTrack);
const multiGopBIdrSamples = [...new Set(multiGopBNals.filter(nal => nal.type === 5).map(nal => nal.sampleIndex))];
assert.equal(multiGopAParsed.videoTrack.samples.length, 25);
assert.equal(multiGopBParsed.videoTrack.samples.length, 75);
assert.deepEqual(multiGopBIdrSamples, [0, 25, 50]);

const multiGopCompatibility = await checkCompatibility(multiGopAInput, multiGopBInput, multiGopAParsed, multiGopBParsed);
assert.equal(multiGopCompatibility.compatible, true);
const multiGopMerge = await mergeMoshH264(multiGopAInput, multiGopBInput, multiGopAParsed, multiGopBParsed);
assert.equal(multiGopMerge.report.bSamplesKept, 74);
assert.equal(multiGopMerge.report.bSkippedEmptySamples, 0);
assert.equal(multiGopMerge.report.bRemovedNals.idr, 1);
assert.equal(multiGopMerge.report.bIdrCountRemaining, 2);
assert.deepEqual(multiGopMerge.report.bIdrSamples, [0, 25, 50]);
assert.equal(multiGopMerge.report.frameAlignment.applied, true);
assert.equal(multiGopMerge.report.frameAlignment.patchedSamples, 24);
assert.equal(multiGopMerge.report.frameAlignment.patchedNals, 24);
assert.match(multiGopMerge.report.frameAlignment.emulationPrevention, /unescaped.*re-escaped/i);
assert.equal(multiGopMerge.report.mergedSamples, multiGopAParsed.videoTrack.samples.length + multiGopBParsed.videoTrack.samples.length - 1);
assert.equal(multiGopMerge.report.startsWithSingleIdr, true);

const multiGopMergedParsed = parseMp4(multiGopMerge.output);
const multiGopMergedNals = extractNals(multiGopMerge.output, multiGopMergedParsed.videoTrack);
const multiGopMergedIdrSamples = [...new Set(multiGopMergedNals.filter(nal => nal.type === 5).map(nal => nal.sampleIndex))];
assert.deepEqual(multiGopMergedIdrSamples, [0, 49, 74]);
const sourceBIdrsAfterFirst = multiGopBNals.filter(nal => nal.type === 5 && nal.sampleIndex > 0);
const mergedBIdrs = multiGopMergedNals.filter(nal => nal.type === 5 && nal.sampleIndex > 0);
assert.equal(mergedBIdrs.length, sourceBIdrsAfterFirst.length);
for (let i = 0; i < sourceBIdrsAfterFirst.length; i += 1) {
  assert.deepEqual(mergedBIdrs[i].data, sourceBIdrsAfterFirst[i].data, `Later B IDR ${i} bytes changed`);
}

const multiGopStszSum = multiGopMergedParsed.videoTrack.sampleSizes.sizes.reduce((total, value) => total + value, 0);
const multiGopMdatLength = multiGopMergedParsed.mdatRanges.reduce((total, box) => total + box.payloadEnd - box.payloadStart, 0);
assert.equal(multiGopStszSum, multiGopMdatLength);
assert.ok(multiGopMergedParsed.videoTrack.samples.every((sample, index, samples) => index === 0 || sample.offset > samples[index - 1].offset));
assert.equal(multiGopMergedParsed.videoTrack.stts.durations.reduce((total, value) => total + value, 0), multiGopMergedParsed.videoTrack.mdhd.duration);
pass('Multi-GOP B keeps two later IDR anchors, patches the first 24 B sample headers, and emits 99 samples with EP-safe frame_num handling');

writeFileSync(multiGopMergedPath, multiGopMerge.output);
const multiGopProbe = command('ffprobe', [
  '-v', 'error', '-select_streams', 'v:0', '-count_frames',
  '-show_entries', 'stream=codec_name,width,height,nb_read_frames,has_b_frames',
  '-of', 'default=noprint_wrappers=1', multiGopMergedPath,
], 'multi-GOP merged-file decode probe');
const multiGopDecodedFrames = Number(/nb_read_frames=(\d+)/.exec(multiGopProbe.stdout)?.[1] ?? 0);
assert.equal(multiGopDecodedFrames, multiGopAParsed.videoTrack.samples.length + multiGopBParsed.videoTrack.samples.length - 1);
const multiGopKeyFrames = command('ffprobe', [
  '-v', 'error', '-select_streams', 'v:0', '-show_entries', 'frame=key_frame', '-of', 'csv=p=0', multiGopMergedPath,
], 'multi-GOP keyframe inventory').stdout.split(/\s+/).filter(value => value.startsWith('1')).length;
assert.equal(multiGopKeyFrames, 3);
pass(`Multi-GOP merged export decodes all ${multiGopDecodedFrames} frames with three keyframe anchors (A plus two retained B IDRs)`);

await assert.rejects(
  () => mergeMoshH264(input, input, parsed, parsed),
  error => /pic_order_cnt_type 0 stream has picture reordering/.test(error.message)
    && /non-zero composition offsets/.test(error.message)
    && /B-slice NAL/.test(error.message),
);
pass('Multi-GOP pic_order_cnt_type 0 with true B-frame reordering still fails loudly');

const poc0AInput = new Uint8Array(readFileSync(multiGopFixtures.poc0A));
const poc0BInput = new Uint8Array(readFileSync(multiGopFixtures.poc0B));
const poc0AParsed = parseMp4(poc0AInput);
const poc0BParsed = parseMp4(poc0BInput);
for (const [label, bytes, parsed] of [['A', poc0AInput, poc0AParsed], ['B', poc0BInput, poc0BParsed]]) {
  const config = parseAvcConfig(bytes, parsed.videoTrack.avcC);
  const sps = parseSps(config.sps[0]);
  assert.equal(sps.picOrderCntType, 0, `POC0 fixture ${label} must declare pic_order_cnt_type 0`);
  assert.equal(parsed.videoTrack.ctts, null, `POC0 fixture ${label} must not contain composition reordering`);
}
const poc0Compatibility = await checkCompatibility(poc0AInput, poc0BInput, poc0AParsed, poc0BParsed);
assert.equal(poc0Compatibility.compatible, true);
const poc0Merge = await mergeMoshH264(poc0AInput, poc0BInput, poc0AParsed, poc0BParsed);
assert.equal(poc0Merge.report.frameAlignment.applied, true);
assert.equal(poc0Merge.report.frameAlignment.picOrderCntType, 0);
assert.equal(poc0Merge.report.frameAlignment.pictureReordering.noReordering, true);
assert.equal(poc0Merge.report.frameAlignment.pictureReordering.bSliceCount, 0);
assert.equal(poc0Merge.report.frameAlignment.pictureReordering.compositionReordered, false);
assert.equal(poc0Merge.report.frameAlignment.pictureOrderCountPatch.aLastPicOrderCntLsb, 8);
assert.equal(poc0Merge.report.frameAlignment.pictureOrderCountPatch.log2MaxPicOrderCntLsb, 4);
assert.equal(poc0Merge.report.bIdrCountRemaining, 2);
pass('Multi-GOP pic_order_cnt_type 0 without B-frames merges with frame_num alignment applied');

writeFileSync(multiGopPoc0MergedPath, poc0Merge.output);
const poc0Probe = command('ffprobe', [
  '-v', 'error', '-select_streams', 'v:0', '-count_frames',
  '-show_entries', 'stream=codec_name,width,height,nb_read_frames,has_b_frames',
  '-of', 'default=noprint_wrappers=1', multiGopPoc0MergedPath,
], 'POC0 multi-GOP merged-file decode probe');
const poc0DecodedFrames = Number(/nb_read_frames=(\d+)/.exec(poc0Probe.stdout)?.[1] ?? 0);
assert.equal(poc0DecodedFrames, poc0AParsed.videoTrack.samples.length + poc0BParsed.videoTrack.samples.length - 1);
assert.match(poc0Probe.stdout, /has_b_frames=0/);
const poc0MergedParsed = parseMp4(poc0Merge.output);
const poc0MergedIdrs = [...new Set(extractNals(poc0Merge.output, poc0MergedParsed.videoTrack)
  .filter(nal => nal.type === 5).map(nal => nal.sampleIndex))];
assert.deepEqual(poc0MergedIdrs, [0, 49, 74]);
pass(`POC0 multi-GOP merged export decodes all ${poc0DecodedFrames} frames and retains later B IDR anchors`);

const multiGopIdrSet = new Set(multiGopBIdrSamples);
const expectedMeltSchedule = [];
for (let index = 1; index < multiGopBParsed.videoTrack.samples.length; index += 1) {
  const copies = multiGopIdrSet.has(index) ? 1 : 4;
  for (let copy = 0; copy < copies; copy += 1) expectedMeltSchedule.push(index);
}
const meltMerge = await mergeEffectH264(multiGopAInput, multiGopBInput, multiGopAParsed, multiGopBParsed, {
  method: 'melt',
  repeat: 4,
});
assert.equal(meltMerge.report.method, 'melt');
assert.equal(meltMerge.report.effect.repeat, 4);
assert.deepEqual(meltMerge.report.effect.scheduledSourceSamples, expectedMeltSchedule);
assert.equal(meltMerge.report.bScheduledSamples, 290);
assert.equal(meltMerge.report.mergedSamples, 315);
assert.equal(meltMerge.report.bPictureSamples, 290);
assert.equal(meltMerge.report.frameAlignment.patchedSamples, 288);
assert.equal(meltMerge.report.frameAlignment.patchedNals, 288);
assert.equal(meltMerge.report.bIdrCountRemaining, 2);
const meltParsed = parseMp4(meltMerge.output);
const meltNals = extractNals(meltMerge.output, meltParsed.videoTrack);
const meltSps = parseSps(parseAvcConfig(multiGopBInput, multiGopBParsed.videoTrack.avcC).sps[0]);
assertEffectNalPayloads(
  meltNals,
  extractNals(multiGopAInput, multiGopAParsed.videoTrack).length,
  multiGopBNals,
  meltMerge.report.effect.scheduledSourceSamples,
  meltSps,
  'melt',
);
const meltStsz = meltParsed.videoTrack.sampleSizes.sizes.reduce((total, value) => total + value, 0);
const meltMdat = meltParsed.mdatRanges.reduce((total, box) => total + box.payloadEnd - box.payloadStart, 0);
assert.equal(meltStsz, meltMdat);
assert.ok(meltParsed.videoTrack.samples.every((sample, index, samples) => index === 0 || sample.offset > samples[index - 1].offset));
assert.equal(meltParsed.videoTrack.stts.durations.reduce((total, value) => total + value, 0), meltParsed.videoTrack.mdhd.duration);
writeFileSync(meltOutputPath, meltMerge.output);
const meltProbe = command('ffprobe', [
  '-v', 'error', '-select_streams', 'v:0', '-count_frames',
  '-show_entries', 'stream=codec_name,nb_frames,nb_read_frames,has_b_frames',
  '-of', 'default=noprint_wrappers=1', meltOutputPath,
], 'Melt decode probe');
const meltDecodedFrames = Number(/nb_read_frames=(\d+)/.exec(meltProbe.stdout)?.[1] ?? 0);
assert.equal(meltDecodedFrames, meltMerge.report.mergedSamples);
command('ffmpeg', ['-v', 'error', '-i', meltOutputPath, '-f', 'null', '-'], 'Melt strict decode');
pass(`Melt repeat=4 emits ${meltMerge.report.mergedSamples} samples, changes only slice header frame_num bits, and decodes ${meltDecodedFrames}/${meltMerge.report.mergedSamples} frames`);

const expectedLoopSchedule = [
  ...Array.from({length: 3}, () => [1, 2, 3, 4]).flat(),
  ...Array.from({length: 2}, () => [13, 14, 15, 16]).flat(),
  ...Array.from({length: 54}, (_, index) => index + 21),
];
const loopMerge = await mergeEffectH264(multiGopAInput, multiGopBInput, multiGopAParsed, multiGopBParsed, {
  method: 'loop',
  loopFrames: 4,
});
assert.equal(loopMerge.report.method, 'loop');
assert.equal(loopMerge.report.effect.loopFrames, 4);
assert.deepEqual(loopMerge.report.effect.loopWindow, [1, 2, 3, 4]);
assert.deepEqual(loopMerge.report.effect.loopSecondWindow, [13, 14, 15, 16]);
assert.deepEqual(loopMerge.report.effect.loopSchedule.blocks, [
  {emittedStart: 0, donorStart: 1, length: 4, repeats: 3, donorSamples: [1, 2, 3, 4]},
  {emittedStart: 12, donorStart: 13, length: 4, repeats: 2, donorSamples: [13, 14, 15, 16]},
]);
assert.equal(loopMerge.report.effect.loopSchedule.tailStart, 20);
assert.equal(loopMerge.report.effect.loopSchedule.tailDonorStart, 21);
assert.deepEqual(loopMerge.report.effect.scheduledSourceSamples, expectedLoopSchedule);
assert.equal(loopMerge.report.bScheduledSamples, 74);
assert.equal(loopMerge.report.mergedSamples, 99);
assert.equal(loopMerge.report.frameAlignment.patchedSamples, 72);
assert.equal(loopMerge.report.bIdrCountRemaining, 2);
const loopParsed = parseMp4(loopMerge.output);
const loopNals = extractNals(loopMerge.output, loopParsed.videoTrack);
assertEffectNalPayloads(
  loopNals,
  extractNals(multiGopAInput, multiGopAParsed.videoTrack).length,
  multiGopBNals,
  loopMerge.report.effect.scheduledSourceSamples,
  meltSps,
  'loop',
);
writeFileSync(loopOutputPath, loopMerge.output);
const loopProbe = command('ffprobe', [
  '-v', 'error', '-select_streams', 'v:0', '-count_frames',
  '-show_entries', 'stream=codec_name,nb_frames,nb_read_frames,has_b_frames',
  '-of', 'default=noprint_wrappers=1', loopOutputPath,
], 'Loop decode probe');
const loopDecodedFrames = Number(/nb_read_frames=(\d+)/.exec(loopProbe.stdout)?.[1] ?? 0);
assert.equal(loopDecodedFrames, loopMerge.report.mergedSamples);
command('ffmpeg', ['-v', 'error', '-i', loopOutputPath, '-f', 'null', '-'], 'Loop strict decode');
pass(`Loop Release loop_frames=4 emits 3× and 2× donor blocks, rejoins at donor 21, renumbers ${loopMerge.report.frameAlignment.patchedSamples} non-IDR samples, and decodes ${loopDecodedFrames}/${loopMerge.report.mergedSamples} frames`);

const meltDurationWindow = [1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6];
const meltDurationSchedule = [
  ...meltDurationWindow,
  ...Array.from({length: 68}, (_, index) => index + 7),
];
const meltDuration = await mergeEffectH264(multiGopAInput, multiGopBInput, multiGopAParsed, multiGopBParsed, {
  method: 'melt',
  repeat: 2,
  durationFrames: 12,
  ending: 'continue',
});
assert.equal(meltDuration.report.durationFrames, 12);
assert.equal(meltDuration.report.ending, 'continue');
assert.equal(meltDuration.report.effect.window.explicitDuration, true);
assert.equal(meltDuration.report.effect.window.windowOutputSamples, 12);
assert.deepEqual(meltDuration.report.effect.window.scheduledSourceSamples, meltDurationWindow);
assert.deepEqual(meltDuration.report.effect.scheduledSourceSamples, meltDurationSchedule);
assert.deepEqual(meltDuration.report.effect.window.tail, {
  outputStart: 37,
  donorStartSample: 7,
  restoreResetPosition: null,
});
assert.equal(meltDuration.report.bScheduledSamples, 80);
assert.equal(meltDuration.report.mergedSamples, 105);
const meltDurationParsed = parseMp4(meltDuration.output);
const meltDurationNals = extractNals(meltDuration.output, meltDurationParsed.videoTrack);
assertEffectNalPayloads(
  meltDurationNals,
  extractNals(multiGopAInput, multiGopAParsed.videoTrack).length,
  multiGopBNals,
  meltDuration.report.effect.scheduledSourceSamples,
  meltSps,
  'melt-duration',
);
assert.equal(
  meltDurationParsed.videoTrack.sampleSizes.sizes.reduce((total, value) => total + value, 0),
  meltDurationParsed.mdatRanges.reduce((total, box) => total + box.payloadEnd - box.payloadStart, 0),
);
writeFileSync(meltDurationOutputPath, meltDuration.output);
const meltDurationProbe = command('ffprobe', [
  '-v', 'error', '-select_streams', 'v:0', '-count_frames',
  '-show_entries', 'stream=nb_read_frames,has_b_frames', '-of', 'default=noprint_wrappers=1', meltDurationOutputPath,
], 'Melt duration decode probe');
const meltDurationDecoded = Number(/nb_read_frames=(\d+)/.exec(meltDurationProbe.stdout)?.[1] ?? 0);
assert.equal(meltDurationDecoded, 105);
assert.match(meltDurationProbe.stdout, /has_b_frames=0/);
command('ffmpeg', ['-v', 'error', '-i', meltDurationOutputPath, '-f', 'null', '-'], 'Melt duration strict decode');
pass(`Melt duration=12 emits an exact 12-frame hold window, then donor 7 tail, and decodes ${meltDurationDecoded}/105 frames`);

const gentleWindowSources = [1, 1, 2, 2, 3, 3, 4, 6, 8, 10, 11, 12];
const gentleSchedule = [
  ...gentleWindowSources,
  ...Array.from({length: 62}, (_, index) => index + 13),
];
const gentleMelt = await mergeEffectH264(multiGopAInput, multiGopBInput, multiGopAParsed, multiGopBParsed, {
  method: 'melt',
  repeat: 2,
  durationFrames: 12,
  ending: 'continue',
  smooth: true,
});
assert.equal(gentleMelt.report.effect.smooth, true);
assert.equal(gentleMelt.report.effect.window.smooth, true);
assert.equal(gentleMelt.report.effect.window.releaseOutputIndex, 9);
assert.deepEqual(gentleMelt.report.effect.window.baseDonorPositions, [0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5]);
assert.deepEqual(gentleMelt.report.effect.window.scheduledSourceSamples, gentleWindowSources);
assert.deepEqual(gentleMelt.report.effect.scheduledSourceSamples, gentleSchedule);
assert.deepEqual(gentleMelt.report.effect.window.tail, {
  outputStart: 37,
  donorStartSample: 13,
  restoreResetPosition: null,
});
const gentleDonorPositions = gentleWindowSources.map(sampleIndex => sampleIndex - 1);
for (let index = 1; index < gentleMelt.report.effect.window.releaseOutputIndex; index += 1) {
  assert.ok(gentleDonorPositions[index] - gentleDonorPositions[index - 1] <= 2);
}
assert.deepEqual(gentleDonorPositions.slice(9), [9, 10, 11]);
assert.equal(gentleMelt.report.mergedSamples, 99);
assert.equal(gentleMelt.report.frameAlignment.patchedSamples, 72);
const gentleParsed = parseMp4(gentleMelt.output);
assertEffectNalPayloads(
  extractNals(gentleMelt.output, gentleParsed.videoTrack),
  extractNals(multiGopAInput, multiGopAParsed.videoTrack).length,
  multiGopBNals,
  gentleMelt.report.effect.scheduledSourceSamples,
  meltSps,
  'melt-gentler',
);
writeFileSync(meltGentleOutputPath, gentleMelt.output);
const gentleProbe = command('ffprobe', [
  '-v', 'error', '-select_streams', 'v:0', '-count_frames',
  '-show_entries', 'stream=nb_read_frames,has_b_frames', '-of', 'default=noprint_wrappers=1', meltGentleOutputPath,
], 'Gentler Melt decode probe');
assert.match(gentleProbe.stdout, /nb_read_frames=99/);
assert.match(gentleProbe.stdout, /has_b_frames=0/);
command('ffmpeg', ['-v', 'error', '-i', meltGentleOutputPath, '-f', 'null', '-'], 'Gentler Melt strict decode');
pass('Gentler Melt bounds donor advances to two frames, uses consecutive donors in the final quarter, and decodes 99/99');

const gentleRestore = await mergeEffectH264(multiGopAInput, multiGopBInput, multiGopAParsed, multiGopBParsed, {
  method: 'melt',
  repeat: 2,
  durationFrames: 12,
  ending: 'restore',
  smooth: true,
});
assert.equal(gentleRestore.report.mergedSamples, 100);
assert.deepEqual(gentleRestore.report.reInsertedIdrPositions, [37]);
await assert.rejects(
  () => mergeEffectH264(multiGopAInput, multiGopBInput, multiGopAParsed, multiGopBParsed, {
    method: 'melt', repeat: 2, smooth: true,
  }),
  error => /Gentler Melt cadence requires an explicit duration window/.test(error.message),
);
pass('Gentler Restore keeps the IDR anchor and Gentler without an explicit duration fails loudly');

const meltRestore = await mergeEffectH264(multiGopAInput, multiGopBInput, multiGopAParsed, multiGopBParsed, {
  method: 'melt',
  repeat: 2,
  durationFrames: 12,
  ending: 'restore',
});
assert.equal(meltRestore.report.mergedSamples, 106);
assert.deepEqual(meltRestore.report.reInsertedIdrPositions, [37]);
assert.equal(meltRestore.report.effect.window.tail.restoreResetPosition, 37);
const meltRestoreParsed = parseMp4(meltRestore.output);
const meltRestoreBoundary = multiGopBParsed.videoTrack.samples[0];
const meltRestoreBoundaryBytes = multiGopBInput.subarray(
  meltRestoreBoundary.offset,
  meltRestoreBoundary.offset + meltRestoreBoundary.size,
);
const meltRestoreIdrSample = meltRestoreParsed.videoTrack.samples[37];
assert.deepEqual(
  meltRestore.output.subarray(meltRestoreIdrSample.offset, meltRestoreIdrSample.offset + meltRestoreIdrSample.size),
  meltRestoreBoundaryBytes,
);
writeFileSync(meltRestoreOutputPath, meltRestore.output);
const meltRestoreProbe = command('ffprobe', [
  '-v', 'error', '-select_streams', 'v:0', '-count_frames',
  '-show_entries', 'stream=nb_read_frames', '-of', 'default=noprint_wrappers=1', meltRestoreOutputPath,
], 'Melt restore decode probe');
assert.match(meltRestoreProbe.stdout, /nb_read_frames=106/);
command('ffmpeg', ['-v', 'error', '-i', meltRestoreOutputPath, '-f', 'null', '-'], 'Melt restore strict decode');
pass('Melt Restore re-inserts the byte-identical incoming IDR at the tail start and decodes 106/106 frames');

const loopDurationWindow = [1, 2, 1, 2, 1, 2, 7, 8, 9, 10, 11, 12];
const loopDurationSchedule = [
  ...loopDurationWindow,
  ...Array.from({length: 62}, (_, index) => index + 13),
];
const loopDuration = await mergeEffectH264(multiGopAInput, multiGopBInput, multiGopAParsed, multiGopBParsed, {
  method: 'loop',
  loopFrames: 4,
  durationFrames: 12,
  ending: 'continue',
});
assert.equal(loopDuration.report.durationFrames, 12);
assert.equal(loopDuration.report.effect.window.windowOutputSamples, 12);
assert.deepEqual(loopDuration.report.effect.scheduledSourceSamples, loopDurationSchedule);
assert.deepEqual(loopDuration.report.effect.window.tail, {
  outputStart: 37,
  donorStartSample: 13,
  restoreResetPosition: null,
});
assert.equal(loopDuration.report.mergedSamples, 99);
const loopDurationParsed = parseMp4(loopDuration.output);
assertEffectNalPayloads(
  extractNals(loopDuration.output, loopDurationParsed.videoTrack),
  extractNals(multiGopAInput, multiGopAParsed.videoTrack).length,
  multiGopBNals,
  loopDuration.report.effect.scheduledSourceSamples,
  meltSps,
  'loop-duration',
);
writeFileSync(loopDurationOutputPath, loopDuration.output);
const loopDurationProbe = command('ffprobe', [
  '-v', 'error', '-select_streams', 'v:0', '-count_frames',
  '-show_entries', 'stream=nb_read_frames', '-of', 'default=noprint_wrappers=1', loopDurationOutputPath,
], 'Loop duration decode probe');
assert.match(loopDurationProbe.stdout, /nb_read_frames=99/);
command('ffmpeg', ['-v', 'error', '-i', loopDurationOutputPath, '-f', 'null', '-'], 'Loop duration strict decode');
const loopRestore = await mergeEffectH264(multiGopAInput, multiGopBInput, multiGopAParsed, multiGopBParsed, {
  method: 'loop',
  loopFrames: 4,
  durationFrames: 12,
  ending: 'restore',
});
assert.equal(loopRestore.report.mergedSamples, 100);
assert.deepEqual(loopRestore.report.reInsertedIdrPositions, [37]);
pass('Loop Release duration=12 scales the 3×/2× window, rejoins at donor 13, and Restore decodes with an anchor');

const clampedMeltDuration = await mergeEffectH264(multiGopAInput, multiGopBInput, multiGopAParsed, multiGopBParsed, {
  method: 'melt',
  repeat: 4,
  durationFrames: 999,
  ending: 'continue',
});
assert.equal(clampedMeltDuration.report.durationFrames, 74);
assert.equal(clampedMeltDuration.report.clamped, true);
assert.equal(clampedMeltDuration.report.effect.window.windowOutputSamples, 74);
assert.equal(clampedMeltDuration.report.effect.window.tail.donorStartSample, 20);
const oneFrameMelt = await mergeEffectH264(multiGopAInput, multiGopBInput, multiGopAParsed, multiGopBParsed, {
  method: 'melt',
  repeat: 4,
  durationFrames: 1,
  ending: 'continue',
});
assert.equal(oneFrameMelt.report.durationFrames, 1);
assert.equal(oneFrameMelt.report.effect.window.windowOutputSamples, 1);
assert.equal(oneFrameMelt.report.effect.window.tail.donorStartSample, 2);
await assert.rejects(
  () => mergeEffectH264(multiGopAInput, multiGopBInput, multiGopAParsed, multiGopBParsed, {
    method: 'melt', repeat: 4, durationFrames: 0,
  }),
  error => error instanceof ValueError && /greater than zero/.test(error.message),
);
pass('Melt/Loop duration clamps to 74 frames, accepts one frame, and rejects zero loudly');

const expectedResetSchedule = [
  0, 1, 1, 2, 2, 3,
  0, 1, 1, 2, 2, 3,
  ...Array.from({length: 62}, (_, index) => index + 13),
];
const resetPulse = await mergeEffectH264(multiGopAInput, multiGopBInput, multiGopAParsed, multiGopBParsed, {
  method: 'reset-pulse',
  durationFrames: 12,
  resetInterval: 6,
  repeat: 2,
  ending: 'continue',
});
assert.equal(resetPulse.report.method, 'reset-pulse');
assert.equal(resetPulse.report.effect.method, 'reset-pulse');
assert.deepEqual(resetPulse.report.effect.scheduledSourceSamples, expectedResetSchedule);
assert.equal(resetPulse.report.mergedSamples, 99);
assert.equal(resetPulse.report.bScheduledSamples, 74);
assert.equal(resetPulse.report.frameAlignment.patchedSamples, 70);
assert.equal(resetPulse.report.frameAlignment.gopResets, 4);
assert.deepEqual(resetPulse.report.resetPulse.resetOutputPositions, [25, 31]);
assert.deepEqual(resetPulse.report.resetPulse.patchCounts, [5, 5]);
assert.deepEqual(resetPulse.report.resetPulse.intervals.map(interval => interval.donorSamples), [
  [1, 1, 2, 2, 3],
  [1, 1, 2, 2, 3],
]);
assert.deepEqual(resetPulse.report.resetPulse.tail, {
  outputStart: 37,
  donorStartSample: 13,
  restoreResetPosition: null,
});
assert.deepEqual(resetPulse.report.reInsertedIdrPositions, [25, 31]);
const resetParsed = parseMp4(resetPulse.output);
const resetNals = extractNals(resetPulse.output, resetParsed.videoTrack);
const resetBoundarySample = multiGopBParsed.videoTrack.samples[0];
const resetBoundaryBytes = multiGopBInput.subarray(resetBoundarySample.offset, resetBoundarySample.offset + resetBoundarySample.size);
for (const outputIndex of resetPulse.report.resetPulse.resetOutputPositions) {
  const sample = resetParsed.videoTrack.samples[outputIndex];
  assert.deepEqual(resetPulse.output.subarray(sample.offset, sample.offset + sample.size), resetBoundaryBytes);
}
assertEffectNalPayloads(
  resetNals,
  extractNals(multiGopAInput, multiGopAParsed.videoTrack).length,
  multiGopBNals,
  resetPulse.report.effect.scheduledSourceSamples,
  meltSps,
  'reset-pulse',
  {preserveAllSampleNals: true},
);
assert.equal(resetParsed.videoTrack.sampleSizes.sizes.reduce((total, value) => total + value, 0),
  resetParsed.mdatRanges.reduce((total, box) => total + box.payloadEnd - box.payloadStart, 0));
assert.ok(resetParsed.videoTrack.samples.every((sample, index, samples) => index === 0 || sample.offset > samples[index - 1].offset));
writeFileSync(resetPulseOutputPath, resetPulse.output);
const resetProbe = command('ffprobe', [
  '-v', 'error', '-select_streams', 'v:0', '-count_frames',
  '-show_entries', 'stream=codec_name,nb_frames,nb_read_frames,has_b_frames',
  '-of', 'default=noprint_wrappers=1', resetPulseOutputPath,
], 'Reset Pulse decode probe');
assert.match(resetProbe.stdout, /nb_frames=99/);
assert.match(resetProbe.stdout, /nb_read_frames=99/);
assert.match(resetProbe.stdout, /has_b_frames=0/);
command('ffmpeg', ['-v', 'error', '-i', resetPulseOutputPath, '-f', 'null', '-'], 'Reset Pulse strict decode');
pass('Reset Pulse emits exact IDR/repeat intervals, byte-identical boundary samples, and decodes 99/99 frames');

const resetRestore = await mergeEffectH264(multiGopAInput, multiGopBInput, multiGopAParsed, multiGopBParsed, {
  method: 'reset-pulse',
  durationFrames: 12,
  resetInterval: 6,
  repeat: 2,
  ending: 'restore',
});
assert.equal(resetRestore.report.mergedSamples, 100);
assert.deepEqual(resetRestore.report.reInsertedIdrPositions, [25, 31, 37]);
assert.equal(resetRestore.report.resetPulse.tail.restoreResetPosition, 37);
writeFileSync(resetPulseRestoreOutputPath, resetRestore.output);
const resetRestoreProbe = command('ffprobe', [
  '-v', 'error', '-select_streams', 'v:0', '-count_frames',
  '-show_entries', 'stream=nb_read_frames', '-of', 'default=noprint_wrappers=1', resetPulseRestoreOutputPath,
], 'Reset Pulse restore decode probe');
assert.match(resetRestoreProbe.stdout, /nb_read_frames=100/);
pass('Reset Pulse Restore inserts the boundary IDR before the chronological tail and decodes 100/100 frames');

await assert.rejects(
  () => mergeEffectH264(multiGopAInput, multiGopBInput, multiGopAParsed, multiGopBParsed, {
    method: 'reset-pulse', durationFrames: 8, resetInterval: 8, repeat: 2, ending: 'continue',
  }),
  error => /must be smaller than the 8-frame/.test(error.message),
);
const intervalFour = await mergeEffectH264(multiGopAInput, multiGopBInput, multiGopAParsed, multiGopBParsed, {
  method: 'reset-pulse', durationFrames: 12, resetInterval: 4, repeat: 2, ending: 'continue',
});
assert.deepEqual(intervalFour.report.resetPulse.resetOutputPositions, [25, 29, 33]);
assert.equal(intervalFour.report.mergedSamples, 99);
const repeatTwelve = await mergeEffectH264(multiGopAInput, multiGopBInput, multiGopAParsed, multiGopBParsed, {
  method: 'reset-pulse', durationFrames: 12, resetInterval: 6, repeat: 12, ending: 'continue',
});
assert.deepEqual(repeatTwelve.report.resetPulse.intervals[0].donorSamples, [1, 1, 1, 1, 1]);
const clampedReset = await mergeEffectH264(multiGopAInput, multiGopBInput, multiGopAParsed, multiGopBParsed, {
  method: 'reset-pulse', durationFrames: 999, resetInterval: 12, repeat: 4, ending: 'continue',
});
assert.equal(clampedReset.report.resetPulse.durationFrames, 74);
assert.equal(clampedReset.report.resetPulse.clamped, true);
pass('Reset Pulse rejects interval >= duration, accepts interval 4 and repeat endpoints 2/12, and reports duration clamping');

const poc0Reset = await mergeEffectH264(poc0AInput, poc0BInput, poc0AParsed, poc0BParsed, {
  method: 'reset-pulse',
  durationFrames: 12,
  resetInterval: 6,
  repeat: 2,
  ending: 'continue',
});
assert.equal(poc0Reset.report.frameAlignment.picOrderCntType, 0);
assert.equal(poc0Reset.report.frameAlignment.patchedIdrNals, 2);
assert.equal(poc0Reset.report.resetPulse.patchedIdrNals, 2);
assert.equal(poc0Reset.report.frameAlignment.segments[0].firstFrameNumber, 1);
assert.equal(poc0Reset.report.frameAlignment.segments[0].firstPicOrderCntLsb, 1);
assert.equal(poc0Reset.report.frameAlignment.segments[0].lastPicOrderCntLsb, 5);
assert.equal(poc0Reset.report.frameAlignment.segments[1].firstPicOrderCntLsb, 1);
writeFileSync(resetPulsePoc0OutputPath, poc0Reset.output);
const poc0ResetParsed = parseMp4(poc0Reset.output);
const poc0ResetNals = extractNals(poc0Reset.output, poc0ResetParsed.videoTrack);
const poc0Sps = parseSps(parseAvcConfig(poc0BInput, poc0BParsed.videoTrack.avcC).sps[0]);
const segmentCounterExpectations = [
  [26, 1, 1], [27, 2, 2], [28, 3, 3], [29, 4, 4], [30, 5, 5],
  [32, 1, 1], [33, 2, 2], [34, 3, 3], [35, 4, 4], [36, 5, 5],
];
for (const [sampleIndex, frameNumber, picOrderCntLsb] of segmentCounterExpectations) {
  const nal = poc0ResetNals.find(candidate => candidate.sampleIndex === sampleIndex && candidate.type === 1);
  assert.ok(nal, `missing P slice at output sample ${sampleIndex}`);
  assert.deepEqual(readSliceCounters(nal.data, poc0Sps), {frameNumber, picOrderCntLsb});
}
const poc0ResetProbe = command('ffprobe', [
  '-v', 'error', '-select_streams', 'v:0', '-count_frames',
  '-show_entries', 'stream=nb_frames,nb_read_frames,has_b_frames',
  '-of', 'default=noprint_wrappers=1', resetPulsePoc0OutputPath,
], 'Reset Pulse POC0 decode probe');
assert.match(poc0ResetProbe.stdout, /nb_read_frames=99/);
assert.match(poc0ResetProbe.stdout, /has_b_frames=0/);
pass('Reset Pulse POC type 0 slices restart frame_num/POC-LSB at 1 in each pulse segment and decode 99/99 frames');

const resetThenCut = await mergeSequenceH264(
  [
    {bytes: multiGopAInput, parsed: multiGopAParsed},
    {bytes: multiGopBInput, parsed: multiGopBParsed},
    {bytes: multiGopAInput, parsed: multiGopAParsed},
  ],
  [
    {method: 'reset-pulse', durationFrames: 12, resetInterval: 6, repeat: 2, ending: 'continue'},
    {method: 'cut'},
  ],
);
assert.deepEqual(resetThenCut.report.methods, ['reset-pulse', 'cut']);
assert.equal(resetThenCut.report.mergedSamples, 124);
writeFileSync(resetPulseCutOutputPath, resetThenCut.output);
command('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-count_frames',
  '-show_entries', 'stream=nb_read_frames', '-of', 'default=noprint_wrappers=1', resetPulseCutOutputPath], 'Reset Pulse then Cut probe');
const resetThenMosh = await mergeSequenceH264(
  [
    {bytes: multiGopAInput, parsed: multiGopAParsed},
    {bytes: multiGopBInput, parsed: multiGopBParsed},
    {bytes: multiGopAInput, parsed: multiGopAParsed},
  ],
  [
    {method: 'reset-pulse', durationFrames: 12, resetInterval: 6, repeat: 2, ending: 'continue'},
    {method: 'classic-mosh'},
  ],
);
assert.deepEqual(resetThenMosh.report.methods, ['reset-pulse', 'classic-mosh']);
assert.equal(resetThenMosh.report.mergedSamples, 123);
writeFileSync(resetPulseMoshOutputPath, resetThenMosh.output);
const resetMoshProbe = command('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-count_frames',
  '-show_entries', 'stream=nb_read_frames', '-of', 'default=noprint_wrappers=1', resetPulseMoshOutputPath], 'Reset Pulse then Classic Mosh probe');
assert.match(resetMoshProbe.stdout, /nb_read_frames=123/);
pass('chained Reset Pulse then Cut/Classic Mosh sequences use the pulse IDRs as anchors and decode 124/124 and 123/123 frames');

const poc0Melt = await mergeEffectH264(poc0AInput, poc0BInput, poc0AParsed, poc0BParsed, {
  method: 'melt',
  repeat: 2,
});
assert.equal(poc0Melt.report.frameAlignment.picOrderCntType, 0);
assert.equal(poc0Melt.report.frameAlignment.firstEmittedPicOrderCntLsb, 9);
assert.ok(poc0Melt.report.frameAlignment.patchedNals > 0);
writeFileSync(poc0MeltOutputPath, poc0Melt.output);
const poc0MeltProbe = command('ffprobe', [
  '-v', 'error', '-select_streams', 'v:0', '-count_frames',
  '-show_entries', 'stream=nb_frames,nb_read_frames,has_b_frames',
  '-of', 'default=noprint_wrappers=1', poc0MeltOutputPath,
], 'POC0 Melt decode probe');
const poc0MeltDecodedFrames = Number(/nb_read_frames=(\d+)/.exec(poc0MeltProbe.stdout)?.[1] ?? 0);
assert.equal(poc0MeltDecodedFrames, poc0Melt.report.mergedSamples);
assert.match(poc0MeltProbe.stdout, /has_b_frames=0/);
pass(`POC0 Melt repeat=2 patches frame_num and monotonic POC-LSB values and decodes ${poc0MeltDecodedFrames}/${poc0Melt.report.mergedSamples} frames`);

const effectSequence = await mergeSequenceH264(
  [
    {bytes: multiGopAInput, parsed: multiGopAParsed},
    {bytes: multiGopBInput, parsed: multiGopBParsed},
    {bytes: multiGopAInput, parsed: multiGopAParsed},
  ],
  [
    {method: 'melt', repeat: 2},
    {method: 'loop', loopFrames: 4},
  ],
);
assert.deepEqual(effectSequence.report.methods, ['melt', 'loop']);
assert.equal(effectSequence.report.effectBoundaries, 2);
assert.equal(effectSequence.report.mergedSamples, 195);
assert.equal(effectSequence.report.expectedDecodedFrames, 195);
writeFileSync(join(projectRoot, 'testmedia', 'synthetic-effect-sequence-test-output.mp4'), effectSequence.output);
const effectSequenceProbe = command('ffprobe', [
  '-v', 'error', '-select_streams', 'v:0', '-count_frames',
  '-show_entries', 'stream=nb_frames,nb_read_frames',
  '-of', 'default=noprint_wrappers=1',
  join(projectRoot, 'testmedia', 'synthetic-effect-sequence-test-output.mp4'),
], 'effect sequence decode probe');
const effectSequenceFrames = Number(/nb_read_frames=(\d+)/.exec(effectSequenceProbe.stdout)?.[1] ?? 0);
assert.equal(effectSequenceFrames, 195);
pass('three-clip Melt then Loop Release chain emits and decodes 195/195 samples with the running-chain frame counters');

const loopThenCut = await mergeSequenceH264(
  [
    {bytes: multiGopAInput, parsed: multiGopAParsed},
    {bytes: multiGopBInput, parsed: multiGopBParsed},
    {bytes: multiGopAInput, parsed: multiGopAParsed},
  ],
  [
    {method: 'loop', loopFrames: 4},
    {method: 'cut'},
  ],
);
assert.deepEqual(loopThenCut.report.methods, ['loop', 'cut']);
assert.equal(loopThenCut.report.mergedSamples, 124);
assert.equal(loopThenCut.report.expectedDecodedFrames, 124);
writeFileSync(join(projectRoot, 'testmedia', 'synthetic-loop-cut-test-output.mp4'), loopThenCut.output);
const loopCutProbe = command('ffprobe', [
  '-v', 'error', '-select_streams', 'v:0', '-count_frames',
  '-show_entries', 'stream=nb_frames,nb_read_frames',
  '-of', 'default=noprint_wrappers=1',
  join(projectRoot, 'testmedia', 'synthetic-loop-cut-test-output.mp4'),
], 'Loop Release then Cut decode probe');
assert.match(loopCutProbe.stdout, /nb_read_frames=124/);
pass('chained Loop Release then Cut preserves the release tail and decodes 124/124 frames');

const audioSourceHashes = Object.fromEntries(Object.entries(audioFixtures).map(([key, path]) => [key,
  createHash('sha256').update(readFileSync(path)).digest('hex'),
]));
const audioFrameSamples = samplesPerFrame(25);
assert.equal(audioFrameSamples, 1920);

const randomSeed = '0123456789abcdef';
const randomAgain = randomizeTransition({seed: randomSeed, availableFrames: 144, fps: 30});
assert.deepEqual(randomizeTransition({seed: randomSeed, availableFrames: 144, fps: 30}), randomAgain, 'same seed must reproduce the exact randomized settings');
assert.equal(randomAgain.randomSeed, randomSeed);
let randomizedCombinations = 0;
for (let index = 0; index < 50; index += 1) {
  const seed = index.toString(16).padStart(16, '0');
  for (const method of RANDOM_METHODS) {
    const settings = randomizeTransition({seed, availableFrames: 144, fps: 30, methods: [method]});
    assert.equal(settings.method, method);
    assert.ok(settings.randomSeed === seed);
    assert.ok(settings.durationFrames >= 12 && settings.durationFrames <= 144);
    assert.ok(settings.durationFrames / 30 >= 0.5);
    assert.ok(settings.ending === 'restore' || settings.ending === 'continue');
    if (method === 'melt') assert.ok(settings.repeat >= 2 && settings.repeat <= 12);
    if (method === 'loop') assert.ok(settings.loopFrames >= 2 && settings.loopFrames < settings.durationFrames && settings.loopFrames <= 48);
    if (method === 'reset-pulse') {
      assert.ok(settings.resetInterval >= 4 && settings.resetInterval < settings.durationFrames && settings.resetInterval <= 48);
      assert.ok(settings.repeat >= 2 && settings.repeat <= 12);
    }
    validateRandomTransition(settings, {availableFrames: 144, fps: 30});
    randomizedCombinations += 1;
  }
}
assert.equal(randomizedCombinations, 200);
assert.equal(canRandomize({availableFrames: 15, fps: 30}), true);
assert.equal(canRandomize({availableFrames: 14, fps: 30}), false);
assert.throws(() => randomizeTransition({seed: 'not-a-seed', availableFrames: 144, fps: 30}), RandomizeError);
assert.throws(() => randomizeTransition({seed: '0000000000000001', availableFrames: 14, fps: 30}), RandomizeError);
pass('Randomize reproduces identical settings per seed and validates 50 seeds x 4 methods (200 combinations) within duration, ending, repeat, loop and reset guards');

const speedPlans = new Map([
  [2, speedFramePlan(60, 30, 2)],
  [0.5, speedFramePlan(60, 30, 0.5)],
  [1, speedFramePlan(60, 30, 1)],
  [1.7, speedFramePlan(60, 30, 1.7)],
]);
assert.equal(speedPlans.get(2).outputFrames, 30);
assert.deepEqual(speedPlans.get(2).donorIndexes, Array.from({length: 30}, (_, index) => index * 2));
assert.equal(speedPlans.get(0.5).outputFrames, 120);
assert.deepEqual(speedPlans.get(0.5).donorIndexes.slice(0, 8), [0, 0, 1, 1, 2, 2, 3, 3]);
assert.equal(speedPlans.get(1).outputFrames, 60);
assert.deepEqual(speedPlans.get(1).donorIndexes, Array.from({length: 60}, (_, index) => index));
assert.equal(speedPlans.get(1.7).outputFrames, 35);
assert.deepEqual(speedPlans.get(1.7).donorIndexes.slice(0, 8), [0, 1, 3, 5, 6, 8, 10, 11]);
for (const speed of [0.1, 0.3, 0.5, 1, 1.7, 2, 4]) {
  const chain = atempoChain(speed);
  assert.ok(chain.every(stage => stage >= 0.5 && stage <= 2));
  assert.ok(Math.abs(chain.reduce((total, stage) => total * stage, 1) - speed) < 1e-5);
}
assert.throws(() => normalizeSpeed(0.05), SpeedValueError);
assert.throws(() => normalizeSpeed(5), SpeedValueError);
assert.throws(() => normalizeSpeed(1.25), SpeedValueError);
pass('Speed plans map 60 frames to 30/120/60/35 frames at 2×/0.5×/1×/1.7× and reject out-of-range values');

function readInterleavedFloat32(path) {
  const bytes = readFileSync(path);
  return new Float32Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 4);
}

function estimateToneFrequency(interleaved, channels, sampleRate) {
  const start = 2400;
  const length = 8192;
  const mono = new Float32Array(length);
  let mean = 0;
  for (let index = 0; index < length; index += 1) {
    mono[index] = interleaved[(start + index) * channels];
    mean += mono[index];
  }
  mean /= length;
  for (let index = 0; index < length; index += 1) mono[index] -= mean;
  let bestLag = 0;
  let best = -Infinity;
  for (let lag = Math.floor(sampleRate / 1200); lag <= Math.ceil(sampleRate / 150); lag += 1) {
    let correlation = 0;
    let energy = 0;
    for (let index = 0; index + lag < length; index += 1) {
      correlation += mono[index] * mono[index + lag];
      energy += mono[index] * mono[index];
    }
    const score = energy > 0 ? correlation / energy : -Infinity;
    if (score > best) {
      best = score;
      bestLag = lag;
    }
  }
  return sampleRate / bestLag;
}

const speedToneFrames = 96_000;
const speedTonePcm = new Float32Array(speedToneFrames * 2);
for (let frame = 0; frame < speedToneFrames; frame += 1) {
  const value = 0.45 * Math.sin(2 * Math.PI * 440 * frame / 48_000);
  speedTonePcm[frame] = value;
  speedTonePcm[speedToneFrames + frame] = value;
}
const speedToneInput = join(projectRoot, 'testmedia', 'synthetic-speed-tone-input.wav');
writeFileSync(speedToneInput, wavBytes(speedTonePcm, speedToneFrames));
for (const speed of [2, 0.5, 1.7]) {
  const outputFrames = Math.round(60 / speed);
  const expectedSamples = outputFrames * 1600;
  const outputPath = join(projectRoot, 'testmedia', `synthetic-speed-tone-${String(speed).replace('.', '_')}.pcm`);
  command('ffmpeg', [
    '-v', 'error', '-y', '-i', speedToneInput,
    '-vn', '-ac', '2', '-ar', '48000',
    '-af', `${atempoFilter(speed)},apad=whole_len=${expectedSamples},atrim=end_sample=${expectedSamples}`,
    '-f', 'f32le', outputPath,
  ], `Speed ${speed} audio atempo`);
  const pcm = readInterleavedFloat32(outputPath);
  assert.equal(pcm.length, expectedSamples * 2);
  const frequency = estimateToneFrequency(pcm, 2, 48_000);
  assert.ok(Math.abs(frequency - 440) < 12, `speed ${speed} changed 440 Hz tone to ${frequency.toFixed(1)} Hz`);
}
pass('2×, 0.5×, and 1.7× atempo chains keep the 440 Hz tone and emit exact 48,000/192,000/56,000 samples');

function testClipAudio(frames, base, source = 'test tone') {
  const sampleFrames = frames * audioFrameSamples;
  const pcm = new Float32Array(sampleFrames * 2);
  for (let frame = 0; frame < frames; frame += 1) {
    pcm[frame * audioFrameSamples] = base + frame;
    pcm[sampleFrames + frame * audioFrameSamples] = -(base + frame);
  }
  return {pcm, frames, source, hasAudio: true};
}
const audioA = testClipAudio(25, 1000, 'A tone');
const audioB = testClipAudio(25, 5000, 'B tone');
const classicAudio = assembleAudioTimeline({
  clips: [audioA, audioB],
  methods: ['classic-mosh'],
  videoSampleCounts: [25, 49],
  fps: 25,
});
assert.equal(classicAudio.frames, 49);
assert.equal(classicAudio.expectedSamples, 49 * 1920);
assert.deepEqual(classicAudio.segments[1], {
  clipIndex: 1,
  method: 'classic-mosh',
  sourceFrames: 25,
  dropFrames: 1,
  availableFrames: 24,
  paddedFrames: 0,
  videoFrames: 24,
  source: 'B tone',
});
for (let frame = 0; frame < 24; frame += 1) {
  assert.equal(classicAudio.pcm[25 * 1920 + frame * 1920], audioB.pcm[(frame + 1) * 1920]);
  assert.equal(classicAudio.pcm[49 * 1920 + 25 * 1920 + frame * 1920], audioB.pcm[25 * 1920 + (frame + 1) * 1920]);
}
pass('Classic audio assembly drops exactly one incoming frame and preserves the remaining second-frame PCM samples');

const silentAudio = assembleAudioTimeline({
  clips: [audioA, {pcm: null, frames: 25, source: 'silence', hasAudio: false}],
  methods: ['classic-mosh'],
  videoSampleCounts: [25, 49],
  fps: 25,
});
for (let sample = 25 * 1920; sample < 49 * 1920; sample += 1) {
  assert.equal(silentAudio.pcm[sample], 0);
  assert.equal(silentAudio.pcm[49 * 1920 + sample], 0);
}
pass('a silent clip contributes exact stereo silence to a mixed audio timeline');

const meltAudio = assembleAudioTimeline({
  clips: [audioA, audioB],
  methods: ['melt'],
  videoSampleCounts: [25, 103],
  fps: 25,
});
assert.equal(meltAudio.segments[1].availableFrames, 25);
assert.equal(meltAudio.segments[1].paddedFrames, 53);
assert.equal(meltAudio.pcm.length, 103 * 1920 * 2);
for (let sample = 50 * 1920; sample < 103 * 1920; sample += 1) {
  assert.equal(meltAudio.pcm[sample], 0);
  assert.equal(meltAudio.pcm[103 * 1920 + sample], 0);
}
pass('Melt audio follows the linear clip timeline and pads extra picture-only frames with sample-exact silence');

const meltDurationAudio = assembleAudioTimeline({
  clips: [audioA, audioB],
  methods: [{method: 'melt', dropFrames: 1}],
  videoSampleCounts: [25, 105],
  fps: 25,
});
assert.equal(meltDurationAudio.expectedSamples, 105 * 1920);
assert.equal(meltDurationAudio.pcm.length, 105 * 1920 * 2);
assert.equal(meltDurationAudio.segments[1].dropFrames, 1);
assert.equal(meltDurationAudio.segments[1].videoFrames, 80);
assert.equal(meltDurationAudio.segments[1].paddedFrames, 56);
const meltRestoreAudio = assembleAudioTimeline({
  clips: [audioA, audioB],
  methods: [{method: 'melt', dropFrames: 1}],
  videoSampleCounts: [25, 106],
  fps: 25,
});
assert.equal(meltRestoreAudio.expectedSamples, 106 * 1920);
assert.equal(meltRestoreAudio.segments[1].videoFrames, 81);
assert.equal(meltRestoreAudio.segments[1].paddedFrames, 57);
const loopDurationAudio = assembleAudioTimeline({
  clips: [audioA, audioB],
  methods: ['loop'],
  videoSampleCounts: [25, 99],
  fps: 25,
});
assert.equal(loopDurationAudio.expectedSamples, 99 * 1920);
assert.equal(loopDurationAudio.segments[1].dropFrames, 1);
assert.equal(loopDurationAudio.segments[1].videoFrames, 74);
assert.equal(loopDurationAudio.segments[1].paddedFrames, 50);
const gentleAudio = assembleAudioTimeline({
  clips: [audioA, audioB],
  methods: [{method: 'melt', dropFrames: 1}],
  videoSampleCounts: [25, 99],
  fps: 25,
});
assert.equal(gentleAudio.expectedSamples, 99 * 1920);
assert.equal(gentleAudio.segments[1].videoFrames, 74);
assert.equal(gentleAudio.segments[1].paddedFrames, 50);
pass('Melt, Gentler Melt, and Loop duration/ending windows keep audio sample-exact with linear timeline padding');

const loopAudio = assembleAudioTimeline({
  clips: [audioA, audioB],
  methods: ['loop'],
  videoSampleCounts: [25, 49],
  fps: 25,
});
assert.equal(loopAudio.segments[1].dropFrames, 1);
assert.equal(loopAudio.segments[1].availableFrames, 24);
assert.equal(loopAudio.segments[1].paddedFrames, 0);
assert.equal(loopAudio.expectedSamples, 49 * 1920);
pass('Loop Release drops the incoming audio frame paired with the removed first IDR sample');

const resetAudio = assembleAudioTimeline({
  clips: [audioA, audioB],
  methods: ['reset-pulse'],
  videoSampleCounts: [25, 49],
  fps: 25,
});
assert.equal(resetAudio.segments[1].dropFrames, 1);
assert.equal(resetAudio.segments[1].availableFrames, 24);
assert.equal(resetAudio.segments[1].paddedFrames, 0);
pass('Reset Pulse Continue keeps incoming audio aligned after the removed first IDR frame');

assert.throws(
  () => assembleAudioTimeline({
    clips: [audioA, testClipAudio(26, 9000)],
    methods: ['cut'],
    videoSampleCounts: [25, 50],
    fps: 25,
  }),
  error => error instanceof RuntimeError && /no audio is trimmed silently/.test(error.message),
);
assert.throws(
  () => assembleAudioTimeline({
    clips: [audioA, {pcm: new Float32Array(7), frames: 25}],
    methods: ['cut'],
    videoSampleCounts: [25, 50],
    fps: 25,
  }),
  error => error instanceof RuntimeError && /does not match 25 frames/.test(error.message),
);
pass('audio/video sample mismatches raise RuntimeError instead of producing a broken export');

const testWav = wavBytes(audioA.pcm, audioA.frames * audioFrameSamples);
assert.equal(String.fromCharCode(...testWav.subarray(0, 4)), 'RIFF');
assert.equal(new DataView(testWav.buffer).getUint32(40, true), 25 * audioFrameSamples * 2 * 2);
const fakeAac = {
  chunks: [{data: Uint8Array.of(1, 2, 3)}],
  description: Uint8Array.of(0x11, 0x90),
  sampleRate: 48000,
  channels: 2,
  frameSamples: 1024,
};
const adts = buildAdts(fakeAac, 1024);
assert.equal(adts.packets, 1);
assert.equal(adts.bytes[0], 0xff);
assert.equal(adts.bytes[1], 0xf1);
assert.equal((adts.bytes[3] & 0x03) << 11 | adts.bytes[4] << 3 | adts.bytes[5] >> 5, 10);
pass('WAV fallback and ADTS AAC packetization emit exact-size payload headers');

const audioSourceBytes = new Uint8Array(readFileSync(audioFixtures.a));
const retimedAudio = retimeMuxedAudio(audioSourceBytes, 48000, 48000);
const retimedAudioMp4 = parseMp4(retimedAudio.bytes);
const retimedTrack = retimedAudioMp4.tracks.find(track => track.handler === 'soun');
assert.equal(retimedAudio.presentationSamples, 48000);
assert.equal(retimedAudio.presentationDurationSeconds, 1);
assert.equal(retimedAudio.encoderDelaySamples, 1024);
assert.equal(retimedAudio.encodedSamples, 49024);
assert.equal(retimedTrack.mdhd.duration, 49024);
assert.equal(retimedTrack.tkhd.duration, 48000);
assert.equal(retimedTrack.stts.durations.reduce((total, value) => total + value, 0), 49024);
assert.equal(audioSourceBytes.length, readFileSync(audioFixtures.a).byteLength);
assert.throws(
  () => retimeMuxedAudio(audioSourceBytes, 50000, 48000),
  error => error instanceof RuntimeError && /needs at least 51024/.test(error.message),
);
pass('muxed AAC keeps its 1024-sample encoder delay while the edit list presents exactly 48000 samples; short packets fail loudly');

for (const [key, expectedHash] of Object.entries(audioSourceHashes)) {
  assert.equal(createHash('sha256').update(readFileSync(audioFixtures[key])).digest('hex'), expectedHash, `Audio source ${key} changed`);
}
pass('audio test sources remain byte-identical after timelines, WAV construction, and ADTS packetization');

await assert.rejects(
  () => mergeEffectH264(phaseAInput, phaseBInput, phaseAParsed, phaseBParsed, {method: 'melt', repeat: 4}),
  error => /without B-frames/.test(error.message)
    && /Normalize the sequence first/.test(error.message)
    && /Cut\/Classic Mosh/.test(error.message),
);
await assert.rejects(
  () => mergeEffectH264(phaseAInput, phaseBInput, phaseAParsed, phaseBParsed, {
    method: 'reset-pulse', durationFrames: 12, resetInterval: 4, repeat: 2, ending: 'continue',
  }),
  error => /Reset Pulse requires clips without B-frames/.test(error.message)
    && /Normalize the sequence first/.test(error.message),
);
pass('Melt/Loop Release/Reset Pulse fail loudly on native B-frame clips with actionable normalization guidance');


function bytesEqual(left, right) {
  if (left.byteLength !== right.byteLength) return false;
  return left.every((value, index) => value === right[index]);
}

function preparedSequenceNals(label, bytes, parsed) {
  const nals = extractNals(bytes, parsed.videoTrack);
  const idrSamples = [...new Set(nals.filter(nal => nal.type === 5).map(nal => nal.sampleIndex))];
  const firstIdrSample = idrSamples[0];
  const nextIdrSample = idrSamples[1] ?? Number.POSITIVE_INFINITY;
  return nals
    .filter(nal => nal.sampleIndex !== firstIdrSample && ![6, 7, 8].includes(nal.type))
    .map(nal => ({
      ...nal,
      sourceLabel: label,
      patchable: nal.type === 1 && nal.sampleIndex > firstIdrSample && nal.sampleIndex < nextIdrSample,
    }));
}

function assertSequenceSampleTables(output, parsed, expectedSamples, label) {
  const track = parsed.videoTrack;
  const mdatLength = parsed.mdatRanges.reduce((total, box) => total + box.payloadEnd - box.payloadStart, 0);
  const stszSum = track.sampleSizes.sizes.reduce((total, value) => total + value, 0);
  assert.equal(track.samples.length, expectedSamples, `${label} sample count`);
  assert.equal(stszSum, mdatLength, `${label} stsz/mdat mismatch`);
  assert.equal(stszSum, track.samples.reduce((total, sample) => total + sample.size, 0));
  assert.ok(track.samples.every((sample, index, samples) => index === 0 || sample.offset > samples[index - 1].offset), `${label} offsets must increase`);
  assert.equal(track.stsc.length, 1);
  assert.equal(track.stsc[0].samplesPerChunk, expectedSamples);
  assert.equal(track.stts.sampleCount, expectedSamples);
  const duration = track.stts.durations.reduce((total, value) => total + value, 0);
  assert.equal(track.mdhd.duration, duration, `${label} mdhd/stts mismatch`);
  return {stszSum, mdatLength, duration};
}

const poc0CInput = new Uint8Array(readFileSync(multiGopFixtures.poc0C));
const poc0CParsed = parseMp4(poc0CInput);
assert.equal(poc0AParsed.videoTrack.samples.length, 25);
assert.equal(poc0BParsed.videoTrack.samples.length, 75);
assert.equal(poc0CParsed.videoTrack.samples.length, 32);
const sequenceSources = [
  ['A', poc0AInput, poc0AParsed],
  ['B', poc0BInput, poc0BParsed],
  ['C', poc0CInput, poc0CParsed],
].map(([label, bytes, parsed]) => ({label, bytes, parsed}));
const sharedSequenceTarget = chooseNormalizationTarget(...sequenceSources.map(source => source.parsed.videoTrack));
assert.deepEqual(sharedSequenceTarget, {width: 320, height: 240});
assert.deepEqual(
  chooseNormalizationTarget({width: 1440, height: 1920}, {width: 768, height: 1024}, {width: 320, height: 240}),
  {width: 540, height: 720},
);
assert.ok(Math.max(...Object.values(chooseNormalizationTarget({width: 1440, height: 1920}, {width: 768, height: 1024}, {width: 320, height: 240}))) <= MAX_TARGET_LONG_SIDE);
pass('three-clip normalization selects one identical even target and keeps 1440×1920 + 768×1024 + 320×240 at 540×720');

const tripleMosh = await mergeSequenceH264(sequenceSources.map(source => ({bytes: source.bytes, parsed: source.parsed})), ['classic-mosh', 'classic-mosh']);
assert.deepEqual(tripleMosh.report.methods, ['classic-mosh', 'classic-mosh']);
assert.equal(tripleMosh.report.clipCount, 3);
assert.equal(tripleMosh.report.sourceSamples, 132);
assert.equal(tripleMosh.report.moshBoundaries, 2);
assert.equal(tripleMosh.report.mergedSamples, 130);
assert.equal(tripleMosh.report.expectedDecodedFrames, 130);
assert.equal(tripleMosh.report.boundaries[1].frameAlignment.pictureOrderCountPatch.aLastPicOrderCntLsb, 10);
const tripleParsed = parseMp4(tripleMosh.output);
const tripleNals = extractNals(tripleMosh.output, tripleParsed.videoTrack);
const tripleAInputNals = extractNals(poc0AInput, poc0AParsed.videoTrack).map(nal => ({...nal, sourceLabel: 'A', patchable: false}));
const expectedTripleNals = [
  ...tripleAInputNals,
  ...preparedSequenceNals('B', poc0BInput, poc0BParsed),
  ...preparedSequenceNals('C', poc0CInput, poc0CParsed),
];
assert.equal(tripleNals.length, expectedTripleNals.length);
assert.deepEqual(tripleNals.map(nal => nal.type), expectedTripleNals.map(nal => nal.type));
let patchedTripleNals = 0;
let byteIdenticalRetainedNals = 0;
for (let i = 0; i < expectedTripleNals.length; i += 1) {
  const expectedNal = expectedTripleNals[i];
  if (expectedNal.patchable) {
    patchedTripleNals += 1;
    continue;
  }
  assert.deepEqual(tripleNals[i].data, expectedNal.data, `Retained ${expectedNal.sourceLabel} NAL ${i} changed`);
  byteIdenticalRetainedNals += 1;
}
assert.equal(patchedTripleNals, 48);
assert.equal(tripleMosh.report.boundaries.reduce((total, boundary) => total + boundary.frameAlignment.patchedNals, 0), 48);
const tripleIdrSamples = [...new Set(tripleNals.filter(nal => nal.type === 5).map(nal => nal.sampleIndex))];
assert.deepEqual(tripleIdrSamples, [0, 49, 74, 123]);
const tripleTables = assertSequenceSampleTables(tripleMosh.output, tripleParsed, 130, 'three-clip mosh');
pass(`three-clip Classic Mosh emits ${tripleNals.length} NAL units; ${byteIdenticalRetainedNals} retained NALs are byte-identical, ${patchedTripleNals} first-GOP slices are intentionally frame/POC aligned, and B/C IDRs at merged samples 49/74/123 remain`);

writeFileSync(sequenceMoshPath, tripleMosh.output);
const tripleProbe = command('ffprobe', [
  '-v', 'error', '-select_streams', 'v:0', '-count_frames',
  '-show_entries', 'stream=codec_name,width,height,nb_read_frames,has_b_frames',
  '-of', 'default=noprint_wrappers=1', sequenceMoshPath,
], 'three-clip mosh decode probe');
assert.match(tripleProbe.stdout, /codec_name=h264/);
assert.match(tripleProbe.stdout, /nb_read_frames=130/);
assert.match(tripleProbe.stdout, /has_b_frames=0/);
command('ffmpeg', ['-v', 'error', '-i', sequenceMoshPath, '-f', 'null', '-'], 'three-clip mosh strict decode');
pass(`three-clip chained mosh decodes ${tripleMosh.report.expectedDecodedFrames} frames (132 source samples minus 2 mosh boundaries); stsz/mdat ${tripleTables.stszSum} B and stts ${tripleTables.duration} units agree`);

const mixedSequence = await mergeSequenceH264(sequenceSources.map(source => ({bytes: source.bytes, parsed: source.parsed})), ['cut', 'classic-mosh']);
assert.deepEqual(mixedSequence.report.methods, ['cut', 'classic-mosh']);
assert.equal(mixedSequence.report.cutBoundaries, 1);
assert.equal(mixedSequence.report.moshBoundaries, 1);
assert.equal(mixedSequence.report.sourceSamples, 132);
assert.equal(mixedSequence.report.mergedSamples, 131);
assert.equal(mixedSequence.report.expectedDecodedFrames, 131);
const mixedParsed = parseMp4(mixedSequence.output);
const mixedNals = extractNals(mixedSequence.output, mixedParsed.videoTrack);
const sourceABNals = [
  ...extractNals(poc0AInput, poc0AParsed.videoTrack),
  ...extractNals(poc0BInput, poc0BParsed.videoTrack),
];
for (let i = 0; i < sourceABNals.length; i += 1) {
  assert.deepEqual(mixedNals[i].data, sourceABNals[i].data, `Cut sequence A/B NAL ${i} changed`);
}
const expectedCNals = preparedSequenceNals('C', poc0CInput, poc0CParsed);
const mixedCNals = mixedNals.slice(sourceABNals.length);
assert.equal(mixedCNals.length, expectedCNals.length);
assert.deepEqual(mixedCNals.map(nal => nal.type), expectedCNals.map(nal => nal.type));
for (let i = 0; i < expectedCNals.length; i += 1) {
  if (!expectedCNals[i].patchable) assert.deepEqual(mixedCNals[i].data, expectedCNals[i].data, `Retained C NAL ${i} changed`);
}
assert.equal(mixedSequence.report.boundaries[0].frameAlignment.reason, 'cut');
assert.equal(mixedSequence.report.boundaries[1].frameAlignment.applied, true);
const mixedTables = assertSequenceSampleTables(mixedSequence.output, mixedParsed, 131, 'mixed sequence');
writeFileSync(sequenceMixedPath, mixedSequence.output);
const mixedProbe = command('ffprobe', [
  '-v', 'error', '-select_streams', 'v:0', '-count_frames',
  '-show_entries', 'stream=nb_read_frames', '-of', 'default=noprint_wrappers=1', sequenceMixedPath,
], 'mixed Cut/Mosh decode probe');
assert.match(mixedProbe.stdout, /nb_read_frames=131/);
command('ffmpeg', ['-v', 'error', '-i', sequenceMixedPath, '-f', 'null', '-'], 'mixed Cut/Mosh strict decode');
pass(`three-clip Cut + Classic Mosh sequence keeps all A/B NALs byte-identical, decodes 131/131 frames, and maintains stsz/mdat ${mixedTables.stszSum} B with monotonic offsets`);

await assert.rejects(
  () => mergeSequenceH264([{bytes: input, parsed}, {bytes: input, parsed}], ['classic-mosh']),
  error => /Multi-GOP B frame-number alignment rejected/.test(error.message)
    && /picture reordering/.test(error.message)
    && /non-zero composition offsets/.test(error.message),
);
pass('a chained sequence with genuinely reordered multi-GOP input fails loudly and emits no merged file');



const durationFps = frameRateForTrack(parsed.videoTrack);
assert.equal(durationFps, 25);
const defaultMosh = moshH264(input, parsed);
const restoredMosh = moshH264(input, parsed, {durationFrames: 10, ending: 'restore'});
assert.equal(restoredMosh.report.duration_frames, 10);
assert.equal(restoredMosh.report.requested_duration_frames, 10);
assert.equal(restoredMosh.report.maximum_duration_frames, 49);
assert.equal(restoredMosh.report.ending, 'restore');
assert.equal(restoredMosh.report.clamped, false);
assert.deepEqual(restoredMosh.report.re_inserted_idr_positions, [36]);
assert.deepEqual(restoredMosh.report.re_inserted_idr_output_positions, [35]);
assert.equal(restoredMosh.report.outputSamples, 75);
assert.equal(restoredMosh.report.removedIdrCount, 1);

const restoredParsed = parseMp4(restoredMosh.output);
const restoredNals = extractNals(restoredMosh.output, restoredParsed.videoTrack);
const sourceBySample = new Map();
for (const nal of sourceNals) {
  const items = sourceBySample.get(nal.sampleIndex) ?? [];
  items.push(nal);
  sourceBySample.set(nal.sampleIndex, items);
}
const boundarySampleNals = sourceBySample.get(25);
const expectedRestoredNals = [];
for (const sample of parsed.videoTrack.samples) {
  if (sample.index === 25) {
    expectedRestoredNals.push(...boundarySampleNals.filter(nal => nal.type !== 5));
  } else {
    if (sample.index === 36) expectedRestoredNals.push(...boundarySampleNals);
    expectedRestoredNals.push(...(sourceBySample.get(sample.index) ?? []));
  }
}
assert.equal(restoredNals.length, expectedRestoredNals.length);
assert.deepEqual(restoredNals.map(nal => nal.type), expectedRestoredNals.map(nal => nal.type));
for (let i = 0; i < expectedRestoredNals.length; i += 1) {
  assert.deepEqual(restoredNals[i].data, expectedRestoredNals[i].data, `Restore NAL ${i} changed`);
}
const sourceBoundarySample = input.subarray(
  parsed.videoTrack.samples[25].offset,
  parsed.videoTrack.samples[25].offset + parsed.videoTrack.samples[25].size,
);
const restoredRecoverySample = restoredMosh.output.subarray(
  restoredParsed.videoTrack.samples[35].offset,
  restoredParsed.videoTrack.samples[35].offset + restoredParsed.videoTrack.samples[35].size,
);
assert.deepEqual(restoredRecoverySample, sourceBoundarySample);
assert.deepEqual(
  restoredMosh.output.subarray(restoredParsed.videoTrack.samples[50].offset, restoredParsed.videoTrack.samples[50].offset + restoredParsed.videoTrack.samples[50].size),
  input.subarray(parsed.videoTrack.samples[50].offset, parsed.videoTrack.samples[50].offset + parsed.videoTrack.samples[50].size),
);
pass('Classic Mosh restore removes only the 10-frame window IDR and re-inserts the byte-identical boundary sample at frame 11; later IDR samples remain unchanged');
pass('restore NAL sequence is exact: the boundary IDR is absent inside the window, inserted once at output sample 35, and the later original IDR is retained');

const continuedMosh = moshH264(input, parsed, {durationFrames: 10, ending: 'continue'});
assert.equal(continuedMosh.report.duration_frames, 10);
assert.equal(continuedMosh.report.ending, 'continue');
assert.deepEqual(continuedMosh.output, defaultMosh.output);
assert.equal(continuedMosh.report.outputSamples, 75);
assert.equal(continuedMosh.report.expectedDecodedFrames, 73);
pass('ending=continue with a duration set is byte-identical to the existing full-length Classic Mosh output');

const clampedMosh = moshH264(input, parsed, {durationSeconds: 100, ending: 'restore'});
assert.equal(clampedMosh.report.duration_frames, 49);
assert.equal(clampedMosh.report.requested_duration_frames, 2500);
assert.equal(clampedMosh.report.clamped, true);
assert.match(clampedMosh.report.clamp_note, /clamped to 49/);
assert.deepEqual(clampedMosh.output, defaultMosh.output);
pass('restore duration clamps to the 49 available frames, records the clamp, and matches full-length output');

const oneFrameMosh = moshH264(input, parsed, {durationFrames: 1, ending: 'restore'});
assert.equal(oneFrameMosh.report.duration_frames, 1);
assert.deepEqual(oneFrameMosh.report.re_inserted_idr_positions, [27]);
assert.equal(oneFrameMosh.report.outputSamples, 75);
assert.throws(() => moshH264(input, parsed, {durationFrames: 0}), ValueError);
assert.throws(() => moshH264(input, parsed, {durationSeconds: -1}), ValueError);
assert.throws(() => moshH264(input, parsed, {durationSeconds: 0.001}), ValueError);
pass('duration=1 is accepted; durations below one frame raise ValueError');

writeFileSync(phaseARestorePath, restoredMosh.output);
writeFileSync(phaseAContinuePath, continuedMosh.output);
const restoredProbe = command('ffprobe', [
  '-v', 'error', '-select_streams', 'v:0', '-count_frames',
  '-show_entries', 'stream=codec_name,width,height,nb_read_frames',
  '-of', 'default=noprint_wrappers=1', phaseARestorePath,
], 'Phase A restore decode probe');
const restoredDecodedFrames = Number(/nb_read_frames=(\d+)/.exec(restoredProbe.stdout)?.[1] ?? 0);
assert.equal(restoredDecodedFrames, 75);
command('ffmpeg', ['-v', 'error', '-i', phaseARestorePath, '-f', 'null', '-'], 'Phase A restore strict decode');
const continueProbe = command('ffprobe', [
  '-v', 'error', '-select_streams', 'v:0', '-count_frames',
  '-show_entries', 'stream=nb_read_frames', '-of', 'default=noprint_wrappers=1', phaseAContinuePath,
], 'Phase A continue decode probe');
const continueDecodedFrames = Number(/nb_read_frames=(\d+)/.exec(continueProbe.stdout)?.[1] ?? 0);
assert.equal(continueDecodedFrames, 73);
pass(`Phase A restore decodes all ${restoredDecodedFrames}/75 source frames; continue keeps the baseline ${continueDecodedFrames} decoded frames from its 75 declared samples`);

const pairRestore = await mergeMoshH264(
  phaseAInput,
  phaseBInput,
  phaseAParsed,
  phaseBParsed,
  {durationFrames: 10, ending: 'restore'},
);
assert.equal(pairRestore.report.duration_frames, 10);
assert.equal(pairRestore.report.ending, 'restore');
assert.equal(pairRestore.report.mergedSamples, 50);
assert.deepEqual(pairRestore.report.re_inserted_idr_positions, [11]);
assert.equal(pairRestore.report.bIdrCountRemaining, 1);
const pairRestoreParsed = parseMp4(pairRestore.output);
assert.deepEqual(
  pairRestore.output.subarray(pairRestoreParsed.videoTrack.samples[35].offset, pairRestoreParsed.videoTrack.samples[35].offset + pairRestoreParsed.videoTrack.samples[35].size),
  phaseBInput.subarray(phaseBParsed.videoTrack.samples[0].offset, phaseBParsed.videoTrack.samples[0].offset + phaseBParsed.videoTrack.samples[0].size),
);
writeFileSync(phaseBRestorePath, pairRestore.output);
const pairRestoreProbe = command('ffprobe', [
  '-v', 'error', '-select_streams', 'v:0', '-count_frames',
  '-show_entries', 'stream=nb_read_frames', '-of', 'default=noprint_wrappers=1', phaseBRestorePath,
], 'Phase B restore decode probe');
const pairRestoreFrames = Number(/nb_read_frames=(\d+)/.exec(pairRestoreProbe.stdout)?.[1] ?? 0);
assert.equal(pairRestoreFrames, phaseAParsed.videoTrack.samples.length + phaseBParsed.videoTrack.samples.length);
command('ffmpeg', ['-v', 'error', '-i', phaseBRestorePath, '-f', 'null', '-'], 'Phase B restore strict decode');
const pairContinue = await mergeMoshH264(
  phaseAInput,
  phaseBInput,
  phaseAParsed,
  phaseBParsed,
  {durationFrames: 10, ending: 'continue'},
);
assert.deepEqual(pairContinue.output, mergeResult.output);
pass(`Phase B restore re-inserts the original B IDR at merged sample 35 and decodes all ${pairRestoreFrames}/50 frames; continue remains byte-identical to the full-length merge`);

const chainedDuration = await mergeSequenceH264(
  [
    {bytes: phaseAInput, parsed: phaseAParsed},
    {bytes: phaseBInput, parsed: phaseBParsed},
    {bytes: phaseAInput, parsed: phaseAParsed},
  ],
  [
    {method: 'classic-mosh', durationFrames: 10, ending: 'restore'},
    {method: 'classic-mosh', durationFrames: 5, ending: 'continue'},
  ],
);
assert.deepEqual(chainedDuration.report.methods, ['classic-mosh', 'classic-mosh']);
assert.equal(chainedDuration.report.boundaries[0].duration_frames, 10);
assert.equal(chainedDuration.report.boundaries[0].ending, 'restore');
assert.deepEqual(chainedDuration.report.boundaries[0].re_inserted_idr_positions, [11]);
assert.equal(chainedDuration.report.boundaries[1].duration_frames, 5);
assert.equal(chainedDuration.report.boundaries[1].ending, 'continue');
assert.ok(chainedDuration.report.mergedSamples > 0);
pass('chained rendering carries independent duration/ending settings at both Classic Mosh boundaries and retains the restore IDR report');

console.log(`All tests passed. Phase A: ${input.byteLength} B → ${result.output.byteLength} B; Phase B: ${phaseAInput.byteLength} B + ${phaseBInput.byteLength} B → ${mergeResult.output.byteLength} B.`);
