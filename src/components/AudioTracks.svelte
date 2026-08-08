<script>
  import Icon from './Icon.svelte';
  import { isTopPopup, popupFocus } from '../lib/popupFocus.js';
  import {
    audioAssets, audioClipDurationTicks, audioClips, audioTracks, removeAudioClip,
    splitAudioClipAtTick, updateAudioClip,
  } from '../lib/audio.js';
  import { beginStroke, cancelStroke, endStroke, noteAuthoredMutation } from '../lib/grid.js';
  import {
    durationTicks as visualDurationTicks, fps as fpsStore, playheadTick,
  } from '../lib/frames.js';
  import { playing as playbackActive } from '../lib/playbackState.js';
  import {
    createTickPixelTransform, pixelToTick, tickToPixel,
  } from '../lib/timelineViewport.js';
  import { readThemeColor } from '../lib/themeColors.js';

  /**
   * @typedef {Object} Props
   * @property {number} [frameWidth]
   * @property {(event: PointerEvent) => void} [onpointerdown]
   */

  /** @type {Props} */
  let { frameWidth = 22, onpointerdown } = $props();

  let selectedClipId = $state(null);
  let stopDrag = null;
  let volumeEditing = $state(false);
  let volumeMutated = false;
  let volumeDraft = $state(100);
  let clipMenu = $state(null);
  let clipMenuEl = $state();

  let selectedClip = $derived($audioClips.find((clip) => clip.id === selectedClipId) || null);
  let selectedAsset = $derived(selectedClip
    ? $audioAssets.find((asset) => asset.id === selectedClip.assetId) || null
    : null);
  $effect.pre(() => {
    if (selectedClip && !volumeEditing) volumeDraft = Math.round(selectedClip.volume * 100);
  });
  let tickTransform = $derived(createTickPixelTransform({ pixelsPerTick: Math.max(1, frameWidth) }));
  let audioDurationTicks = $derived($audioClips.reduce((endTick, clip) => Math.max(
    endTick,
    clip.startTick + audioClipDurationTicks(clip, $fpsStore),
  ), 0));
  let timelineDurationTicks = $derived(Math.max(1, $visualDurationTicks, audioDurationTicks));

  function clipSpan(clip) {
    return Math.max(1, audioClipDurationTicks(clip, $fpsStore));
  }

  function clipLeft(clip) {
    return tickToPixel(clip.startTick, tickTransform);
  }

  function clipWidth(clip) {
    return tickToPixel(clip.startTick + clipSpan(clip), tickTransform) - clipLeft(clip);
  }

  function startEdit(event, clip, kind) {
    if ($playbackActive || event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    selectedClipId = clip.id;
    stopDrag?.();
    beginStroke();
    const pointerId = event.pointerId;
    const x0 = event.clientX;
    const original = { ...clip };
    const endTick = clip.startTick + clipSpan(clip);
    let mutated = false;
    const move = (next) => {
      if (next.pointerId !== pointerId) return;
      const delta = Math.round(
        pixelToTick(next.clientX, tickTransform) - pixelToTick(x0, tickTransform),
      );
      const rate = Math.max(1, Number($fpsStore) || 24);
      const before = $audioClips.find((value) => value.id === clip.id);
      let updated = null;
      if (kind === 'move') {
        updated = updateAudioClip(clip.trackId, clip.id, {
          startTick: Math.max(0, original.startTick + delta),
        });
      } else if (kind === 'start') {
        const sourceStartTick = original.startTick - Math.floor(original.inPoint * rate);
        const startTick = Math.max(
          0,
          sourceStartTick,
          Math.min(endTick - 1, original.startTick + delta),
        );
        const sourceDelta = (startTick - original.startTick) / rate;
        updated = updateAudioClip(clip.trackId, clip.id, {
          startTick,
          inPoint: Math.min(original.outPoint, original.inPoint + sourceDelta),
        });
      } else {
        const sourceEndTick = original.startTick + Math.ceil(
          Math.max(0, original.duration - original.inPoint) * rate,
        );
        const nextEnd = Math.max(
          original.startTick + 1,
          Math.min(sourceEndTick, endTick + delta),
        );
        updated = updateAudioClip(clip.trackId, clip.id, {
          outPoint: Math.min(original.duration, original.outPoint + (nextEnd - endTick) / rate),
        });
      }
      if (updated && before && (
        updated.startTick !== before.startTick ||
        updated.inPoint !== before.inPoint ||
        updated.outPoint !== before.outPoint
      )) mutated = true;
    };
    const finish = (next, cancelled = false) => {
      if (next?.pointerId != null && next.pointerId !== pointerId) return;
      stopDrag?.(cancelled);
    };
    stopDrag = (cancelled = true) => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', finish);
      window.removeEventListener('pointercancel', cancel);
      window.removeEventListener('blur', cancel);
      if (cancelled) cancelStroke();
      else {
        if (mutated) noteAuthoredMutation();
        endStroke();
      }
      stopDrag = null;
    };
    const cancel = (next) => finish(next, true);
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', finish);
    window.addEventListener('pointercancel', cancel);
    window.addEventListener('blur', cancel);
  }

  function setVolume(value) {
    if (!selectedClip) return;
    if (!volumeEditing) {
      beginStroke();
      volumeEditing = true;
      volumeMutated = false;
    }
    const before = selectedClip.volume;
    const updated = updateAudioClip(selectedClip.trackId, selectedClip.id, { volume: value / 100 });
    if (updated && updated.volume !== before) volumeMutated = true;
  }

  function beginVolumeEdit() {
    if (volumeEditing) return;
    beginStroke();
    volumeEditing = true;
    volumeMutated = false;
  }

  function endVolumeEdit(cancelled = false) {
    if (!volumeEditing) return;
    if (cancelled) cancelStroke();
    else {
      if (volumeMutated) noteAuthoredMutation();
      endStroke();
    }
    volumeEditing = false;
    volumeMutated = false;
  }

  function toggleMute() {
    if (!selectedClip) return;
    beginStroke();
    updateAudioClip(selectedClip.trackId, selectedClip.id, { muted: !selectedClip.muted });
    noteAuthoredMutation();
    endStroke();
  }

  function splitClip() {
    if (!selectedClip) return;
    beginStroke();
    const split = splitAudioClipAtTick(
      selectedClip.trackId, selectedClip.id, $playheadTick, $fpsStore,
    );
    if (split) {
      selectedClipId = split.right.id;
      noteAuthoredMutation();
      endStroke();
    } else cancelStroke();
  }

  function deleteClip() {
    if (!selectedClip) return;
    beginStroke();
    removeAudioClip(selectedClip.trackId, selectedClip.id);
    noteAuthoredMutation();
    endStroke();
    selectedClipId = null;
    clipMenu = null;
  }

  function openClipMenu(event, clip) {
    if ($playbackActive) return;
    event.preventDefault();
    event.stopPropagation();
    selectedClipId = clip.id;
    clipMenu = {
      x: Math.min(event.clientX, window.innerWidth - 190),
      y: Math.min(event.clientY, window.innerHeight - 176),
    };
  }

  function openTrackMenu(event, track) {
    const clip = $audioClips.find((value) => value.trackId === track.id);
    if (!clip) return;
    const rect = event.currentTarget.getBoundingClientRect();
    openClipMenu({
      ...event,
      clientX: rect.right + 4,
      clientY: rect.top,
      preventDefault() {},
      stopPropagation() {},
    }, clip);
  }

  function closeMenu(event) {
    if (!event.target.closest?.('.audio-menu')) clipMenu = null;
  }

  function stopMenuPointerDown(event) {
    event.stopPropagation();
    onpointerdown?.(event);
  }

  function waveform(node, params) {
    let current = params;
    const color = readThemeColor('--waveform', node);
    const draw = () => {
      const { buffer, inPoint = 0, outPoint = buffer?.duration || 0 } = current || {};
      const rect = node.getBoundingClientRect();
      const ratio = Math.max(1, window.devicePixelRatio || 1);
      const width = Math.max(1, Math.round(rect.width * ratio));
      const height = Math.max(1, Math.round(rect.height * ratio));
      if (node.width !== width) node.width = width;
      if (node.height !== height) node.height = height;
      const ctx = node.getContext('2d');
      ctx.clearRect(0, 0, width, height);
      if (!buffer?.length || !buffer.numberOfChannels) return;
      const from = Math.max(0, Math.floor(inPoint * buffer.sampleRate));
      const to = Math.min(buffer.length, Math.ceil(outPoint * buffer.sampleRate));
      const span = Math.max(1, to - from);
      const channel = buffer.getChannelData(0);
      ctx.fillStyle = color;
      for (let x = 0; x < width; x++) {
        const start = from + Math.floor(x * span / width);
        const end = Math.max(start + 1, from + Math.floor((x + 1) * span / width));
        let min = 1, max = -1;
        for (let sample = start; sample < Math.min(end, to); sample++) {
          const value = channel[sample] || 0;
          min = Math.min(min, value);
          max = Math.max(max, value);
        }
        const y1 = (1 - max) * height / 2;
        const y2 = (1 - min) * height / 2;
        ctx.fillRect(x, y1, 1, Math.max(1, y2 - y1));
      }
    };
    const observer = typeof ResizeObserver === 'function' ? new ResizeObserver(draw) : null;
    observer?.observe(node);
    draw();
    return {
      update(next) { current = next; draw(); },
      destroy() { observer?.disconnect(); },
    };
  }
