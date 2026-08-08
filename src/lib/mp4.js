const MAX_U32 = 0xffffffff;
const MICROSECONDS_PER_SECOND = 1_000_000;

function bytes(value, name) {
  if (value instanceof Uint8Array) return value;
  if (ArrayBuffer.isView(value)) {
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  }
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  throw new TypeError(`${name} must be an ArrayBuffer or typed array.`);
}

function ascii(value) {
  const result = new Uint8Array(value.length);
  for (let i = 0; i < value.length; i++) result[i] = value.charCodeAt(i);
  return result;
}

function uint16(...values) {
  const result = new Uint8Array(values.length * 2);
  const view = new DataView(result.buffer);
  for (let i = 0; i < values.length; i++) view.setUint16(i * 2, values[i]);
  return result;
}

function uint24(...values) {
  const result = new Uint8Array(values.length * 3);
  for (let i = 0; i < values.length; i++) {
    result[i * 3] = (values[i] >>> 16) & 0xff;
    result[i * 3 + 1] = (values[i] >>> 8) & 0xff;
    result[i * 3 + 2] = values[i] & 0xff;
  }
  return result;
}

function uint32(...values) {
  const result = new Uint8Array(values.length * 4);
  const view = new DataView(result.buffer);
  for (let i = 0; i < values.length; i++) view.setUint32(i * 4, values[i]);
  return result;
}

function join(...parts) {
  const size = parts.reduce((sum, part) => sum + part.byteLength, 0);
  const result = new Uint8Array(size);
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.byteLength;
  }
  return result;
}

function box(type, ...payloads) {
  if (type.length !== 4) throw new Error(`Invalid MP4 box type: ${type}`);
  const size = 8 + payloads.reduce((sum, payload) => sum + payload.byteLength, 0);
  if (size > MAX_U32) throw new RangeError(`${type} box exceeds the MP4 size limit.`);
  return join(uint32(size), ascii(type), ...payloads);
}

function fullBox(type, version, flags, ...payloads) {
  return box(type, new Uint8Array([
    version,
    (flags >>> 16) & 0xff,
    (flags >>> 8) & 0xff,
    flags & 0xff,
  ]), ...payloads);
}

function matrix() {
  return uint32(
    0x00010000, 0, 0,
    0, 0x00010000, 0,
    0, 0, 0x40000000,
  );
}

function compressorName(value) {
  const name = ascii(value.slice(0, 31));
  const result = new Uint8Array(32);
  result[0] = name.byteLength;
  result.set(name, 1);
  return result;
}

function movieHeader(timescale, duration, nextTrackId) {
  return fullBox('mvhd', 0, 0,
    uint32(0, 0, timescale, duration, 0x00010000),
    uint16(0x0100, 0),
    uint32(0, 0),
    matrix(),
    uint32(0, 0, 0, 0, 0, 0, nextTrackId),
  );
}

function trackHeader(trackId, width, height, duration, volume) {
  return fullBox('tkhd', 0, 0x000007,
    uint32(0, 0, trackId, 0, duration, 0, 0),
    uint16(0, 0, volume, 0),
    matrix(),
    uint32(width * 0x10000, height * 0x10000),
  );
}

function mediaHeader(timescale, duration) {
  return fullBox('mdhd', 0, 0,
    uint32(0, 0, timescale, duration),
    uint16(0x55c4, 0),
  );
}

function handler(type, name) {
  return fullBox('hdlr', 0, 0,
    uint32(0),
    ascii(type),
    uint32(0, 0, 0),
    ascii(`${name}\0`),
  );
}

function dataInformation() {
  const url = fullBox('url ', 0, 1);
  const dref = fullBox('dref', 0, 0, uint32(1), url);
  return box('dinf', dref);
}

function videoSampleDescription(width, height, decoderConfig) {
  const avc1 = box('avc1',
    new Uint8Array(6),
    uint16(1, 0, 0),
    uint32(0, 0, 0),
    uint16(width, height),
    uint32(0x00480000, 0x00480000, 0),
    uint16(1),
    compressorName('Paintty AVC'),
    uint16(0x0018, 0xffff),
    box('avcC', decoderConfig),
  );
  return fullBox('stsd', 0, 0, uint32(1), avc1);
}

