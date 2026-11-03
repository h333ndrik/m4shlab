import { normalizeSpeed } from './speed.js';

export const LOOKS = Object.freeze([
  {value: 'original', label: 'Original'},
  {value: 'black-white', label: 'Black & white'},
  {value: 'black-white-negative', label: 'B&W negative'},
  {value: 'color-negative', label: 'Color negative'},
]);

const LOOK_VALUES = new Set(LOOKS.map(look => look.value));

export class LookValueError extends Error {
  constructor(message) {
    super(message);
    this.name = 'LookValueError';
  }
}

export function normalizeLook(value = 'original') {
  const look = String(value || 'original');
  if (!LOOK_VALUES.has(look)) throw new LookValueError(`Unknown clip look "${look}".`);
  return look;
}

export function applyLookToRgba(rgba, look = 'original', width = null, height = null) {
  if (!(rgba instanceof Uint8Array || rgba instanceof Uint8ClampedArray)) {
    throw new TypeError('applyLookToRgba expects an RGBA byte array.');
  }
  if (rgba.byteLength % 4 !== 0) throw new LookValueError('RGBA input length must be divisible by four.');
  const resolved = normalizeLook(look);
  if (width !== null || height !== null) {
    if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1 || width * height * 4 !== rgba.byteLength) {
      throw new LookValueError('RGBA dimensions do not match the supplied pixel buffer.');
    }
  }
  if (resolved === 'original') return rgba;

  for (let offset = 0; offset < rgba.byteLength; offset += 4) {
    if (resolved === 'color-negative') {
      rgba[offset] = 255 - rgba[offset];
      rgba[offset + 1] = 255 - rgba[offset + 1];
      rgba[offset + 2] = 255 - rgba[offset + 2];
      continue;
    }
    const luma = Math.round(0.299 * rgba[offset] + 0.587 * rgba[offset + 1] + 0.114 * rgba[offset + 2]);
    const value = resolved === 'black-white-negative' ? 255 - luma : luma;
    rgba[offset] = value;
    rgba[offset + 1] = value;
    rgba[offset + 2] = value;
  }
  return rgba;
}

export function normalizationCacheKey({sourceKey = '', target, speed = 1, look = 'original'} = {}) {
  if (!target || !Number.isFinite(target.width) || !Number.isFinite(target.height)) {
    throw new LookValueError('A normalization cache key needs finite target dimensions.');
  }
  const width = Math.max(2, Math.round(target.width));
  const height = Math.max(2, Math.round(target.height));
  return `${String(sourceKey)}|${width}x${height}|${normalizeSpeed(speed).toFixed(1)}|${normalizeLook(look)}`;
}
