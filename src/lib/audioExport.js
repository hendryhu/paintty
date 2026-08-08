export const AUDIO_EXPORT_SAMPLE_RATE = 48_000;
export const AUDIO_EXPORT_CHANNELS = 2;
export const AAC_EXPORT_CODEC = 'mp4a.40.2';
export const WAV_EXPORT_MIME = 'audio/wav';
export const WAV_EXPORT_MAX_BYTES = 128 * 1024 * 1024;
export const ANIMATION_AUDIO_PEAK_MAX_BYTES = 512 * 1024 * 1024;
export const ANIMATION_AUDIO_PREFLIGHT_CHANNELS = 8;

const AAC_BITRATE = 128_000;
const AAC_PACKET_FRAMES = 1_024;
const MICROSECONDS_PER_SECOND = 1_000_000;
const WAV_HEADER_BYTES = 44;
const WAV_BYTES_PER_SAMPLE = 2;
const FLOAT32_BYTES_PER_SAMPLE = 4;

function finiteNumber(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function positiveGain(value) {
  const gain = finiteNumber(value?.gain ?? value?.volume, 1);
  return Math.max(0, gain);
}

function bufferDuration(buffer) {
  const duration = Number(buffer?.duration);
  return Number.isFinite(duration) && duration > 0 ? duration : 0;
}

function dependency(options, name, fallback) {
  return Object.prototype.hasOwnProperty.call(options, name) ? options[name] : fallback;
}

function abortError(signal) {
  if (signal?.reason instanceof Error) return signal.reason;
  if (typeof DOMException === 'function') return new DOMException('Audio export cancelled.', 'AbortError');
  const error = new Error('Audio export cancelled.');
  error.name = 'AbortError';
  return error;
}

function throwIfAborted(signal) {
  if (signal?.aborted) throw abortError(signal);
}

function abortable(promise, signal) {
  const pending = Promise.resolve(promise);
  if (!signal) return pending;
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener('abort', cancel);
      callback(value);
    };
    const cancel = () => finish(reject, abortError(signal));
    signal.addEventListener('abort', cancel, { once: true });
    pending.then(
      (value) => finish(resolve, value),
      (error) => finish(reject, error),
    );
    if (signal.aborted) cancel();
  });
}

function defaultYield() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function resourceLimitError(message) {
  const error = new RangeError(message);
  error.code = 'ANIMATION_AUDIO_RESOURCE_LIMIT';
  return error;
}

function checkedInteger(value, label) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 0) {
    throw resourceLimitError(`${label} cannot be represented safely for Animation audio export.`);
  }
  return number;
}

function checkedMultiply(label, ...values) {
  let result = 1;
  for (const value of values) {
    result *= checkedInteger(value, label);
    if (!Number.isSafeInteger(result)) {
      throw resourceLimitError(`${label} cannot be represented safely for Animation audio export.`);
    }
  }
  return result;
}

function checkedAdd(label, ...values) {
  let result = 0;
  for (const value of values) {
    result += checkedInteger(value, label);
    if (!Number.isSafeInteger(result)) {
      throw resourceLimitError(`${label} cannot be represented safely for Animation audio export.`);
    }
  }
  return result;
}

function framesForDuration(duration, label) {
  const seconds = Number(duration);
  if (!Number.isFinite(seconds) || seconds < 0) {
    throw resourceLimitError(`${label} has an invalid duration for Animation audio export.`);
  }
  const scaled = seconds * AUDIO_EXPORT_SAMPLE_RATE;
  if (!Number.isFinite(scaled) || scaled > Number.MAX_SAFE_INTEGER) {
    throw resourceLimitError(`${label} is too long to represent safely for Animation audio export.`);
  }
  return Math.ceil(scaled);
}

function copyBytes(source) {
  if (source instanceof Uint8Array) return new Uint8Array(source);
  if (ArrayBuffer.isView(source)) {
    return new Uint8Array(source.buffer.slice(source.byteOffset, source.byteOffset + source.byteLength));
  }
  return new Uint8Array(source);
}

function nestedTrackClips(tracks) {
  return tracks.flatMap((track) => (Array.isArray(track?.clips) ? track.clips : []).map((clip) => ({
    ...clip,
    trackId: clip.trackId ?? track.id,
  })));
}