function videoSampleTable(samples, width, height, decoderConfig, chunkOffset) {
  const sizes = samples.map((sample) => sample.data.byteLength);
  const syncSamples = [];
  for (let i = 0; i < samples.length; i++) {
    if (samples[i].key) syncSamples.push(i + 1);
  }
  return box('stbl',
    videoSampleDescription(width, height, decoderConfig),
    fullBox('stts', 0, 0, uint32(1, samples.length, 1)),
    fullBox('stsc', 0, 0, uint32(1, 1, samples.length, 1)),
    fullBox('stsz', 0, 0, uint32(0, samples.length, ...sizes)),
    fullBox('stco', 0, 0, uint32(1, chunkOffset)),
    fullBox('stss', 0, 0, uint32(syncSamples.length, ...syncSamples)),
  );
}

function videoTrack(samples, decoderConfig, width, height, timescale, chunkOffset) {
  const duration = samples.length;
  const vmhd = fullBox('vmhd', 0, 1, uint16(0, 0, 0, 0));
  const minf = box('minf',
    vmhd,
    dataInformation(),
    videoSampleTable(samples, width, height, decoderConfig, chunkOffset),
  );
  const mdia = box('mdia', mediaHeader(timescale, duration), handler('vide', 'VideoHandler'), minf);
  return box('trak', trackHeader(1, width, height, duration, 0), mdia);
}

function descriptor(tag, ...payloads) {
  const payload = join(...payloads);
  if (payload.byteLength > 0x0fffffff) {
    throw new RangeError('MPEG-4 descriptor exceeds the supported size limit.');
  }
  const size = [payload.byteLength & 0x7f];
  let remaining = payload.byteLength >>> 7;
  while (remaining) {
    size.unshift((remaining & 0x7f) | 0x80);
    remaining >>>= 7;
  }
  return join(new Uint8Array([tag, ...size]), payload);
}

function elementaryStreamDescriptor(decoderConfig) {
  const decoderSpecificInfo = descriptor(0x05, decoderConfig);
  const decoderConfigDescriptor = descriptor(0x04,
    new Uint8Array([0x40, 0x15]),
    uint24(0),
    uint32(0, 0),
    decoderSpecificInfo,
  );
  return descriptor(0x03,
    uint16(2),
    new Uint8Array([0]),
    decoderConfigDescriptor,
    descriptor(0x06, new Uint8Array([2])),
  );
}

function audioSampleDescription(audio) {
  const esds = fullBox('esds', 0, 0, elementaryStreamDescriptor(audio.decoderConfig));
  const mp4a = box('mp4a',
    new Uint8Array(6),
    uint16(1),
    uint32(0, 0),
    uint16(audio.numberOfChannels, 16, 0, 0),
    uint32(audio.sampleRate * 0x10000),
    esds,
  );
  return fullBox('stsd', 0, 0, uint32(1), mp4a);
}

function timeToSample(durations) {
  const entries = [];
  for (const duration of durations) {
    const last = entries[entries.length - 1];
    if (last?.duration === duration) last.count++;
    else entries.push({ count: 1, duration });
  }
  return fullBox('stts', 0, 0, uint32(
    entries.length,
    ...entries.flatMap((entry) => [entry.count, entry.duration]),
  ));
}

function audioSampleTable(audio, chunkOffset) {
  const sizes = audio.samples.map((sample) => sample.data.byteLength);
  return box('stbl',
    audioSampleDescription(audio),
    timeToSample(audio.samples.map((sample) => sample.duration)),
    fullBox('stsc', 0, 0, uint32(1, 1, audio.samples.length, 1)),
    fullBox('stsz', 0, 0, uint32(0, audio.samples.length, ...sizes)),
    fullBox('stco', 0, 0, uint32(1, chunkOffset)),
  );
}

function audioTrack(audio, movieDuration, chunkOffset) {
  const smhd = fullBox('smhd', 0, 0, uint16(0, 0));
  const minf = box('minf', smhd, dataInformation(), audioSampleTable(audio, chunkOffset));
  const mdia = box('mdia',
    mediaHeader(audio.sampleRate, audio.duration),
    handler('soun', 'SoundHandler'),
    minf,
  );
  return box('trak', trackHeader(2, 0, 0, movieDuration, 0x0100), mdia);
}

