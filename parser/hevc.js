export class HevcError extends Error {
  constructor(message) {
    super(message);
    this.name = 'HevcError';
  }
}

export const HEVC_IRAP_MIN = 16;
export const HEVC_IRAP_MAX = 23;

function u16(bytes, offset) {
  if (offset + 2 > bytes.byteLength) throw new HevcError('Truncated HEVC length field.');
  return (bytes[offset] << 8) | bytes[offset + 1];
}

function reverseBits32(value) {
  let output = value >>> 0;
  output = ((output & 0x55555555) << 1) | ((output >>> 1) & 0x55555555);
  output = ((output & 0x33333333) << 2) | ((output >>> 2) & 0x33333333);
  output = ((output & 0x0f0f0f0f) << 4) | ((output >>> 4) & 0x0f0f0f0f);
  output = ((output & 0x00ff00ff) << 8) | ((output >>> 8) & 0x00ff00ff);
  return ((output << 16) | (output >>> 16)) >>> 0;
}

export function hevcCodecString(entryType, config) {
  const spaces = ['', 'A', 'B', 'C'];
  const profileSpace = spaces[config.profileSpace] ?? '';
  const tier = config.tierFlag ? 'H' : 'L';
  const compatibility = reverseBits32(config.compatibilityFlags).toString(16).toUpperCase();
  const constraints = [...config.constraintFlags];
  while (constraints.length > 0 && constraints[constraints.length - 1] === 0) constraints.pop();
  const suffix = constraints.length ? `.${constraints.map(value => value.toString(16).toUpperCase().padStart(2, '0')).join('.')}` : '';
  return `${entryType}.${profileSpace}${config.profileIdc}.${compatibility}.${tier}${config.levelIdc}${suffix}`;
}

export function parseHevcConfig(bytes, hvcC, entryType = 'hvc1') {
  const start = hvcC.payloadStart;
  const end = hvcC.payloadEnd;
  if (end - start < 23) throw new HevcError('Truncated hvcC configuration');
  if (bytes[start] !== 1) throw new HevcError(`Unsupported hvcC configuration version ${bytes[start]}`);
  const lengthSize = (bytes[start + 21] & 0x03) + 1;
  if (lengthSize === 3) throw new HevcError('Invalid HEVC NAL length size');
  const profileSpace = (bytes[start + 1] >> 6) & 0x03;
  const tierFlag = (bytes[start + 1] >> 5) & 0x01;
  const profileIdc = bytes[start + 1] & 0x1f;
  const compatibilityFlags = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(start + 2);
  const constraintFlags = bytes.slice(start + 6, start + 12);
  const levelIdc = bytes[start + 12];
  const arrayCount = bytes[start + 22];
  let offset = start + 23;
  const arrays = [];
  for (let arrayIndex = 0; arrayIndex < arrayCount; arrayIndex += 1) {
    if (offset >= end) throw new HevcError('Truncated hvcC NAL array header');
    const header = bytes[offset++];
    const nalUnitType = header & 0x3f;
    const count = u16(bytes, offset);
    offset += 2;
    const nals = [];
    for (let index = 0; index < count; index += 1) {
      const length = u16(bytes, offset);
      offset += 2;
      if (offset + length > end) throw new HevcError('Truncated hvcC NAL payload');
      nals.push(bytes.subarray(offset, offset + length));
      offset += length;
    }
    arrays.push({completeness: (header >> 7) & 1, nalUnitType, nals});
  }
  const config = {
    profileSpace,
    tierFlag,
    profileIdc,
    compatibilityFlags,
    constraintFlags,
    levelIdc,
    lengthSize,
    arrays,
    raw: bytes.subarray(start, end),
  };
  return {...config, codecString: hevcCodecString(entryType, config)};
}

export function hevcNalUnitType(nalHeader) {
  return (nalHeader >> 1) & 0x3f;
}

export function isHevcIrap(nalUnitType) {
  return nalUnitType >= HEVC_IRAP_MIN && nalUnitType <= HEVC_IRAP_MAX;
}

export function extractHevcNalsFromSample(bytes, sample, lengthSize) {
  if (!Number.isInteger(lengthSize) || ![1, 2, 4].includes(lengthSize)) throw new HevcError(`Invalid HEVC NAL length size ${lengthSize}`);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const end = sample.offset + sample.size;
  const nals = [];
  let offset = sample.offset;
  let nalIndex = 0;
  while (offset < end) {
    if (offset + lengthSize > end) throw new HevcError(`Sample ${sample.index} has a truncated HEVC length prefix`);
    const length = lengthSize === 1 ? view.getUint8(offset) : lengthSize === 2 ? view.getUint16(offset) : view.getUint32(offset);
    const start = offset + lengthSize;
    const nalEnd = start + length;
    if (length === 0 || nalEnd > end) throw new HevcError(`Sample ${sample.index} contains an invalid HEVC NAL length`);
    const unitType = hevcNalUnitType(bytes[start]);
    nals.push({
      sampleIndex: sample.index,
      nalIndex,
      unitType,
      typeName: unitType === 19 ? 'IDR_W_RADL' : unitType === 20 ? 'IDR_N_LP' : unitType === 21 ? 'CRA' : `HEVC NAL ${unitType}`,
      start: offset,
      end: nalEnd,
      dataOffset: start,
      dataLength: length,
    });
    offset = nalEnd;
    nalIndex += 1;
  }
  return nals;
}

export function extractHevcNals(bytes, track) {
  return track.samples.flatMap(sample => extractHevcNalsFromSample(bytes, sample, track.lengthSize));
}
