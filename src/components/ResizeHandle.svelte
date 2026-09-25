<script lang="ts">
  interface Props {
    target?: HTMLElement | null;
    onResize?: () => void;
  }

  let { target = $bindable(null), onResize = () => {} }: Props = $props();

  function onDown(e: PointerEvent): void {
    if (!target || e.button !== 0) return;
    e.preventDefault();
    const handle = e.currentTarget;
    if (!(handle instanceof HTMLElement)) return;
    const pointerId = e.pointerId;
    const startY = e.clientY;
    const startH = target.getBoundingClientRect().height;
    const parent = target.parentElement;
    const parentHeight = parent?.getBoundingClientRect().height || window.innerHeight;
    const fixedHeight = parent
      ? [...parent.children]
        .filter((child) => child !== target && !child.classList.contains('layers'))
        .reduce((sum, child) => sum + child.getBoundingClientRect().height, 0)
      : 0;
    const maxHeight = Math.max(60, parentHeight - fixedHeight - 120);
    const move = (ev: PointerEvent): void => {
      if (ev.pointerId !== pointerId) return;
      const nh = Math.max(60, Math.min(maxHeight, startH + (ev.clientY - startY)));
      target.style.height = nh + 'px';
      onResize();
    };
    const up = (ev: Event): void => {
      if (ev instanceof PointerEvent && ev.pointerId !== pointerId) return;
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', up);
      window.removeEventListener('blur', up);
      handle.removeEventListener('lostpointercapture', up);
      if (handle.hasPointerCapture?.(pointerId)) handle.releasePointerCapture(pointerId);
    };
    handle.setPointerCapture?.(pointerId);
    handle.addEventListener('lostpointercapture', up);
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', up);
    window.addEventListener('blur', up);
  }
</script>

<div class="resize-handle" onpointerdown={onDown} role="separator" aria-orientation="horizontal"></div>

<style>
  .resize-handle { height: 5px; background: var(--border); cursor: ns-resize; flex-shrink: 0; }
  .resize-handle:hover { background: var(--accent-dim); }
</style>