function movie(video, audio, videoChunkOffset, audioChunkOffset) {
  const audioMovieDuration = audio
    ? scaledDuration(audio.duration, audio.sampleRate, video.timescale)
    : 0;
  const duration = Math.max(video.samples.length, audioMovieDuration);
  return box('moov',
    movieHeader(video.timescale, duration, audio ? 3 : 2),
    videoTrack(
      video.samples,
      video.decoderConfig,
      video.width,
      video.height,
      video.timescale,
      videoChunkOffset,
    ),
    ...(audio ? [audioTrack(audio, audioMovieDuration, audioChunkOffset)] : []),
  );
}

function positiveInteger(value, name, maximum = MAX_U32) {
  if (!Number.isInteger(value) || value <= 0 || value > maximum) {
    throw new RangeError(`${name} must be a positive integer no greater than ${maximum}.`);
  }
}

function scaledDuration(duration, sourceTimescale, targetTimescale) {
  const result = (
    BigInt(duration) * BigInt(targetTimescale) + BigInt(sourceTimescale) - 1n
  ) / BigInt(sourceTimescale);
  if (result > BigInt(MAX_U32)) {
    throw new RangeError('Audio track duration exceeds the MP4 duration limit.');
  }
  return Number(result);
}

function audioTime(timestamp, sampleRate) {
  const result = (
    BigInt(timestamp) * BigInt(sampleRate) + BigInt(MICROSECONDS_PER_SECOND / 2)
  ) / BigInt(MICROSECONDS_PER_SECOND);
  if (result > BigInt(MAX_U32)) {
    throw new RangeError('Audio track duration exceeds the MP4 duration limit.');
  }
  return Number(result);
}

function audioSampleBytes(sample, name) {
  if (sample?.data !== undefined) return bytes(sample.data, `${name}.data`);
  if (typeof sample?.copyTo === 'function' && Number.isInteger(sample.byteLength)) {
    if (sample.byteLength < 0 || sample.byteLength > MAX_U32) {
      throw new RangeError(`${name}.byteLength must be between 0 and ${MAX_U32}.`);
    }
    const result = new Uint8Array(sample.byteLength);
    sample.copyTo(result);
    return result;
  }
  throw new TypeError(`${name} must provide data or be an EncodedAudioChunk-like value.`);
}

function normalizeAudio(audio) {
  if (audio == null) return null;
  if (typeof audio !== 'object' || Array.isArray(audio)) {
    throw new TypeError('audio must be an object.');
  }
  if (!Array.isArray(audio.samples) || audio.samples.length === 0) {
    throw new RangeError('audio.samples must contain at least one encoded AAC chunk.');
  }
  positiveInteger(audio.samples.length, 'audio sample count');
  const config = audio.decoderConfig;
  if (!config || typeof config !== 'object' || Array.isArray(config)) {
    throw new TypeError('audio.decoderConfig must be an AudioDecoderConfig-like object.');
  }
  if (config.codec != null && (
    typeof config.codec !== 'string' || !/^mp4a\.40\.\d+$/i.test(config.codec)
  )) {
    throw new RangeError('audio.decoderConfig.codec must identify MPEG-4 AAC audio.');
  }
  positiveInteger(config.sampleRate, 'audio.decoderConfig.sampleRate', 0xffff);
  positiveInteger(config.numberOfChannels, 'audio.decoderConfig.numberOfChannels', 0xffff);
  const decoderConfig = bytes(config.description, 'audio.decoderConfig.description');
  if (decoderConfig.byteLength === 0) {
    throw new RangeError('audio.decoderConfig.description cannot be empty.');
  }

  let previousEndTime = 0;
  const samples = audio.samples.map((sample, index) => {
    const name = `audio.samples[${index}]`;
    if (!Number.isSafeInteger(sample?.timestamp) || sample.timestamp < 0) {
      throw new RangeError(`${name}.timestamp must be a non-negative integer number of microseconds.`);
    }
    if (!Number.isSafeInteger(sample?.duration) || sample.duration <= 0) {
      throw new RangeError(`${name}.duration must be a positive integer number of microseconds.`);
    }
    if (index === 0 && sample.timestamp !== 0) {
      throw new RangeError('audio.samples must start at timestamp 0.');
    }
    const startTime = audioTime(sample.timestamp, config.sampleRate);
    if (startTime !== previousEndTime) {
      throw new RangeError('audio.samples must form a contiguous timeline.');
    }
    const endTimestamp = sample.timestamp + sample.duration;
    if (!Number.isSafeInteger(endTimestamp)) {
      throw new RangeError(`${name} ends outside the supported timestamp range.`);
    }
    const endTime = audioTime(endTimestamp, config.sampleRate);
    const duration = endTime - startTime;
    if (duration <= 0) {
      throw new RangeError(`${name}.duration is shorter than one audio timescale tick.`);
    }
    const data = audioSampleBytes(sample, name);
    if (data.byteLength === 0) throw new RangeError(`${name}.data cannot be empty.`);
    previousEndTime = endTime;
    return { data, duration };
  });

  return {
    samples,
    decoderConfig,
    sampleRate: config.sampleRate,
    numberOfChannels: config.numberOfChannels,
    duration: previousEndTime,
  };
}

