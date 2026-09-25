import { hexToOklch, maxChroma, oklchToHex } from './color.js';

export const PICKER_MAX_CHROMA = 0.4;

export interface ColorPickerState {
  L: number;
  C: number;
  H: number;
  hex: string;
}

function clamp(value: unknown, min: number, max: number): number {
  return Math.min(max, Math.max(min, Number(value) || 0));
}

function normalizeHue(value: unknown): number {
  const hue = Number(value);
  if (!Number.isFinite(hue)) return 0;
  return Math.min(360, Math.max(0, hue));
}

export function pickerStateFromHex(hex: unknown): ColorPickerState {
  const normalized = /^#[0-9a-f]{6}$/i.test(String(hex)) ? String(hex).toLowerCase() : '#000000';
  const { L, C, H } = hexToOklch(normalized);
  return { L, C, H, hex: normalized };
}

export function pickerStateFromOklch(L: unknown, C: unknown, H: unknown): ColorPickerState {
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

// Fix C keeps the selected chroma while lightness and hue move through blank gamut regions.
export function pickerStateWithFixedChroma(L: unknown, C: unknown, H: unknown): ColorPickerState {
  const lightness = clamp(L, 0, 1);
  const hue = normalizeHue(H);
  const chroma = clamp(C, 0, PICKER_MAX_CHROMA);
  return {
    L: lightness,
    C: chroma,
    H: hue,
    hex: oklchToHex(lightness, chroma, hue),
  };
}

export function setPickerLightness(state: ColorPickerState, percent: unknown): ColorPickerState {
  return pickerStateFromOklch(Number(percent) / 100, state.C, state.H);
}

export function setPickerChroma(state: ColorPickerState, chroma: unknown): ColorPickerState {
  return pickerStateWithFixedChroma(state.L, chroma, state.H);
}

export function setPickerHue(state: ColorPickerState, hue: unknown): ColorPickerState {
  return pickerStateFromOklch(state.L, state.C, hue);
}
