export class SpsError extends Error {
  constructor(message) {
    super(message);
    this.name = 'SpsError';
  }
}

function removeEmulationPrevention(bytes) {
  const output = new Uint8Array(bytes.byteLength);
  let length = 0;
  let zeros = 0;
  for (let i = 0; i < bytes.byteLength; i += 1) {
    const value = bytes[i];
    if (zeros >= 2 && value === 3) {
      zeros = 0;
      continue;
    }
    output[length++] = value;
    zeros = value === 0 ? zeros + 1 : 0;
  }
  return output.subarray(0, length);
}

class BitReader {
  constructor(bytes) {
    this.bytes = bytes;
    this.bit = 0;
  }

  readBit() {
    if (this.bit >= this.bytes.byteLength * 8) throw new SpsError('Truncated SPS bitstream');
    const value = (this.bytes[this.bit >> 3] >> (7 - (this.bit & 7))) & 1;
    this.bit += 1;
    return value;
  }

  readBits(count) {
    let value = 0;
    for (let i = 0; i < count; i += 1) value = (value * 2) + this.readBit();
    return value;
  }

  readUnsignedExpGolomb() {
    let leadingZeros = 0;
    while (this.readBit() === 0) {
      leadingZeros += 1;
      if (leadingZeros > 31) throw new SpsError('Invalid SPS Exp-Golomb value');
    }
    if (leadingZeros === 0) return 0;
    return (2 ** leadingZeros) - 1 + this.readBits(leadingZeros);
  }

  readSignedExpGolomb() {
    const value = this.readUnsignedExpGolomb();
    const magnitude = Math.ceil(value / 2);
    return value % 2 === 0 ? -magnitude : magnitude;
  }
}

function skipScalingList(reader, size) {
  let lastScale = 8;
  let nextScale = 8;
  for (let i = 0; i < size; i += 1) {
    if (nextScale !== 0) {
      const delta = reader.readSignedExpGolomb();
      nextScale = (lastScale + delta + 256) % 256;
    }
    lastScale = nextScale === 0 ? lastScale : nextScale;
  }
}

export function parseSps(nalBytes) {
  if (!(nalBytes instanceof Uint8Array) || nalBytes.byteLength < 4) throw new SpsError('Truncated SPS NAL unit');
  if ((nalBytes[0] & 0x1f) !== 7) throw new SpsError('Expected an SPS NAL unit');
  const rbsp = removeEmulationPrevention(nalBytes.subarray(1));
  const reader = new BitReader(rbsp);
  const profileIdc = rbsp[0];
  const constraintFlags = rbsp[1];
  const levelIdc = rbsp[2];
  reader.readBits(24);
  const sequenceParameterSetId = reader.readUnsignedExpGolomb();
  let chromaFormatIdc = 1;
  let separateColourPlaneFlag = 0;
  let bitDepthLuma = 8;
  let bitDepthChroma = 8;
  const highProfiles = new Set([44, 83, 86, 100, 110, 118, 122, 128, 134, 135, 138, 139, 244]);

  if (highProfiles.has(profileIdc)) {
    chromaFormatIdc = reader.readUnsignedExpGolomb();
    if (chromaFormatIdc === 3) separateColourPlaneFlag = reader.readBit();
    bitDepthLuma = reader.readUnsignedExpGolomb() + 8;
    bitDepthChroma = reader.readUnsignedExpGolomb() + 8;
    reader.readBit();
    if (reader.readBit()) {
      const scalingListCount = chromaFormatIdc === 3 ? 12 : 8;
      for (let i = 0; i < scalingListCount; i += 1) {
        if (reader.readBit()) skipScalingList(reader, i < 6 ? 16 : 64);
      }
    }
  }

  reader.readUnsignedExpGolomb();
  const picOrderCountType = reader.readUnsignedExpGolomb();
  if (picOrderCountType === 0) {
    reader.readUnsignedExpGolomb();
  } else if (picOrderCountType === 1) {
    reader.readBit();
    reader.readSignedExpGolomb();
    reader.readSignedExpGolomb();
    const cycle = reader.readUnsignedExpGolomb();
    for (let i = 0; i < cycle; i += 1) reader.readSignedExpGolomb();
  }
  reader.readUnsignedExpGolomb();
  reader.readBit();
  const picWidthInMbsMinus1 = reader.readUnsignedExpGolomb();
  const picHeightInMapUnitsMinus1 = reader.readUnsignedExpGolomb();
  const frameMbsOnlyFlag = reader.readBit();
  if (!frameMbsOnlyFlag) reader.readBit();
  reader.readBit();
  let cropLeft = 0;
  let cropRight = 0;
  let cropTop = 0;
  let cropBottom = 0;
  if (reader.readBit()) {
    cropLeft = reader.readUnsignedExpGolomb();
    cropRight = reader.readUnsignedExpGolomb();
    cropTop = reader.readUnsignedExpGolomb();
    cropBottom = reader.readUnsignedExpGolomb();
  }

  const chromaArrayType = separateColourPlaneFlag ? 0 : chromaFormatIdc;
  const subWidthC = chromaArrayType === 1 || chromaArrayType === 2 ? 2 : 1;
  const subHeightC = chromaArrayType === 1 ? 2 : 1;
  const cropUnitX = chromaArrayType === 0 ? 1 : subWidthC;
  const cropUnitY = (chromaArrayType === 0 ? 1 : subHeightC) * (2 - frameMbsOnlyFlag);
  const width = ((picWidthInMbsMinus1 + 1) * 16) - (cropUnitX * (cropLeft + cropRight));
  const height = ((2 - frameMbsOnlyFlag) * (picHeightInMapUnitsMinus1 + 1) * 16) - (cropUnitY * (cropTop + cropBottom));

  return {
    profileIdc,
    constraintFlags,
    levelIdc,
    sequenceParameterSetId,
    chromaFormatIdc,
    separateColourPlaneFlag,
    bitDepthLuma,
    bitDepthChroma,
    width,
    height,
    frameMbsOnlyFlag,
  };
}
