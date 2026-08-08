import {
  clampNumber,
  commitNumber,
  dragNumber,
  formatNumber,
  numberDraftPointerDownAction,
  resolveNumberScrubEnd,
  stepNumber,
} from '../src/lib/numberField.js';

let pass = 0;
let fail = 0;
function eq(name, got, want) {
  if (Object.is(got, want)) pass++;
  else {
    fail++;
    console.error('FAIL ' + name + '\n  got:  ' + JSON.stringify(got) + '\n  want: ' + JSON.stringify(want));
  }
}
function deepEq(name, got, want) {
  eq(name, JSON.stringify(got), JSON.stringify(want));
}

eq('typed-number-clamps-at-lower-bound', commitNumber('-8', 4, 0, 10), 0);
eq('typed-number-clamps-at-upper-bound', commitNumber('14', 4, 0, 10), 10);
eq('typed-decimal-is-not-snapped-to-drag-step', commitNumber('1.26', 0, 0, 2), 1.26);
eq('blank-input-restores-fallback', commitNumber('', 7, 0, 10), 7);
eq('non-number-restores-clamped-fallback', commitNumber('nope', 12, 0, 10), 10);
eq('missing-bounds-remain-unbounded', clampNumber(-230, undefined, undefined), -230);
eq('precision-display-hides-floating-point-tail', formatNumber(3.9583333333333277, 0, 4, 3), '3.958');
eq('zero-precision-keeps-integer-zeroes', formatNumber(100, 0, 200, 0), '100');

eq('dirty-draft-precommits-before-an-outside-pointer-action', numberDraftPointerDownAction({
  dirty: true,
  disabled: false,
  pointerActive: false,
  sameField: false,
}), 'commit-blur');
for (const [name, policy] of [
  ['clean-draft', { dirty: false }],
  ['disabled-field', { dirty: true, disabled: true }],
  ['same-field-pointer', { dirty: true, sameField: true }],
  ['active-scrub', { dirty: true, pointerActive: true }],
]) {
  eq(`${name}-preserves-the-current-edit`, numberDraftPointerDownAction(policy), 'preserve');
}

eq('sub-threshold-positive-drag-does-not-change', dragNumber(10, 2, 1, 0, 20), 10);
eq('sub-threshold-negative-drag-does-not-change', dragNumber(10, -2, 1, 0, 20), 10);
eq('drag-is-symmetric', dragNumber(10, 9, 1, 0, 20) - 10, 10 - dragNumber(10, -9, 1, 0, 20));
eq('fractional-step-has-no-floating-point-tail', dragNumber(0.2, 6, 0.1, 0, 1), 0.4);
eq('drag-clamps-after-large-positive-motion', dragNumber(4, 500, 1, 0, 12), 12);
eq('drag-clamps-after-large-negative-motion', dragNumber(4, -500, 1, 0, 12), 0);
const scrubOrigin = 3;
const firstScrubPreview = dragNumber(scrubOrigin, 6, 0.5, 0, 10);
const secondScrubPreview = dragNumber(scrubOrigin, 12, 0.5, 0, 10);
deepEq('drag-is-derived-from-start-and-cancel-restores-that-start', {
  firstScrubPreview,
  secondScrubPreview,
  cancelled: resolveNumberScrubEnd(scrubOrigin, secondScrubPreview, true),
}, {
  firstScrubPreview: 4,
  secondScrubPreview: 5,
  cancelled: { value: 3, event: 'scrubcancel' },
});
eq('keyboard-tenth-step-has-no-floating-point-tail', stepNumber(0.2, 1, 0.1, 0, 1), 0.3);
eq('keyboard-thousandth-step-has-no-floating-point-tail', stepNumber(0.2, 1, 0.002, 0, 1), 0.202);
eq('keyboard-step-clamps-at-upper-bound', stepNumber(0.999, 1, 0.1, 0, 1), 1);
eq('keyboard-step-clamps-at-lower-bound', stepNumber(0.001, -1, 0.1, 0, 1), 0);
deepEq('completed-scrub-keeps-previewed-value', resolveNumberScrubEnd(12, 19, false), {
  value: 19,
  event: 'change',
});
deepEq('cancel-at-start-still-closes-the-scrub-transaction', resolveNumberScrubEnd(12, 12, true), {
  value: 12,
  event: 'scrubcancel',
});

const cancelledScrubs = [
  { start: -8, pixels: 18, step: 0.5, min: -20, max: 20 },
  { start: 0.125, pixels: -27, step: 0.025, min: 0, max: 1 },
  { start: 99, pixels: 600, step: 1, min: 0, max: 100 },
  { start: 4, pixels: -600, step: 1, min: 0, max: 12 },
].map(({ start, pixels, step, min, max }) => {
  const preview = dragNumber(start, pixels, step, min, max);
  return resolveNumberScrubEnd(start, preview, true);
});
deepEq('cancelled-scrub-is-a-left-inverse-across-values-and-clamped-previews', cancelledScrubs, [
  { value: -8, event: 'scrubcancel' },
  { value: 0.125, event: 'scrubcancel' },
  { value: 99, event: 'scrubcancel' },
  { value: 4, event: 'scrubcancel' },
]);

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
