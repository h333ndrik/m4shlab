export const RANDOM_METHODS = Object.freeze(['classic-mosh', 'melt', 'loop', 'reset-pulse']);
export const RANDOM_MIN_DURATION = 12;
export const RANDOM_MAX_DURATION = 144;
export const RANDOM_MAX_ATTEMPTS = 20;

export class RandomizeError extends Error {
  constructor(message) {
    super(message);
    this.name = 'RandomizeError';
  }
}

export function normalizeSeed(seed) {
  if (typeof seed !== 'string' || !/^[0-9a-f]{16}$/i.test(seed)) {
    throw new RandomizeError('Random seed must be exactly 16 hexadecimal characters.');
  }
  return seed.toLowerCase();
}

export function seedToUint32(seed) {
  const normalized = normalizeSeed(seed);
  const high = Number.parseInt(normalized.slice(0, 8), 16);
  const low = Number.parseInt(normalized.slice(8), 16);
  return (high ^ low) >>> 0;
}

export function mulberry32(seed) {
  let state = seedToUint32(seed);
  return function next() {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 0x100000000;
  };
}

function randomInteger(next, min, max) {
  return min + Math.floor(next() * (max - min + 1));
}

function choose(next, values) {
  return values[Math.floor(next() * values.length)];
}

function allowedMethodsFor(values) {
  if (!Array.isArray(values) || values.length === 0) return [...RANDOM_METHODS];
  return [...new Set(values)].filter(method => RANDOM_METHODS.includes(method));
}

export function minimumRandomDuration(fps) {
  if (!Number.isFinite(fps) || fps <= 0) throw new RandomizeError('Randomization needs a positive clip frame rate.');
  return Math.max(RANDOM_MIN_DURATION, Math.ceil(fps * 0.5));
}

export function canRandomize({availableFrames, fps, methods = RANDOM_METHODS} = {}) {
  try {
    const allowed = allowedMethodsFor(methods);
    if (allowed.length === 0) return false;
    if (!Number.isInteger(availableFrames) || availableFrames < minimumRandomDuration(fps)) return false;
    return true;
  } catch {
    return false;
  }
}

export function validateRandomTransition(settings, {availableFrames, fps} = {}) {
  if (!settings || !RANDOM_METHODS.includes(settings.method)) throw new RandomizeError('Randomized method is not a mosh method.');
  if (!Number.isInteger(availableFrames) || availableFrames < RANDOM_MIN_DURATION) {
    throw new RandomizeError(`At least ${RANDOM_MIN_DURATION} frames after the first GOP boundary are required to randomize.`);
  }
  if (!Number.isFinite(fps) || fps <= 0) throw new RandomizeError('Randomization needs a positive clip frame rate.');
  const maximum = Math.min(RANDOM_MAX_DURATION, availableFrames);
  if (!Number.isInteger(settings.durationFrames)
    || settings.durationFrames < RANDOM_MIN_DURATION
    || settings.durationFrames > maximum) {
    throw new RandomizeError(`Randomized duration must be ${RANDOM_MIN_DURATION}–${maximum} frames.`);
  }
  if (settings.durationFrames / fps < 0.5) throw new RandomizeError('Aligned mosh methods need at least 0.5 seconds.');
  if (settings.ending !== 'restore' && settings.ending !== 'continue') throw new RandomizeError('Randomized ending is invalid.');
  if (settings.method === 'melt') {
    if (!Number.isInteger(settings.repeat) || settings.repeat < 2 || settings.repeat > 12) throw new RandomizeError('Randomized Melt repeat must be 2–12.');
  } else if (settings.method === 'loop') {
    if (!Number.isInteger(settings.loopFrames) || settings.loopFrames < 2 || settings.loopFrames >= settings.durationFrames || settings.loopFrames > 48) {
      throw new RandomizeError('Randomized Loop frames must be 2–48 and shorter than the duration.');
    }
  } else if (settings.method === 'reset-pulse') {
    if (!Number.isInteger(settings.resetInterval) || settings.resetInterval < 4 || settings.resetInterval >= settings.durationFrames || settings.resetInterval > 48) {
      throw new RandomizeError('Randomized Reset interval must be 4–48 and shorter than the duration.');
    }
    if (!Number.isInteger(settings.repeat) || settings.repeat < 2 || settings.repeat > 12) throw new RandomizeError('Randomized Reset repeat must be 2–12.');
  }
  return settings;
}

export function randomizeTransition({seed, availableFrames, fps, methods = RANDOM_METHODS} = {}) {
  const normalizedSeed = normalizeSeed(seed);
  const allowed = allowedMethodsFor(methods);
  if (allowed.length === 0) throw new RandomizeError('No technically valid mosh method is available for this boundary.');
  if (!Number.isInteger(availableFrames) || availableFrames < minimumRandomDuration(fps)) {
    throw new RandomizeError(`Randomize needs at least ${minimumRandomDuration(fps)} frames after the first GOP boundary (0.5 seconds and ${RANDOM_MIN_DURATION}-frame minimum).`);
  }
  const maximumDuration = Math.min(RANDOM_MAX_DURATION, availableFrames);
  const next = mulberry32(normalizedSeed);
  let lastError = null;
  for (let attempt = 0; attempt < RANDOM_MAX_ATTEMPTS; attempt += 1) {
    const method = choose(next, allowed);
    const durationFrames = randomInteger(next, RANDOM_MIN_DURATION, maximumDuration);
    const ending = next() < 0.5 ? 'restore' : 'continue';
    const settings = {method, durationFrames, ending, repeat: null, loopFrames: null, resetInterval: null, smooth: false, attempts: attempt + 1};
    if (method === 'melt') settings.repeat = randomInteger(next, 2, 12);
    if (method === 'loop') settings.loopFrames = randomInteger(next, 2, Math.min(48, durationFrames - 1));
    if (method === 'reset-pulse') {
      settings.resetInterval = randomInteger(next, 4, Math.min(48, durationFrames - 1));
      settings.repeat = randomInteger(next, 2, 12);
    }
    try {
      validateRandomTransition(settings, {availableFrames, fps});
      return {...settings, randomSeed: normalizedSeed};
    } catch (error) {
      lastError = error;
    }
  }
  throw new RandomizeError(`No valid randomized combination was found after ${RANDOM_MAX_ATTEMPTS} attempts${lastError ? `: ${lastError.message}` : '.'}`);
}
