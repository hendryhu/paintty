import { writable } from 'svelte/store';

export const DEFAULT_FAMILY = 'JetBrainsMono Nerd Font';

const BOOT_FALLBACK = '"Cascadia Mono", ui-monospace, Consolas, monospace';

export const canvasFont = writable(BOOT_FALLBACK);
export const loadedFontName = writable(null);
export const nerdFontReady = writable(false);

const BASE_URL = import.meta.env?.BASE_URL || './';
const NERD_URL = `${BASE_URL}vendor/nerd-fonts/v3.2.1/JetBrainsMonoNerdFont-Regular.ttf`;

export async function loadDefaultNerdFont() {
  try {
    const face = new FontFace(DEFAULT_FAMILY, `url(${NERD_URL})`);
    await face.load();
    document.fonts.add(face);
    canvasFont.set(`"${DEFAULT_FAMILY}"`);
    nerdFontReady.set(true);
  } catch (error) {
    nerdFontReady.set(false);
    throw error;
  }
}

export async function loadFontFile(file) {
  const buf = await file.arrayBuffer();
  const family = file.name.replace(/\.(ttf|otf|woff2?|ttc)$/i, '').replace(/[^a-z0-9]+/gi, ' ').trim() || 'UserFont';
  const face = new FontFace(family, buf);
  await face.load();
  document.fonts.add(face);
  loadedFontName.set(family);
  canvasFont.set(`"${family}"`);
  return family;
}

export function useDefaultFont() {
  loadedFontName.set(null);
  canvasFont.set(`"${DEFAULT_FAMILY}", ${BOOT_FALLBACK}`);
}