/**
 * Mux AVC samples with an optional, already mixed AAC track. Audio samples may
 * be EncodedAudioChunk objects or { data, timestamp, duration } records, using
 * WebCodecs microsecond timing. audio.decoderConfig accepts codec, sampleRate,
 * numberOfChannels, and description from AudioEncoder output metadata.
 */
export function muxH264Mp4({
  samples,
  avcDecoderConfig,
  width,
  height,
  timescale,
  audio,
}) {
  if (!Array.isArray(samples) || samples.length === 0) {
    throw new RangeError('samples must contain at least one encoded frame.');
  }
  positiveInteger(width, 'width', 0xffff);
  positiveInteger(height, 'height', 0xffff);
  positiveInteger(timescale, 'timescale');
  positiveInteger(samples.length, 'sample count');
  const decoderConfig = bytes(avcDecoderConfig, 'avcDecoderConfig');
  if (decoderConfig.byteLength === 0) {
    throw new RangeError('avcDecoderConfig cannot be empty.');
  }
  const normalizedSamples = samples.map((sample, index) => {
    const data = bytes(sample?.data, `samples[${index}].data`);
    if (data.byteLength === 0) throw new RangeError(`samples[${index}].data cannot be empty.`);
    return { data, key: Boolean(sample.key) };
  });
  if (!normalizedSamples[0].key) {
    throw new RangeError('The first encoded frame must be a keyframe.');
  }

  const normalizedAudio = normalizeAudio(audio);
  const video = {
    samples: normalizedSamples,
    decoderConfig,
    width,
    height,
    timescale,
  };

  const ftyp = box('ftyp', ascii('isom'), uint32(0x200), ascii('isomiso6avc1mp41'));
  let moov = movie(video, normalizedAudio, 0, 0);
  const videoMediaSize = normalizedSamples.reduce((sum, sample) => sum + sample.data.byteLength, 0);
  const audioMediaSize = normalizedAudio?.samples.reduce(
    (sum, sample) => sum + sample.data.byteLength,
    0,
  ) ?? 0;
  const videoChunkOffset = ftyp.byteLength + moov.byteLength + 8;
  const audioChunkOffset = videoChunkOffset + videoMediaSize;
  if (videoChunkOffset > MAX_U32 || audioChunkOffset > MAX_U32) {
    throw new RangeError('MP4 chunk offset exceeds 32 bits.');
  }
  moov = movie(video, normalizedAudio, videoChunkOffset, audioChunkOffset);

  const mediaSize = videoMediaSize + audioMediaSize;
  const mdatSize = mediaSize + 8;
  const fileSize = ftyp.byteLength + moov.byteLength + mdatSize;
  if (mdatSize > MAX_U32 || fileSize > MAX_U32) {
    throw new RangeError('MP4 output exceeds the 32-bit container size limit.');
  }

  const output = new Uint8Array(fileSize);
  let offset = 0;
  output.set(ftyp, offset);
  offset += ftyp.byteLength;
  output.set(moov, offset);
  offset += moov.byteLength;
  output.set(uint32(mdatSize), offset);
  output.set(ascii('mdat'), offset + 4);
  offset += 8;
  for (const sample of normalizedSamples) {
    output.set(sample.data, offset);
    offset += sample.data.byteLength;
  }
  for (const sample of normalizedAudio?.samples ?? []) {
    output.set(sample.data, offset);
    offset += sample.data.byteLength;
  }
  return output;
}
