import {
  canonicalLayerDropGap, computeGapMove, computeSelectedGapMove, normalizeGroups,
} from '../src/lib/grid.js';

let pass = 0, fail = 0;
function eq(name, got, want) {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g === w) { pass++; }
  else { fail++; console.error(`FAIL ${name}\n  got:  ${g}\n  want: ${w}`); }
}
const ids = (arr) => arr.map((l) => l.groupId ? `${l.name}<${l.groupId}` : l.name);

function scene() {
  return [
    { id: 1, name: 'grp', type: 'group' },
    { id: 2, name: 'a', type: 'cell', groupId: 1 },
    { id: 3, name: 'b', type: 'cell' },
    { id: 4, name: 'c', type: 'cell' },
  ];
}

eq('into-group-top', ids(computeGapMove(scene(), 4, 2, true)),
   ['grp', 'c<1', 'a<1', 'b']);

eq('into-group-bottom', ids(computeGapMove(scene(), 4, 3, true)),
   ['grp', 'a<1', 'c<1', 'b']);

eq('out-below-group', ids(computeGapMove(scene(), 2, 3, false)),
   ['grp', 'a', 'b', 'c']);

const posed = [
  { id: 1, name: 'grp', type: 'group', offset: { x: 7, y: -3 } },
  { id: 2, name: 'a', type: 'cell', groupId: 1, offset: { x: 2, y: 5 } },
  { id: 3, name: 'b', type: 'cell' },
];
const ungroupedPose = computeGapMove(posed, 2, 3, false).find((layer) => layer.id === 2);
eq('out-of-group-preserves-current-world-pose', ungroupedPose.offset, { x: 9, y: 2 });
const regroupedPose = computeGapMove(posed, 3, 2, true).find((layer) => layer.id === 3);
eq('into-group-preserves-current-world-pose', regroupedPose.offset, { x: -7, y: 3 });

eq('to-top', ids(computeGapMove(scene(), 3, 1, false)),
   ['b', 'grp', 'a<1', 'c']);

eq('to-bottom', ids(computeGapMove(scene(), 3, null, false)),
   ['grp', 'a<1', 'c', 'b']);

eq('selected-group-moves-with-children', ids(computeSelectedGapMove(
  scene(), new Set([1]), null, false,
)), ['b', 'c', 'grp', 'a<1']);

eq('selected-group-and-layer-stay-top-level', ids(computeSelectedGapMove(
  scene(), new Set([1, 3]), null, true,
)), ['c', 'grp', 'a<1', 'b']);

eq('selected-gap-resolves-past-another-moving-row', ids(computeSelectedGapMove([
  { id: 1, name: 'a', type: 'cell' },
  { id: 2, name: 'b', type: 'cell' },
  { id: 3, name: 'c', type: 'cell' },
], new Set([1, 3]), 3, false)), ['b', 'a', 'c']);

eq('selected-group-cannot-nest-in-another-group', ids(computeSelectedGapMove([
  { id: 1, name: 'one', type: 'group' },
  { id: 2, name: 'a', type: 'cell', groupId: 1 },
  { id: 4, name: 'two', type: 'group' },
  { id: 5, name: 'd', type: 'cell', groupId: 4 },
  { id: 6, name: 'x', type: 'cell' },
], new Set([1]), 5, true)), ['two', 'd<4', 'one', 'a<1', 'x']);

eq('group-drop-indicator-resolves-to-the-same-legal-top-level-gap', canonicalLayerDropGap([
  { id: 1, name: 'one', type: 'group' },
  { id: 2, name: 'a', type: 'cell', groupId: 1 },
  { id: 3, name: 'b', type: 'cell', groupId: 1 },
  { id: 4, name: 'two', type: 'group' },
  { id: 5, name: 'd', type: 'cell', groupId: 4 },
  { id: 6, name: 'x', type: 'cell' },
], new Set([4]), 4, 2, true), { beforeId: 6, intoGroup: false });

eq('ordinary-child-drop-indicator-retains-its-in-group-gap', canonicalLayerDropGap([
  { id: 1, name: 'one', type: 'group' },
  { id: 2, name: 'a', type: 'cell', groupId: 1 },
  { id: 3, name: 'x', type: 'cell' },
], new Set([3]), 3, 2, true), { beforeId: 2, intoGroup: true });

eq('child-up-out-of-group', ids(computeGapMove([
  { id: 1, name: 'grp', type: 'group' },
  { id: 2, name: 'a', type: 'cell', groupId: 1 },
  { id: 3, name: 'b', type: 'cell' },
], 2, 1, true)), ['a', 'grp', 'b']);

eq('norm-child-above-header', ids(normalizeGroups([
  { id: 2, name: 'a', type: 'cell', groupId: 1 },
  { id: 1, name: 'grp', type: 'group' },
  { id: 3, name: 'b', type: 'cell', groupId: 1 },
])), ['a', 'grp', 'b<1']);

eq('norm-broken-run', ids(normalizeGroups([
  { id: 1, name: 'grp', type: 'group' },
  { id: 2, name: 'a', type: 'cell', groupId: 1 },
  { id: 3, name: 'x', type: 'cell' },
  { id: 4, name: 'b', type: 'cell', groupId: 1 },
])), ['grp', 'a<1', 'x', 'b']);

eq('norm-dangling', ids(normalizeGroups([
  { id: 2, name: 'a', type: 'cell', groupId: 99 },
])), ['a']);

eq('norm-valid', ids(normalizeGroups([
  { id: 1, name: 'grp', type: 'group' },
  { id: 2, name: 'a', type: 'cell', groupId: 1 },
  { id: 3, name: 'b', type: 'cell', groupId: 1 },
])), ['grp', 'a<1', 'b<1']);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
