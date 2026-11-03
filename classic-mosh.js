export class ValueError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ValueError';
  }
}

const DEFAULT_ENDING = 'restore';

export function frameRateForTrack(track) {
  const timescale = track?.mdhd?.timescale;
  const durations = track?.stts?.durations ?? [];
  if (!Number.isFinite(timescale) || timescale <= 0 || durations.length === 0) {
    throw new ValueError('The video track has no usable timing table for duration control.');
  }
  const counts = new Map();
  for (const duration of durations) {
    if (duration > 0) counts.set(duration, (counts.get(duration) ?? 0) + 1);
  }
  let commonDuration = 0;
  let commonCount = 0;
  for (const [duration, count] of counts) {
    if (count > commonCount || (count === commonCount && duration < commonDuration)) {
      commonDuration = duration;
      commonCount = count;
    }
  }
  if (commonDuration <= 0) throw new ValueError('The video track has no positive frame duration.');
  const fps = timescale / commonDuration;
  return Math.round(fps * 1000) / 1000;
}

export function maxMoshFrames(track, boundarySampleIndex) {
  return Math.max(0, (track?.samples?.length ?? 0) - boundarySampleIndex - 1);
}

export function resolveClassicMoshSettings(track, boundarySampleIndex, options = {}) {
  const ending = options.ending ?? DEFAULT_ENDING;
  if (ending !== 'restore' && ending !== 'continue') {
    throw new ValueError('ending must be "restore" or "continue".');
  }

  const fps = frameRateForTrack(track);
  const maximumFrames = maxMoshFrames(track, boundarySampleIndex);
  let requestedFrames;
  if (options.durationFrames !== undefined) {
    requestedFrames = Number(options.durationFrames);
    if (!Number.isFinite(requestedFrames)) {
      if (requestedFrames === Number.POSITIVE_INFINITY) requestedFrames = maximumFrames;
      else throw new ValueError('duration_frames must be a finite number.');
    }
    requestedFrames = Math.round(requestedFrames);
    if (requestedFrames <= 0) throw new ValueError('duration must be greater than zero.');
  } else {
    const durationSeconds = options.durationSeconds ?? options.duration;
    if (durationSeconds === undefined || durationSeconds === null) {
      requestedFrames = maximumFrames;
    } else {
      const seconds = Number(durationSeconds);
      if (Number.isNaN(seconds)) throw new ValueError('duration must be a number of seconds.');
      if (seconds <= 0) throw new ValueError('duration must be greater than zero.');
      if (Number.isFinite(seconds)) {
        requestedFrames = Math.round(seconds * fps);
        if (requestedFrames < 1) throw new ValueError('duration must be at least one frame.');
      } else {
        requestedFrames = maximumFrames;
      }
    }
  }

  const durationFrames = Math.min(maximumFrames, Math.max(0, requestedFrames));
  return {
    fps,
    maximumFrames,
    requestedFrames,
    durationFrames,
    durationSeconds: fps > 0 ? durationFrames / fps : 0,
    clamped: requestedFrames > maximumFrames,
    ending,
    recoverySampleIndex: boundarySampleIndex + durationFrames + 1,
  };
}

export function countPictureSamples(bytes, track) {
  const pictureNalTypes = new Set([1, 5]);
  return track.samples.filter(sample => {
    const sampleBytes = bytes.subarray(sample.offset, sample.offset + sample.size);
    const view = new DataView(sampleBytes.buffer, sampleBytes.byteOffset, sampleBytes.byteLength);
    let offset = 0;
    while (offset + track.lengthSize <= sampleBytes.byteLength) {
      const length = track.lengthSize === 1 ? view.getUint8(offset)
        : track.lengthSize === 2 ? view.getUint16(offset)
          : track.lengthSize === 3 ? ((view.getUint8(offset) << 16) | view.getUint16(offset + 1))
            : view.getUint32(offset);
      const start = offset + track.lengthSize;
      const end = start + length;
      if (length === 0 || end > sampleBytes.byteLength) break;
      if (pictureNalTypes.has(sampleBytes[start] & 0x1f)) return true;
      offset = end;
    }
    return false;
  }).length;
}
