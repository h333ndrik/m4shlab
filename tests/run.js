import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { parseMp4 } from '../parser/mp4.js';
import { extractNals } from '../parser/nal.js';
import { moshH264 } from '../mosh.js';

const projectRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const fixturePath = join(projectRoot, 'testmedia', 'synthetic-h264.mp4');
const modifiedPath = join(projectRoot, 'testmedia', 'synthetic-mosh-test-output.mp4');

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

if (!existsSync(fixturePath)) {
  console.log('Fixture missing; generating testmedia/synthetic-h264.mp4 with ffmpeg.');
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

console.log(`All tests passed. Source ${input.byteLength} B; modified ${result.output.byteLength} B.`);