</script>

<svelte:window onpointerdown={closeMenu} onkeydown={(event) => {
  if (event.key === 'Escape' && isTopPopup(clipMenuEl)) clipMenu = null;
}} />

{#if $audioTracks.length}
  {#each $audioTracks as track (track.id)}
    <div class="audio-row" aria-label={`Audio track ${track.name}`}
      style={`width:${132 + timelineDurationTicks * frameWidth}px`}>
      <div class="track-name" class:active={selectedClip?.trackId === track.id}>
        <button class="track-select"
          onclick={() => (selectedClipId = $audioClips.find((clip) => clip.trackId === track.id)?.id || null)}
          title={track.name}><Icon icon="material-symbols:volume-up-outline" /><span>{track.name}</span></button>
        <button class="track-more" aria-label={`Audio actions for ${track.name}`}
          disabled={$playbackActive} onclick={(event) => openTrackMenu(event, track)}>
          <Icon icon="material-symbols:more-horiz" />
        </button>
      </div>
      <div class="lane" style={`width:${timelineDurationTicks * frameWidth}px;--tick-width:${frameWidth}px`}>
        {#each $audioClips.filter((clip) => clip.trackId === track.id) as clip (clip.id)}
          {@const asset = $audioAssets.find((value) => value.id === clip.assetId)}
          <div class="clip" class:selected={selectedClipId === clip.id} class:missing={!asset?.buffer}
            class:muted={clip.muted}
            role="button" tabindex="0"
            style={`left:${clipLeft(clip)}px;width:${clipWidth(clip)}px;--gain:${Math.round(clip.volume * 100)}%`}
            onpointerdown={(event) => startEdit(event, clip, 'move')}
            oncontextmenu={(event) => openClipMenu(event, clip)}
            title={`${asset?.sourceName || track.name} · drag to move · right-click for actions`}>
            <canvas class="waveform" use:waveform={{ buffer: asset?.buffer, inPoint: clip.inPoint, outPoint: clip.outPoint }}></canvas>
            <span class="gain-line"></span>
            <button class="trim start" aria-label={`Trim in ${track.name}`} disabled={$playbackActive}
              onpointerdown={(event) => startEdit(event, clip, 'start')}></button>
            <span class="clip-label">{asset?.sourceName || 'Missing audio'}</span>
            <button class="trim end" aria-label={`Trim out ${track.name}`} disabled={$playbackActive}
              onpointerdown={(event) => startEdit(event, clip, 'end')}></button>
          </div>
        {/each}
      </div>
    </div>
  {/each}
  {#if clipMenu && selectedClip}
    <div class="audio-menu" role="menu" tabindex="-1" bind:this={clipMenuEl}
      use:popupFocus={{ initialFocus: 'button:not([disabled])' }}
      style={`left:${clipMenu.x}px;top:${clipMenu.y}px`} onpointerdown={stopMenuPointerDown}>
      <strong>{selectedAsset?.sourceName || 'Missing audio'}</strong>
      <button onclick={splitClip} disabled={$playbackActive}><Icon icon="material-symbols:content-cut" /> Split at playhead</button>
      <button onclick={toggleMute} disabled={$playbackActive}>
        <Icon icon={selectedClip.muted ? 'material-symbols:volume-up-outline' : 'material-symbols:volume-off-outline'} />
        {selectedClip.muted ? 'Unmute' : 'Mute'}
      </button>
      <label class="volume-label">Gain
        <input type="range" min="0" max="100" step="1" aria-label="Audio clip volume"
          bind:value={volumeDraft} disabled={$playbackActive} onpointerdown={beginVolumeEdit}
          oninput={(event) => setVolume(Number(event.currentTarget.value))}
          onchange={() => endVolumeEdit()} onblur={() => endVolumeEdit()} />
        <output>{Math.round(selectedClip.volume * 100)}%</output>
      </label>
      <button class="danger" onclick={deleteClip} disabled={$playbackActive}>
        <Icon icon="material-symbols:delete-outline" /> Delete clip
      </button>
    </div>
  {/if}
{/if}

<style>
  .audio-row { display: grid; grid-template-columns: 132px auto; height: 42px;
    min-width: max-content; border-bottom: 1px solid var(--border); background: var(--panel); }
  .track-name { display: flex; align-items: center; min-width: 0; color: var(--text-dim);
    background: var(--panel-hi); border-right: 1px solid var(--border); }
  .track-name.active { color: var(--text); box-shadow: inset 2px 0 var(--accent); }
  .track-select { display: flex; align-items: center; gap: 6px; min-width: 0; flex: 1;
    height: 100%; padding: 0 4px 0 8px; border: 0; background: transparent; color: inherit; }
  .track-select span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .track-more { width: 24px; height: 24px; flex: 0 0 24px; padding: 0; border: 0;
    background: transparent; color: var(--text-dim); }
  .track-more:hover:not(:disabled) { color: var(--text); background: var(--hover); }
  .lane { position: relative; min-width: 22px; background: var(--panel); }
  .lane::before { content: ''; position: absolute; inset: 0; pointer-events: none;
    background: repeating-linear-gradient(90deg, transparent 0 calc(var(--tick-width) - 1px),
      var(--border-subtle) calc(var(--tick-width) - 1px) var(--tick-width)); }
  .clip { position: absolute; top: 4px; bottom: 4px; display: flex; align-items: center;
    justify-content: space-between; min-width: 18px; overflow: hidden;
    border: 1px solid var(--audio-panel-clip-border); border-radius: 2px;
    background: var(--audio-panel-clip-surface); color: var(--audio-panel-clip-text);
    cursor: grab; font-size: 10px; }
  .clip.selected { border-color: var(--accent); outline: 1px solid var(--accent); }
  .clip.missing { border-color: var(--missing-clip-border); background: repeating-linear-gradient(135deg,
    var(--missing-clip-surface-a) 0 6px, var(--missing-clip-surface-b) 6px 12px); color: var(--missing-clip-text); }
  .clip.muted { opacity: 0.55; }
  .waveform { position: absolute; inset: 2px 5px; width: calc(100% - 10px); height: calc(100% - 4px); }
  .gain-line { position: absolute; left: 5px; right: 5px; top: calc(100% - var(--gain));
    border-top: 1px solid var(--audio-gain-line); pointer-events: none; }
  .clip-label { position: relative; z-index: 1; max-width: calc(100% - 16px); padding: 0 3px;
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap; text-shadow: 0 1px 2px var(--audio-clip-label-shadow); }
  .trim { position: relative; z-index: 2; width: 6px; min-width: 6px; height: 100%; padding: 0;
    border: 0; background: var(--audio-trim-surface); cursor: ew-resize; }
  .trim:hover:not(:disabled) { background: var(--audio-trim-hover); }
  .audio-menu { position: fixed; z-index: 120; width: 190px; padding: 6px;
    border: 1px solid var(--border); border-radius: var(--radius-sm); background: var(--panel-hi);
    box-shadow: 0 8px 24px var(--shadow-raised); }
  .audio-menu strong { display: block; padding: 5px 7px 7px; overflow: hidden;
    text-overflow: ellipsis; white-space: nowrap; font-size: 11px; }
  .audio-menu button { display: flex; align-items: center; gap: 7px; width: 100%; height: 28px;
    padding: 0 7px; border: 0; background: transparent; color: var(--text); text-align: left; }
  .audio-menu button:hover:not(:disabled) { background: var(--hover); }
  .audio-menu button.danger { color: var(--danger); }
  .volume-label { display: grid; grid-template-columns: 32px 1fr 34px; align-items: center;
    gap: 5px; padding: 7px; color: var(--text-dim); font-size: 11px; }
  .volume-label input { width: 100%; accent-color: var(--accent); }
  .volume-label output { color: var(--text); font-variant-numeric: tabular-nums; }
</style>
