<script>
  import OfflineIcon from '@iconify/svelte/dist/OfflineIcon.svelte';
  import { ICON_DATA } from '../lib/iconData.js';

  let { icon, ...rest } = $props();

  let warnedIcon = $state();
  let iconData = $derived(ICON_DATA[icon]);
  $effect(() => {
    if (!iconData && import.meta.env.DEV && warnedIcon !== icon) {
      warnedIcon = icon;
      console.error(`Missing bundled icon: ${icon}`);
    }
  });
</script>

{#if iconData}
  <OfflineIcon icon={iconData} {...rest} />
{:else}
  <svg
    xmlns="http://www.w3.org/2000/svg"
    aria-hidden="true"
    role="img"
    width="1em"
    height="1em"
    viewBox="0 0 24 24"
    {...rest}
    data-missing-icon={icon}
  >
    <title>Missing icon: {icon}</title>
    <rect width="24" height="24" fill="#ff00ff" />
    <path d="M6 6l12 12M18 6L6 18" fill="none" stroke="#000" stroke-width="3" />
  </svg>
{/if}
