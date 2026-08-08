function finite(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

export function clampNumber(value, min, max) {
  let number = finite(value, 0);
  const lower = finite(min, -Infinity);
  const upper = finite(max, Infinity);
  number = Math.max(lower, number);
  number = Math.min(upper, number);
  return number;
}

export function commitNumber(text, fallback, min, max) {
  const trimmed = String(text).trim();
  const parsed = trimmed === '' ? NaN : Number(trimmed);
  return clampNumber(Number.isFinite(parsed) ? parsed : fallback, min, max);
}

export function formatNumber(value, min, max, precision) {
  const number = clampNumber(value, min, max);
  if (!Number.isInteger(precision) || precision < 0) return String(number);
  if (precision === 0) return number.toFixed(0);
  return number.toFixed(precision).replace(/\.?0+$/, '');
}

function decimalPlaces(value) {
  const text = String(value).toLowerCase();
  if (text.includes('e-')) return Number(text.split('e-')[1]) || 0;
  return text.includes('.') ? text.length - text.indexOf('.') - 1 : 0;
}

export function dragNumber(start, deltaX, step = 1, min, max, pixelsPerStep = 3) {
  const origin = finite(start, 0);
  const increment = Math.abs(finite(step, 1)) || 1;
  const pixels = Math.max(1, Math.abs(finite(pixelsPerStep, 3)));
  const units = deltaX < 0 ? Math.ceil(deltaX / pixels) : Math.floor(deltaX / pixels);
  const precision = Math.min(12, Math.max(decimalPlaces(origin), decimalPlaces(increment)));
  const value = Number((origin + units * increment).toFixed(precision));
  return clampNumber(value, min, max);
}

export function stepNumber(start, direction, step = 1, min, max) {
  const sign = Math.sign(finite(direction, 0));
  if (!sign) return clampNumber(start, min, max);
  return dragNumber(start, sign * 3, step, min, max, 3);
}

export function resolveNumberScrubEnd(start, current, cancelled) {
  const startValue = finite(start, 0);
  const currentValue = finite(current, startValue);
  return cancelled
    ? { value: startValue, event: 'scrubcancel' }
    : { value: currentValue, event: 'change' };
}

export function numberDraftPointerDownAction({
  dirty,
  disabled,
  pointerActive,
  sameField,
} = {}) {
  return dirty && !disabled && !pointerActive && !sameField
    ? 'commit-blur'
    : 'preserve';
}