function sourceDuration(asset, requireBuffer) {
  const decoded = bufferDuration(asset?.buffer);
  if (decoded || requireBuffer) return decoded;
  const duration = Number(asset?.duration);
  return Number.isFinite(duration) && duration > 0 ? duration : 0;
}

function timelineAudioCandidates({
  assets = [],
  tracks = [],
  clips,
  durationTicks = Infinity,
  requireBuffer = true,
} = {}) {
  const trackList = Array.isArray(tracks) ? tracks : [];
  const assetList = Array.isArray(assets) ? assets : [];
  const clipList = Array.isArray(clips) ? clips : nestedTrackClips(trackList);
  const trackById = new Map(trackList.map((track) => [String(track?.id), track]));
  const assetById = new Map(assetList.map((asset) => [String(asset?.id ?? asset?.assetId), asset]));
  const maximumTick = Number.isFinite(Number(durationTicks))
    ? Math.max(0, Math.round(Number(durationTicks)))
    : Infinity;
  const candidates = [];

  for (const clip of clipList) {
    if (!clip || clip.muted || clip.ready === false) continue;
    const track = trackById.get(String(clip.trackId));
    if (!track || track.muted || track.ready === false) continue;
    const asset = assetById.get(String(clip.assetId));
    const durationSeconds = sourceDuration(asset, requireBuffer);
    const gain = positiveGain(track) * positiveGain(clip);
    if (!durationSeconds || !gain || asset?.ready === false) continue;

    const startTick = Math.max(0, Math.round(finiteNumber(clip.startTick)));
    if (startTick >= maximumTick) continue;
    const rawInPoint = finiteNumber(clip.inPoint);
    const inPoint = Math.max(0, Math.min(durationSeconds, rawInPoint));
    const rawOutPoint = clip.outPoint == null
      ? durationSeconds
      : finiteNumber(clip.outPoint, durationSeconds);
    const outPoint = Math.max(inPoint, Math.min(durationSeconds, rawOutPoint));
    const duration = outPoint - inPoint;
    if (!(duration > 0)) continue;

    candidates.push({
      id: clip.id,
      trackId: track.id,
      assetId: asset.id ?? asset.assetId,
      buffer: asset.buffer,
      gain,
      inPoint,
      outPoint,
      startTick,
      duration,
    });
  }
  return candidates;
}

export function audibleTimelineAudioAssetIds(options = {}) {
  return new Set(timelineAudioCandidates({ ...options, requireBuffer: false })
    .map((clip) => String(clip.assetId)));
}

export function createTimelineAudioPlan({
  assets = [],
  tracks = [],
  clips,
  durationTicks = 0,
  fps = 24,
  sampleRate = AUDIO_EXPORT_SAMPLE_RATE,
  numberOfChannels = AUDIO_EXPORT_CHANNELS,
  exactDuration = false,
} = {}) {
  const rate = Math.max(1, finiteNumber(fps, 24));
  const outputRate = Math.max(1, Math.round(finiteNumber(sampleRate, AUDIO_EXPORT_SAMPLE_RATE)));
  const channels = Math.max(1, Math.round(finiteNumber(numberOfChannels, AUDIO_EXPORT_CHANNELS)));
  let totalTicks = Math.max(0, Math.round(finiteNumber(durationTicks)));
  const candidates = timelineAudioCandidates({
    assets,
    tracks,
    clips,
    durationTicks: exactDuration ? totalTicks : Infinity,
  });

  if (!exactDuration) {
    for (const clip of candidates) {
      totalTicks = Math.max(totalTicks, clip.startTick + Math.ceil(clip.duration * rate));
    }
  }

  if (!candidates.length || !totalTicks) return null;
  const frameCount = Math.ceil(totalTicks * outputRate / rate);
  if (!Number.isSafeInteger(frameCount) || frameCount < 1) {
    throw new RangeError('Timeline audio duration is too large to mix safely.');
  }
  const numberOfFrames = Math.max(1, frameCount);
  const plannedClips = candidates.map((clip) => {
    const startSample = Math.round(clip.startTick * outputRate / rate);
    return {
      ...clip,
      startSample,
      startTime: clip.startTick / rate,
    };
  });
  return {
    sampleRate: outputRate,
    numberOfChannels: channels,
    numberOfFrames,
    duration: totalTicks / rate,
    durationUs: Math.round(numberOfFrames * MICROSECONDS_PER_SECOND / outputRate),
    totalTicks,
    fps: rate,
    clips: plannedClips,
  };
}

