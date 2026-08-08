import { hexToOklch, maxChroma, oklchToHex } from './color.js';

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, Number(value) || 0));
}

function normalizeHue(value) {
  const hue = Number(value);
  if (!Number.isFinite(hue)) return 0;
  return Math.min(360, Math.max(0, hue));
}

export function pickerStateFromHex(hex) {
  const normalized = /^#[0-9a-f]{6}$/i.test(String(hex)) ? String(hex).toLowerCase() : '#000000';
  const { L, C, H } = hexToOklch(normalized);
  return { L, C, H, hex: normalized };
}

export function pickerStateFromOklch(L, C, H) {
  const lightness = clamp(L, 0, 1);
  const hue = normalizeHue(H);
  const chroma = clamp(C, 0, maxChroma(lightness, hue));
  return {
    L: lightness,
    C: chroma,
    H: hue,
    hex: oklchToHex(lightness, chroma, hue),
  };
}

export function setPickerLightness(state, percent) {
  return pickerStateFromOklch(Number(percent) / 100, state.C, state.H);
}

export function setPickerChroma(state, chroma) {
  return pickerStateFromOklch(state.L, chroma, state.H);
}

export function setPickerHue(state, hue) {
  return pickerStateFromOklch(state.L, state.C, hue);
}
