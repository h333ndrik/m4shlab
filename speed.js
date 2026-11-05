export const SPEED_MIN = 0.1;
export const SPEED_MAX = 4.0;
export const SPEED_STEP = 0.1;
export const SPEED_OUTPUT_FPS = 30;

export class SpeedValueError extends Error {
  constructor(message) {
    super(message);
    this.name = 'SpeedValueError';
  }
}

export function normalizeSpeed(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric < SPEED_MIN || numeric > SPEED_MAX) {
    throw new SpeedValueError(`Speed must be between ${SPEED_MIN.toFixed(1)}× and ${SPEED_MAX.toFixed(1)}×.`);
  }
  const rounded = Math.round(numeric * 10) / 10;
  if (Math.abs(rounded - numeric) > 1e-9) {
    throw new SpeedValueError('Speed must use 0.1× steps.');
  }
  return rounded;
}

export function speedOutputFrameCount(sourceFrames, sourceFps, speed) {
  if (!Number.isInteger(sourceFrames) || sourceFrames < 1) throw new SpeedValueError('Speed planning needs at least one source frame.');
  if (!Number.isFinite(sourceFps) || sourceFps <= 0) throw new SpeedValueError('Speed planning needs a positive source frame rate.');
  const resolved = normalizeSpeed(speed);
  if (resolved === 1) return sourceFrames;
  return Math.max(1, Math.round(sourceFrames * SPEED_OUTPUT_FPS / (sourceFps * resolved)));
}

export function speedDonorIndex(outputIndex, sourceFrames, sourceFps, speed) {
  if (!Number.isInteger(outputIndex) || outputIndex < 0) throw new SpeedValueError('Output frame index must be a non-negative integer.');
  const resolved = normalizeSpeed(speed);
  if (resolved === 1) return Math.min(outputIndex, sourceFrames - 1);
  const donor = Math.floor(outputIndex * resolved * sourceFps / SPEED_OUTPUT_FPS);
  return Math.min(sourceFrames - 1, Math.max(0, donor));
}

export function speedFramePlan(sourceFrames, sourceFps, speed) {
  const resolved = normalizeSpeed(speed);
  const outputFrames = speedOutputFrameCount(sourceFrames, sourceFps, resolved);
  if (resolved === 1) {
    return {
      speed: resolved,
      sourceFrames,
      sourceFps,
      outputFrames,
      donorIndexes: Array.from({length: sourceFrames}, (_, index) => index),
      outputsBySource: Array.from({length: sourceFrames}, (_, index) => [index]),
    };
  }
  const donorIndexes = Array.from({length: outputFrames}, (_, index) => speedDonorIndex(index, sourceFrames, sourceFps, resolved));
  const outputsBySource = Array.from({length: sourceFrames}, () => []);
  donorIndexes.forEach((donor, outputIndex) => outputsBySource[donor].push(outputIndex));
  return {speed: resolved, sourceFrames, sourceFps, outputFrames, donorIndexes, outputsBySource};
}

export function trimFrameCount(startFrame, endFrame, sourceFrames) {
  if (!Number.isInteger(sourceFrames) || sourceFrames < 1) throw new SpeedValueError('Trim planning needs at least one source frame.');
  const start = Number.isInteger(startFrame) ? startFrame : 0;
  const end = Number.isInteger(endFrame) ? endFrame : sourceFrames;
  if (start < 0 || start >= sourceFrames) throw new SpeedValueError(`Trim start ${start} is outside the ${sourceFrames} source frames.`);
  if (end <= start || end > sourceFrames) throw new SpeedValueError(`Trim end ${end} must be greater than ${start} and at most ${sourceFrames}.`);
  return end - start;
}

export function trimSpeedPlan({sourceFrames, startFrame = 0, endFrame = sourceFrames, sourceFps, speed = 1} = {}) {
  const trimmedFrames = trimFrameCount(startFrame, endFrame, sourceFrames);
  const resolved = normalizeSpeed(speed);
  const outputFrames = speedOutputFrameCount(trimmedFrames, sourceFps, resolved);
  const relativeDonors = Array.from({length: outputFrames}, (_, index) => (
    resolved === 1
      ? Math.min(index, trimmedFrames - 1)
      : speedDonorIndex(index, trimmedFrames, sourceFps, resolved)
  ));
  const outputsBySource = Array.from({length: trimmedFrames}, () => []);
  relativeDonors.forEach((donor, outputIndex) => outputsBySource[donor].push(outputIndex));
  return {
    speed: resolved,
    sourceFrames,
    startFrame,
    endFrame,
    trimmedFrames,
    sourceFps,
    outputFrames,
    donorIndexes: relativeDonors.map(index => startFrame + index),
    outputsBySource,
  };
}

export function atempoChain(speed) {
  let remaining = normalizeSpeed(speed);
  const stages = [];
  while (remaining < 0.5 - 1e-9) {
    stages.push(0.5);
    remaining /= 0.5;
  }
  while (remaining > 2 + 1e-9) {
    stages.push(2);
    remaining /= 2;
  }
  stages.push(Math.round(remaining * 1_000_000) / 1_000_000);
  const product = stages.reduce((total, value) => total * value, 1);
  if (Math.abs(product - normalizeSpeed(speed)) > 1e-5) {
    throw new SpeedValueError(`atempo chain does not reproduce ${speed}× tempo.`);
  }
  return stages;
}

export function atempoFilter(speed) {
  return atempoChain(speed).map(value => `atempo=${value}`).join(',');
}