function pcmFromBuffer(buffer, plan) {
  const length = Math.round(finiteNumber(buffer?.length ?? buffer?.numberOfFrames));
  const sampleRate = Math.round(finiteNumber(buffer?.sampleRate));
  const channels = Math.round(finiteNumber(buffer?.numberOfChannels));
  if (length !== plan.numberOfFrames || sampleRate !== plan.sampleRate || channels < 1 ||
    typeof buffer?.getChannelData !== 'function') {
    throw new Error('Offline audio mixing returned PCM with an unexpected format or duration.');
  }
  return {
    sampleRate: plan.sampleRate,
    numberOfChannels: plan.numberOfChannels,
    numberOfFrames: plan.numberOfFrames,
    getChannelData(channel) {
      return buffer.getChannelData(Math.min(channel, channels - 1));
    },
  };
}

function createOfflineContext(OfflineAudioContextClass, plan) {
  try {
    return new OfflineAudioContextClass({
      numberOfChannels: plan.numberOfChannels,
      length: plan.numberOfFrames,
      sampleRate: plan.sampleRate,
    });
  } catch {
    return new OfflineAudioContextClass(
      plan.numberOfChannels,
      plan.numberOfFrames,
      plan.sampleRate,
    );
  }
}

async function mixWithOfflineContext(plan, OfflineAudioContextClass, signal) {
  const context = createOfflineContext(OfflineAudioContextClass, plan);
  const nodes = [];
  const stopSources = () => {
    for (const { source } of nodes) {
      try { source.stop(0); } catch {}
    }
  };
  signal?.addEventListener('abort', stopSources, { once: true });
  try {
    for (const clip of plan.clips) {
      throwIfAborted(signal);
      const source = context.createBufferSource();
      const gain = context.createGain();
      nodes.push({ source, gain });
      source.buffer = clip.buffer;
      gain.gain.value = clip.gain;
      source.connect(gain);
      gain.connect(context.destination);
      source.start(clip.startTime, clip.inPoint, clip.duration);
    }
    const rendered = await abortable(context.startRendering(), signal);
    throwIfAborted(signal);
    return pcmFromBuffer(rendered, plan);
  } finally {
    signal?.removeEventListener('abort', stopSources);
    stopSources();
    for (const { source, gain } of nodes) {
      try { source.disconnect(); } catch {}
      try { gain.disconnect(); } catch {}
    }
  }
}

function sourceChannels(buffer) {
  const count = Math.max(0, Math.round(finiteNumber(buffer?.numberOfChannels)));
  if (!count || typeof buffer?.getChannelData !== 'function') return null;
  return Array.from({ length: count }, (_, channel) => buffer.getChannelData(channel));
}

function interpolatedSample(channel, position) {
  const left = Math.floor(position);
  if (left < 0 || left >= channel.length) return 0;
  const right = Math.min(channel.length - 1, left + 1);
  const fraction = position - left;
  return channel[left] + (channel[right] - channel[left]) * fraction;
}

async function mixPcmFallback(plan, { signal, yieldControl = defaultYield } = {}) {
  const output = Array.from(
    { length: plan.numberOfChannels },
    () => new Float32Array(plan.numberOfFrames),
  );
  let work = 0;
  for (const clip of plan.clips) {
    const channels = sourceChannels(clip.buffer);
    const sourceRate = Math.round(Number(clip.buffer?.sampleRate));
    if (!channels || !Number.isFinite(sourceRate) || sourceRate <= 0) {
      throw new Error('Offline audio mixing is unavailable for this audio source.');
    }
    const destinationFrames = Math.min(
      plan.numberOfFrames - clip.startSample,
      Math.ceil(clip.duration * plan.sampleRate),
    );
    const sourceStart = clip.inPoint * sourceRate;
    const sourceStep = sourceRate / plan.sampleRate;
    for (let index = 0; index < destinationFrames; index++) {
      const sourcePosition = sourceStart + index * sourceStep;
      for (let channel = 0; channel < plan.numberOfChannels; channel++) {
        const source = channels[Math.min(channel, channels.length - 1)];
        output[channel][clip.startSample + index] +=
          interpolatedSample(source, sourcePosition) * clip.gain;
      }
      work++;
      if (work % 16_384 === 0) {
        throwIfAborted(signal);
        await abortable(yieldControl(), signal);
      }
    }
  }
  throwIfAborted(signal);
  return {
    sampleRate: plan.sampleRate,
    numberOfChannels: plan.numberOfChannels,
    numberOfFrames: plan.numberOfFrames,
    getChannelData(channel) { return output[channel]; },
  };
}

