import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { childBoxes, parseBoxes, parseMp4 } from '../parser/mp4.js';
import { extractNals } from '../parser/nal.js';
import { moshH264 } from '../mosh.js';
import { CompatibilityError, checkCompatibility, mergeMoshH264, parseAvcConfig } from '../merge.js';
import { buildNormalizedMp4, chooseNormalizationTarget } from '../webcodecs-muxer.js';
import { MAX_TARGET_LONG_SIDE, capNormalizationDimensions } from '../conversion-settings.js';
import { parseSps } from '../parser/sps.js';

const projectRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const fixturePath = join(projectRoot, 'testmedia', 'synthetic-h264.mp4');
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
const multiGopFixtures = {
  a: join(projectRoot, 'testmedia', 'synthetic-multigop-a.mp4'),
  b: join(projectRoot, 'testmedia', 'synthetic-multigop-b.mp4'),
  poc0A: join(projectRoot, 'testmedia', 'synthetic-multigop-poc0-a.mp4'),
  poc0B: join(projectRoot, 'testmedia', 'synthetic-multigop-poc0-b.mp4'),
};
const mergedPath = join(projectRoot, 'testmedia', 'synthetic-b-merged-test-output.mp4');
const multiGopMergedPath = join(projectRoot, 'testmedia', 'synthetic-multigop-merged-test-output.mp4');
const multiGopPoc0MergedPath = join(projectRoot, 'testmedia', 'synthetic-multigop-poc0-merged-test-output.mp4');
const normalizedMuxPath = join(projectRoot, 'testmedia', 'synthetic-webcodecs-mux-output.mp4');

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

const requiredFixtures = [fixturePath, ...Object.values(tierOneFixtures), ...Object.values(phaseBFixtures), ...Object.values(multiGopFixtures)];
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

console.log(`All tests passed. Phase A: ${input.byteLength} B → ${result.output.byteLength} B; Phase B: ${phaseAInput.byteLength} B + ${phaseBInput.byteLength} B → ${mergeResult.output.byteLength} B.`);
