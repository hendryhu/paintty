import { get } from 'svelte/store';
import {
  DEFAULT_AUDIO_FPS, audioAssets, audioClips, audioTracks,
} from './audio.js';
import { playheadTick } from './frames.js';
import { acquireMediaResource } from './mediaRuntime.js';
import type { AudioRuntime, AudioRuntimeAsset, MediaLease } from './types/media-types.js';
import type { AudioClip, AudioTrack } from './types/project-types.js';

interface AudioLoopRange {
  startTick: number;
  endTick: number;
}

interface AudioPreviewOptions {
  fps?: number;
  tick?: number;
  loopRange?: AudioLoopRange | null;
}

interface ActiveAudioNode {
  source: AudioBufferSourceNode;
  gain: GainNode;
  lease: MediaLease<unknown> | null;
}

type PreviewAudioAsset = Partial<AudioRuntimeAsset> & { id: string };

let context: AudioContext | null = null;
let activeNodes: ActiveAudioNode[] = [];
let previewGeneration = 0;

function positiveGain(value: { gain?: unknown; volume?: unknown } | null | undefined): number {
  const gain = Number(value?.gain ?? value?.volume);
  return Number.isFinite(gain) ? Math.max(0, gain) : 1;
}

function normalizedLoopRange(range: AudioLoopRange | null | undefined): AudioLoopRange | null {
  const startTick = Number(range?.startTick);
  const endTick = Number(range?.endTick);
  return Number.isSafeInteger(startTick) && startTick >= 0 &&
    Number.isSafeInteger(endTick) && endTick >= startTick
    ? { startTick, endTick }
    : null;
}

export function planAudioPreviewClip(
  clip: Partial<AudioClip> | null | undefined,
  options: AudioPreviewOptions = {},
) {
  const rate = Math.max(1, Number(options.fps) || DEFAULT_AUDIO_FPS);
  const loopRange = normalizedLoopRange(options.loopRange);
  let tick = Math.max(0, Math.round(Number(options.tick)) || 0);
  if (loopRange && (tick < loopRange.startTick || tick > loopRange.endTick)) {
    tick = loopRange.startTick;
  }
  const timelineNow = tick / rate;
  const clipStart = Number(clip?.startTick) / rate;
  const inPoint = Number(clip?.inPoint);
  const outPoint = Number(clip?.outPoint);
  if (![clipStart, inPoint, outPoint].every(Number.isFinite) || outPoint <= inPoint) return null;
  const clipEnd = clipStart + outPoint - inPoint;
  if (clipEnd <= timelineNow) return null;
  const scheduledTimelineTime = Math.max(timelineNow, clipStart);
  const elapsed = Math.max(0, timelineNow - clipStart);
  const offset = Math.min(outPoint, inPoint + elapsed);
  let duration = Math.max(0, outPoint - offset);
  if (loopRange) {
    const loopEnd = (loopRange.endTick + 1) / rate;
    duration = Math.min(duration, Math.max(0, loopEnd - scheduledTimelineTime));
  }
  if (!duration) return null;
  return {
    delay: Math.max(0, clipStart - timelineNow),
    duration,
    offset,
    tick,
  };
}

function stopNodes(): void {
  for (const node of activeNodes) {
    try { node.source.stop(); } catch {}
    try { node.source.disconnect(); } catch {}
    try { node.gain.disconnect(); } catch {}
    node.lease?.release();
  }
  activeNodes = [];
}

export function stopAudioPreview(): void {
  previewGeneration++;
  stopNodes();
}

// One lease per decoded asset anchors all scheduled nodes using that buffer;
// superseding the preview releases unused leases before stale work can publish.
export async function startAudioPreview(options: AudioPreviewOptions = {}): Promise<boolean> {
  const generation = ++previewGeneration;
  stopNodes();
  const { fps = DEFAULT_AUDIO_FPS } = options;
  const browserGlobal = globalThis as typeof globalThis & {
    webkitAudioContext?: typeof AudioContext;
  };
  const AudioContextClass = globalThis.AudioContext || browserGlobal.webkitAudioContext;
  if (!AudioContextClass) return false;
  context ||= new AudioContextClass();
  if (context.state === 'suspended') {
    try { await context.resume(); } catch { return false; }
  }
  await Promise.resolve();
  const assets = new Map<string, PreviewAudioAsset>(
    (get(audioAssets) as AudioRuntimeAsset[]).map((asset) => [asset.id, asset]),
  );
  const tracks = new Map<string, AudioTrack>(
    (get(audioTracks) as AudioTrack[]).map((track) => [String(track.id), track]),
  );
  const playableClips = (get(audioClips) as AudioClip[]).flatMap((clip) => {
    const track = tracks.get(String(clip.trackId));
    if (!track || track.muted || clip.muted) return [];
    const effectiveGain = positiveGain(track) * positiveGain(clip);
    return effectiveGain > 0 ? [{ clip, effectiveGain }] : [];
  });
  const leases = new Map<string, MediaLease<unknown>>();
  const needed = new Set<string>(playableClips.map(({ clip }) => clip.assetId));
  await Promise.all([...needed].map(async (assetId) => {
    try {
      const lease = await acquireMediaResource(assetId);
      leases.set(assetId, lease);
      const current = assets.get(assetId) || { id: assetId };
      assets.set(assetId, { ...current, buffer: (lease.value as AudioRuntime).buffer });
    } catch {}
  }));
  if (generation !== previewGeneration) {
    for (const lease of leases.values()) lease.release();
    return false;
  }
  const rate = Math.max(1, Number(fps) || DEFAULT_AUDIO_FPS);
  const tick = options.tick ?? get(playheadTick);
  const deadline = context.currentTime + 0.03;
  for (const { clip, effectiveGain } of playableClips) {
    const asset = assets.get(clip.assetId);
    if (!asset?.buffer) continue;
    const schedule = planAudioPreviewClip(clip, {
      fps: rate,
      tick,
      ...(options.loopRange !== undefined ? { loopRange: options.loopRange } : {}),
    });
    if (!schedule) continue;
    const source = context.createBufferSource();
    const gain = context.createGain();
    source.buffer = asset.buffer;
    gain.gain.value = effectiveGain;
    source.connect(gain).connect(context.destination);
    source.start(deadline + schedule.delay, schedule.offset, schedule.duration);
    activeNodes.push({ source, gain, lease: leases.get(clip.assetId) || null });
    leases.delete(clip.assetId);
  }
  for (const lease of leases.values()) lease.release();
  return true;
}

export async function closeAudioPreview(): Promise<void> {
  stopAudioPreview();
  if (context) {
    try { await context.close(); } catch {}
    context = null;
  }
}