export async function mixTimelineAudio(plan, dependencies = {}) {
  if (!plan?.clips?.length) return null;
  const { signal } = dependencies;
  throwIfAborted(signal);
  const OfflineAudioContextClass = dependency(
    dependencies,
    'OfflineAudioContextClass',
    globalThis.OfflineAudioContext || globalThis.webkitOfflineAudioContext,
  );
  if (typeof OfflineAudioContextClass === 'function') {
    return mixWithOfflineContext(plan, OfflineAudioContextClass, signal);
  }
  return mixPcmFallback(plan, dependencies);
}

function wavLayout(numberOfFrames) {
  const frames = checkedInteger(numberOfFrames, 'Mixed WAV frame count');
  const blockAlign = AUDIO_EXPORT_CHANNELS * WAV_BYTES_PER_SAMPLE;
  const dataBytes = checkedMultiply('Mixed WAV data size', frames, blockAlign);
  const fileBytes = checkedAdd('Mixed WAV file size', WAV_HEADER_BYTES, dataBytes);
  if (dataBytes > 0xffff_ffff - 36 || fileBytes > WAV_EXPORT_MAX_BYTES) {
    throw resourceLimitError(
      'Mixed WAV exceeds the 128 MiB safe export size limit. ' +
      'Shorten the sequence, trim audio, or export without audio.',
    );
  }
  return { frames, blockAlign, dataBytes, fileBytes };
}

function animationAudioUsage(sourcePcmBytes, encodedInputBytes, numberOfFrames) {
  const frames = checkedInteger(numberOfFrames, 'Animation output frame count');
  const mixPcmBytes = checkedMultiply(
    'Mixed Float32 PCM size',
    frames,
    AUDIO_EXPORT_CHANNELS,
    FLOAT32_BYTES_PER_SAMPLE,
  );
  const wav = wavLayout(frames);
  const zipCopyBytes = wav.fileBytes;
  const peakBytes = checkedAdd(
    'Animation audio peak memory estimate',
    sourcePcmBytes,
    encodedInputBytes,
    mixPcmBytes,
    wav.fileBytes,
    zipCopyBytes,
  );
  if (peakBytes > ANIMATION_AUDIO_PEAK_MAX_BYTES) {
    throw resourceLimitError(
      'Animation audio exceeds the 512 MiB safe peak-memory budget. ' +
      'Use shorter or smaller source files, trim the sequence, remove overlapping audio, ' +
      'or export without audio.',
    );
  }
  return {
    sourcePcmBytes,
    encodedInputBytes,
    mixPcmBytes,
    wavBytes: wav.fileBytes,
    zipCopyBytes,
    peakBytes,
    numberOfFrames: frames,
  };
}

function outputFrameCount(durationTicks, fps) {
  const ticks = checkedInteger(durationTicks, 'Animation duration in ticks');
  const rate = Number(fps);
  if (!Number.isFinite(rate) || rate <= 0) {
    throw resourceLimitError('Animation frame rate is invalid for audio export.');
  }
  const scaled = ticks * AUDIO_EXPORT_SAMPLE_RATE / rate;
  if (!Number.isFinite(scaled) || scaled > Number.MAX_SAFE_INTEGER) {
    throw resourceLimitError('Animation output duration is too long to represent safely.');
  }
  return Math.max(1, Math.ceil(scaled));
}

function uniqueResourceKey(asset, index) {
  return asset?.hash
    ? `${asset.hash}:${asset.generation ?? ''}`
    : String(asset?.id ?? asset?.assetId ?? index);
}

