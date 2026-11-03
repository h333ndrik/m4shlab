export class NalError extends Error {
  constructor(message) {
    super(message);
    this.name = 'NalError';
  }
}

function readLength(view, offset, width) {
  switch (width) {
    case 1: return view.getUint8(offset);
    case 2: return view.getUint16(offset);
    case 3: return (view.getUint8(offset) << 16) | view.getUint16(offset + 1);
    case 4: return view.getUint32(offset);
    default: throw new NalError(`Unsupported NAL length prefix width ${width}`);
  }
}

export function nalTypeName(type) {
  switch (type) {
    case 1: return 'non-IDR slice';
    case 5: return 'IDR';
    case 6: return 'SEI';
    case 7: return 'SPS';
    case 8: return 'PPS';
    default: return `NAL type ${type}`;
  }
}

export function extractNalsFromSample(bytes, sample, lengthSize) {
  if (!Number.isInteger(lengthSize) || lengthSize < 1 || lengthSize > 4) throw new NalError(`Invalid NAL length size ${lengthSize}`);
  const sampleEnd = sample.offset + sample.size;
  if (sampleEnd > bytes.byteLength) throw new NalError(`Sample ${sample.index} extends past end of file`);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const nals = [];
  let offset = sample.offset;
  let nalIndex = 0;

  while (offset < sampleEnd) {
    if (offset + lengthSize > sampleEnd) throw new NalError(`Sample ${sample.index} has a truncated NAL length prefix`);
    const dataLength = readLength(view, offset, lengthSize);
    if (dataLength === 0) throw new NalError(`Sample ${sample.index} contains an empty NAL unit`);
    const dataOffset = offset + lengthSize;
    const end = dataOffset + dataLength;
    if (end > sampleEnd) throw new NalError(`NAL ${nalIndex} in sample ${sample.index} exceeds the sample boundary`);
    const header = bytes[dataOffset];
    const type = header & 0x1f;
    nals.push({
      sampleIndex: sample.index,
      nalIndex,
      type,
      typeName: nalTypeName(type),
      refIdc: (header >> 5) & 0x03,
      start: offset,
      end,
      prefixLength: lengthSize,
      dataOffset,
      dataLength,
      data: bytes.subarray(dataOffset, end),
    });
    offset = end;
    nalIndex += 1;
  }

  return nals;
}

export function extractNals(bytes, videoTrack) {
  return videoTrack.samples.flatMap((sample) => extractNalsFromSample(bytes, sample, videoTrack.lengthSize));
}
