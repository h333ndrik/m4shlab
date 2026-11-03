import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { parseMp4 } from '../parser/mp4.js';
import { extractNals } from '../parser/nal.js';
import { moshH264 } from '../mosh.js';
import { CompatibilityError, checkCompatibility, mergeMoshH264 } from '../merge.js';

const projectRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const fixturePath = join(projectRoot, 'testmedia', 'synthetic-h264.mp4');
const modifiedPath = join(projectRoot, 'testmedia', 'synthetic-mosh-test-output.mp4');
const phaseBFixtures = {
  a: join(projectRoot, 'testmedia', 'synthetic-b-a.mp4'),
  b: join(projectRoot, 'testmedia', 'synthetic-b-b.mp4'),
  mismatch: join(projectRoot, 'testmedia', 'synthetic-b-mismatch.mp4'),
  timescale: join(projectRoot, 'testmedia', 'synthetic-b-timescale.mp4'),
};
const mergedPath = join(projectRoot, 'testmedia', 'synthetic-b-merged-test-output.mp4');

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

const requiredFixtures = [fixturePath, ...Object.values(phaseBFixtures)];
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

console.log(`All tests passed. Phase A: ${input.byteLength} B → ${result.output.byteLength} B; Phase B: ${phaseAInput.byteLength} B + ${phaseBInput.byteLength} B → ${mergeResult.output.byteLength} B.`);