export function estimateAnimationAudioExportResources({
  assets = [],
  durationTicks = 0,
  fps = 24,
} = {}) {
  const seen = new Set();
  let sourcePcmBytes = 0;
  let encodedInputBytes = 0;
  for (let index = 0; index < assets.length; index++) {
    const asset = assets[index];
    const key = uniqueResourceKey(asset, index);
    if (seen.has(key)) continue;
    seen.add(key);
    const sourceFrames = framesForDuration(asset?.duration, `Audio source ${index + 1}`);
    const bytes = checkedMultiply(
      `Audio source ${index + 1} PCM estimate`,
      sourceFrames,
      ANIMATION_AUDIO_PREFLIGHT_CHANNELS,
      FLOAT32_BYTES_PER_SAMPLE,
    );
    sourcePcmBytes = checkedAdd('Decoded source PCM estimate', sourcePcmBytes, bytes);
    const encodedCopies = checkedMultiply(
      `Audio source ${index + 1} encoded input estimate`,
      asset?.size ?? 0,
      2,
    );
    encodedInputBytes = checkedAdd(
      'Encoded audio input estimate',
      encodedInputBytes,
      encodedCopies,
    );
  }
  return animationAudioUsage(
    sourcePcmBytes,
    encodedInputBytes,
    outputFrameCount(durationTicks, fps),
  );
}

export function validateDecodedAnimationAudioExportResources({
  assets = [],
  numberOfFrames = 0,
} = {}) {
  const seen = new Set();
  let sourcePcmBytes = 0;
  let encodedInputBytes = 0;
  for (let index = 0; index < assets.length; index++) {
    const asset = assets[index];
    const key = uniqueResourceKey(asset, index);
    if (seen.has(key)) continue;
    seen.add(key);
    const buffer = asset?.buffer;
    const channels = checkedInteger(buffer?.numberOfChannels, `Decoded audio source ${index + 1} channels`);
    const frames = checkedInteger(
      buffer?.length ?? buffer?.numberOfFrames,
      `Decoded audio source ${index + 1} frame count`,
    );
    if (channels < 1 || frames < 1) {
      throw resourceLimitError(`Decoded audio source ${index + 1} has no PCM samples.`);
    }
    const bytes = checkedMultiply(
      `Decoded audio source ${index + 1} PCM size`,
      channels,
      frames,
      FLOAT32_BYTES_PER_SAMPLE,
    );
    sourcePcmBytes = checkedAdd('Decoded source PCM size', sourcePcmBytes, bytes);
    const encodedCopies = checkedMultiply(
      `Decoded audio source ${index + 1} encoded input size`,
      asset?.size ?? 0,
      2,
    );
    encodedInputBytes = checkedAdd(
      'Encoded audio input size',
      encodedInputBytes,
      encodedCopies,
    );
  }
  return animationAudioUsage(sourcePcmBytes, encodedInputBytes, numberOfFrames);
}

function normalizedWavPcm(pcm) {
  const sampleRate = Number(pcm?.sampleRate);
  const numberOfChannels = Number(pcm?.numberOfChannels);
  const numberOfFrames = Number(pcm?.numberOfFrames ?? pcm?.length);
  const getChannelData = typeof pcm?.getChannelData === 'function'
    ? (channel) => pcm.getChannelData(Math.min(channel, numberOfChannels - 1))
    : (channel) => pcm?.channels?.[Math.min(channel, numberOfChannels - 1)];
  if (sampleRate !== AUDIO_EXPORT_SAMPLE_RATE || !Number.isSafeInteger(numberOfChannels) ||
      numberOfChannels < 1) {
    throw new Error('WAV encoding requires 48 kHz PCM with at least one channel.');
  }
  const layout = wavLayout(numberOfFrames);
  const left = getChannelData(0);
  const right = getChannelData(Math.min(1, numberOfChannels - 1));
  if (!left || !right || left.length < numberOfFrames || right.length < numberOfFrames) {
    throw new Error('WAV encoding received incomplete PCM channel data.');
  }
  return { sampleRate, numberOfChannels: AUDIO_EXPORT_CHANNELS, left, right, ...layout };
}

function writeAscii(bytes, offset, value) {
  for (let index = 0; index < value.length; index++) bytes[offset + index] = value.charCodeAt(index);
}

function signedPcm16(value) {
  const sample = Number(value);
  if (Number.isNaN(sample)) return 0;
  if (sample <= -1) return -32_768;
  if (sample >= 1) return 32_767;
  const scaled = sample < 0 ? sample * 32_768 : sample * 32_767;
  return scaled < 0 ? -Math.round(-scaled) : Math.round(scaled);
}

