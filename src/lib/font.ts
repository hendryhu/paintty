import { writable } from 'svelte/store';

export const DEFAULT_FAMILY = 'JetBrainsMono Nerd Font';

const BOOT_FALLBACK = '"Cascadia Mono", ui-monospace, Consolas, monospace';

export const canvasFont = writable<string>(BOOT_FALLBACK);
export const loadedFontName = writable<string | null>(null);
export const nerdFontReady = writable<boolean>(false);
export const fontCacheKey = writable<string>('boot-fallback');

const BASE_URL = import.meta.env?.BASE_URL || './';
const NERD_URL = `${BASE_URL}vendor/nerd-fonts/v3.2.1/JetBrainsMonoNerdFont-Regular.ttf`;

export async function loadDefaultNerdFont(): Promise<void> {
  try {
    const face = new FontFace(DEFAULT_FAMILY, `url(${NERD_URL})`);
    await face.load();
    document.fonts.add(face);
    canvasFont.set(`"${DEFAULT_FAMILY}"`);
    fontCacheKey.set('jetbrains-mono-nerd-font-v3.2.1');
    nerdFontReady.set(true);
  } catch (error) {
    nerdFontReady.set(false);
    throw error;
  }
}

export async function loadFontFile(file: File): Promise<string> {
  const buf = await file.arrayBuffer();
  const digest = globalThis.crypto?.subtle
    ? new Uint8Array(await globalThis.crypto.subtle.digest('SHA-256', buf.slice(0)))
    : null;
  const hash = digest
    ? [...digest].map((byte) => byte.toString(16).padStart(2, '0')).join('')
    : `${buf.byteLength}-${file.lastModified || 0}`;
  const family = file.name.replace(/\.(ttf|otf|woff2?|ttc)$/i, '').replace(/[^a-z0-9]+/gi, ' ').trim() || 'UserFont';
  const face = new FontFace(family, buf);
  await face.load();
  document.fonts.add(face);
  loadedFontName.set(family);
  fontCacheKey.set(`user-font:${hash}`);
  canvasFont.set(`"${family}"`);
  return family;
}

export function useDefaultFont(): void {
  loadedFontName.set(null);
  canvasFont.set(`"${DEFAULT_FAMILY}", ${BOOT_FALLBACK}`);
  fontCacheKey.set('jetbrains-mono-nerd-font-v3.2.1');
}