export async function encodePcmWav(pcmValue, dependencies = {}) {
  const { signal, onProgress = () => {}, yieldControl = defaultYield } = dependencies;
  throwIfAborted(signal);
  const pcm = normalizedWavPcm(pcmValue);
  let bytes;
  try {
    bytes = new Uint8Array(pcm.fileBytes);
  } catch (error) {
    throw new RangeError('Could not allocate the mixed WAV output.', { cause: error });
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  writeAscii(bytes, 0, 'RIFF');
  view.setUint32(4, 36 + pcm.dataBytes, true);
  writeAscii(bytes, 8, 'WAVE');
  writeAscii(bytes, 12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, AUDIO_EXPORT_CHANNELS, true);
  view.setUint32(24, AUDIO_EXPORT_SAMPLE_RATE, true);
  view.setUint32(28, AUDIO_EXPORT_SAMPLE_RATE * pcm.blockAlign, true);
  view.setUint16(32, pcm.blockAlign, true);
  view.setUint16(34, WAV_BYTES_PER_SAMPLE * 8, true);
  writeAscii(bytes, 36, 'data');
  view.setUint32(40, pcm.dataBytes, true);

  onProgress({ completed: 0, total: pcm.frames, phase: 'encoding-wav' });
  for (let frame = 0; frame < pcm.frames; frame++) {
    const offset = WAV_HEADER_BYTES + frame * pcm.blockAlign;
    view.setInt16(offset, signedPcm16(pcm.left[frame]), true);
    view.setInt16(offset + WAV_BYTES_PER_SAMPLE, signedPcm16(pcm.right[frame]), true);
    if ((frame + 1) % 16_384 === 0) {
      throwIfAborted(signal);
      onProgress({ completed: frame + 1, total: pcm.frames, phase: 'encoding-wav' });
      if (frame + 1 < pcm.frames) await abortable(yieldControl(), signal);
    }
  }
  throwIfAborted(signal);
  onProgress({ completed: pcm.frames, total: pcm.frames, phase: 'encoding-wav' });
  return bytes;
}

function unsupportedAac(message) {
  const error = new Error(message);
  error.code = 'AAC_UNSUPPORTED';
  return error;
}

function aacEncoderConfig() {
  return {
    codec: AAC_EXPORT_CODEC,
    sampleRate: AUDIO_EXPORT_SAMPLE_RATE,
    numberOfChannels: AUDIO_EXPORT_CHANNELS,
    bitrate: AAC_BITRATE,
  };
}

export async function preflightAacEncoder(dependencies = {}) {
  const { signal } = dependencies;
  throwIfAborted(signal);
  if (typeof dependencies.encodeAudio === 'function' ||
    typeof dependencies.encodeTimelineAudio === 'function') return { injected: true };
  const AudioEncoderClass = dependency(dependencies, 'AudioEncoderClass', globalThis.AudioEncoder);
  const AudioDataClass = dependency(dependencies, 'AudioDataClass', globalThis.AudioData);
  if (typeof AudioEncoderClass !== 'function') {
    throw unsupportedAac(
      'This project has audible timeline audio, but this browser does not support WebCodecs ' +
      'AudioEncoder. Use a browser with AAC AudioEncoder support, or mute/remove the audio clips ' +
      'before exporting MP4.',
    );
  }
  if (typeof AudioDataClass !== 'function' && typeof dependencies.createAudioData !== 'function') {
    throw unsupportedAac(
      'This project has audible timeline audio, but this browser cannot create WebCodecs AudioData. ' +
      'Use a browser with AAC AudioEncoder support, or mute/remove the audio clips before exporting MP4.',
    );
  }
  if (typeof AudioEncoderClass.isConfigSupported !== 'function') {
    throw unsupportedAac(
      'This browser cannot verify AAC AudioEncoder support. Use a browser that supports ' +
      'mp4a.40.2 audio, or mute/remove the audio clips before exporting MP4.',
    );
  }
  const config = aacEncoderConfig();
  const support = await abortable(AudioEncoderClass.isConfigSupported(config), signal);
  throwIfAborted(signal);
  if (!support?.supported) {
    throw unsupportedAac(
      'This browser\'s AudioEncoder does not support AAC (mp4a.40.2) at 48 kHz stereo. ' +
      'Use a browser with AAC export support, or mute/remove the audio clips before exporting MP4.',
    );
  }
  return { AudioEncoderClass, AudioDataClass, config };
}

export function aacPacketPlan(numberOfFrames, sampleRate = AUDIO_EXPORT_SAMPLE_RATE) {
  const frameCount = Math.max(0, Math.round(finiteNumber(numberOfFrames)));
  const rate = Math.max(1, Math.round(finiteNumber(sampleRate, AUDIO_EXPORT_SAMPLE_RATE)));
  const packets = [];
  for (let offset = 0; offset < frameCount; offset += AAC_PACKET_FRAMES) {
    const frames = Math.min(AAC_PACKET_FRAMES, frameCount - offset);
    const timestamp = Math.round(offset * MICROSECONDS_PER_SECOND / rate);
    const end = Math.round((offset + frames) * MICROSECONDS_PER_SECOND / rate);
    packets.push({ offset, numberOfFrames: frames, timestamp, duration: end - timestamp });
  }
  return packets;
}

function normalizedPcm(pcm) {
  const sampleRate = Math.round(finiteNumber(pcm?.sampleRate));
  const numberOfChannels = Math.round(finiteNumber(pcm?.numberOfChannels));
  const numberOfFrames = Math.round(finiteNumber(pcm?.numberOfFrames ?? pcm?.length));
  const getChannelData = typeof pcm?.getChannelData === 'function'
    ? (channel) => pcm.getChannelData(Math.min(channel, numberOfChannels - 1))
    : (channel) => pcm?.channels?.[Math.min(channel, numberOfChannels - 1)];
  if (sampleRate !== AUDIO_EXPORT_SAMPLE_RATE || numberOfChannels < 1 || numberOfFrames <= 0) {
    throw new Error('AAC encoding requires non-empty 48 kHz PCM.');
  }
  const left = getChannelData(0);
  const right = getChannelData(Math.min(1, numberOfChannels - 1));
  if (!left || !right || left.length < numberOfFrames || right.length < numberOfFrames) {
    throw new Error('AAC encoding received incomplete PCM channel data.');
  }
  return {
    sampleRate,
    numberOfChannels: AUDIO_EXPORT_CHANNELS,
    numberOfFrames,
    left,
    right,
  };
}

async function waitForEncoderCapacity(encoder, signal, yieldControl, outputError, limit = 8) {
  while (encoder.encodeQueueSize >= limit) {
    await abortable(yieldControl(), signal);
    throwIfAborted(signal);
    const error = outputError();
    if (error) throw error;
  }
}

export async function encodeAacPcm(pcmValue, dependencies = {}, supported = null) {
  const { signal, onProgress = () => {}, yieldControl = defaultYield } = dependencies;
  throwIfAborted(signal);
  const pcm = normalizedPcm(pcmValue);
  const preflight = supported?.AudioEncoderClass
    ? supported
    : await preflightAacEncoder(dependencies);
  throwIfAborted(signal);
  const packets = aacPacketPlan(pcm.numberOfFrames, pcm.sampleRate);
  const samples = [];
  let decoderConfig = null;
  let outputError = null;
  let encoderClosed = false;
  const encoder = new preflight.AudioEncoderClass({
    output(chunk, metadata) {
      const expected = packets[samples.length];
      if (!expected) {
        outputError ||= new Error('The AAC encoder produced extra audio chunks.');
        return;
      }
      if (!decoderConfig && metadata?.decoderConfig?.description) {
        decoderConfig = {
          codec: AAC_EXPORT_CODEC,
          sampleRate: AUDIO_EXPORT_SAMPLE_RATE,
          numberOfChannels: AUDIO_EXPORT_CHANNELS,
          description: copyBytes(metadata.decoderConfig.description),
        };
      }
      try {
        const data = new Uint8Array(chunk.byteLength);
        chunk.copyTo(data);
        samples.push({
          data,
          timestamp: expected.timestamp,
          duration: expected.duration,
        });
      } catch (error) {
        outputError ||= error instanceof Error ? error : new Error(String(error));
      }
    },
    error(error) {
      outputError ||= error instanceof Error ? error : new Error(String(error));
    },
  });

  const closeEncoder = () => {
    if (encoderClosed) return;
    encoderClosed = true;
    try { encoder.close?.(); } catch {}
  };
  signal?.addEventListener('abort', closeEncoder, { once: true });
  const createAudioData = dependencies.createAudioData || ((init) => (
    new preflight.AudioDataClass(init)
  ));
  try {
    encoder.configure(preflight.config || aacEncoderConfig());
    onProgress({ completed: 0, total: packets.length, phase: 'encoding-audio' });
    for (let index = 0; index < packets.length; index++) {
      throwIfAborted(signal);
      const packet = packets[index];
      const data = new Float32Array(packet.numberOfFrames * AUDIO_EXPORT_CHANNELS);
      data.set(pcm.left.subarray(packet.offset, packet.offset + packet.numberOfFrames), 0);
      data.set(
        pcm.right.subarray(packet.offset, packet.offset + packet.numberOfFrames),
        packet.numberOfFrames,
      );
      const audioData = createAudioData({
        format: 'f32-planar',
        sampleRate: AUDIO_EXPORT_SAMPLE_RATE,
        numberOfFrames: packet.numberOfFrames,
        numberOfChannels: AUDIO_EXPORT_CHANNELS,
        timestamp: packet.timestamp,
        data,
      });
      try {
        if (outputError) throw outputError;
        encoder.encode(audioData);
      } finally {
        audioData?.close?.();
      }
      await waitForEncoderCapacity(encoder, signal, yieldControl, () => outputError);
      if (outputError) throw outputError;
      onProgress({ completed: index + 1, total: packets.length, phase: 'encoding-audio' });
      if ((index + 1) % 16 === 0 && index + 1 < packets.length) {
        await abortable(yieldControl(), signal);
      }
    }
    throwIfAborted(signal);
    await abortable(encoder.flush(), signal);
  } finally {
    signal?.removeEventListener('abort', closeEncoder);
    closeEncoder();
  }

  throwIfAborted(signal);
  if (outputError) throw outputError;
  if (samples.length !== packets.length) {
    throw new Error(`The AAC encoder produced ${samples.length} of ${packets.length} audio chunks.`);
  }
  if (!decoderConfig?.description?.length) {
    throw new Error('The AAC encoder did not provide an audio decoder configuration.');
  }
  return { samples, decoderConfig };
}

function disposePcm(pcm) {
  try { pcm?.close?.(); } catch {}
}

export async function encodeTimelineWav(plan, dependencies = {}) {
  if (!plan?.clips?.length) return null;
  const { signal, onProgress = () => {} } = dependencies;
  wavLayout(plan.numberOfFrames);
  throwIfAborted(signal);
  const mix = dependencies.mixAudio || mixTimelineAudio;
  onProgress({ completed: 0, total: plan.numberOfFrames, phase: 'mixing-audio' });
  const pendingMix = Promise.resolve().then(() => mix(plan, dependencies));
  let pcm;
  try {
    pcm = await abortable(pendingMix, signal);
  } catch (error) {
    if (signal?.aborted) pendingMix.then(disposePcm).catch(() => {});
    throw error;
  }
  try {
    throwIfAborted(signal);
    onProgress({
      completed: plan.numberOfFrames,
      total: plan.numberOfFrames,
      phase: 'mixing-audio',
    });
    const encode = dependencies.encodeWav || encodePcmWav;
    return await abortable(encode(pcm, { ...dependencies, plan }), signal);
  } finally {
    disposePcm(pcm);
  }
}

export async function encodeTimelineAudio(plan, dependencies = {}, supported = null) {
  if (!plan?.clips?.length) return null;
  const { signal, onProgress = () => {} } = dependencies;
  throwIfAborted(signal);
  const mix = dependencies.mixAudio || mixTimelineAudio;
  onProgress({ completed: 0, total: plan.numberOfFrames, phase: 'mixing-audio' });
  const pendingMix = Promise.resolve().then(() => mix(plan, dependencies));
  let pcm;
  try {
    pcm = await abortable(pendingMix, signal);
  } catch (error) {
    if (signal?.aborted) pendingMix.then(disposePcm).catch(() => {});
    throw error;
  }
  try {
    throwIfAborted(signal);
    onProgress({
      completed: plan.numberOfFrames,
      total: plan.numberOfFrames,
      phase: 'mixing-audio',
    });
    const encode = dependencies.encodeAudio;
    if (typeof encode === 'function') {
      return await abortable(encode(pcm, { ...dependencies, plan, supported }), signal);
    }
    return await encodeAacPcm(pcm, dependencies, supported);
  } finally {
    disposePcm(pcm);
  }
}
