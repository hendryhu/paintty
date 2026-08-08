import {
  frameToAnsiText,
  frameToBashCommand,
  frameToPowerShellCommand,
} from '../src/lib/terminalCopy.js';

let pass = 0;
let fail = 0;

function eq(name, actual, expected) {
  if (actual === expected) {
    pass++;
    return;
  }
  fail++;
  console.error(`FAIL ${name}\n  got:  ${JSON.stringify(actual)}\n  want: ${JSON.stringify(expected)}`);
}

const blank = [
  [null, null, null, null],
  [null, null, null, null],
];

eq('blank ANSI rows contain only newlines',
  frameToAnsiText(blank),
  '\n\n');
eq('blank Bash rows contain only newline escapes',
  frameToBashCommand(blank),
  "printf '%b' '\\n\\n'");
eq('blank PowerShell rows contain only newline escapes',
  frameToPowerShellCommand(blank),
  'Write-Host -NoNewline "`n`n"');

const mixed = [
  [
    null,
    { c: 'A', fg: '#ff0000' },
    { c: 'B', fg: '#ff0000' },
    null,
    null,
  ],
  [
    null,
    null,
    { c: '', bg: '#0000ff' },
    null,
  ],
];

eq('ANSI keeps internal spaces and trims every trailing transparent run',
  frameToAnsiText(mixed),
  ' \x1b[38;2;255;0;0mAB\x1b[0m\n  \x1b[48;2;0;0;255m \x1b[0m\n');
eq('Bash shares styles across runs and trims row tails',
  frameToBashCommand(mixed),
  "printf '%b' ' \\033[38;2;255;0;0mAB\\033[0m\\n  \\033[48;2;0;0;255m \\033[0m\\n'");
eq('PowerShell shares styles across runs and trims row tails',
  frameToPowerShellCommand(mixed),
  '& { $e=[char]27; Write-Host -NoNewline " $e[38;2;255;0;0mAB$e[0m`n  $e[48;2;0;0;255m $e[0m`n" }');

const wide = [[
  { c: '界', fg: '#ffffff' },
  { c: '', fg: '#ffffff', cont: true },
  null,
]];

eq('wide continuation consumes no extra output cell',
  frameToAnsiText(wide).replace(/\x1b\[[0-9;]*m/g, ''),
  '界\n');

const wideNeighbor = [[
  { c: '界', fg: '#ffffff' },
  { c: '', fg: '#ffffff', cont: true },
  { c: 'X' },
]];

eq('visible glyph after a wide continuation is not skipped',
  frameToPowerShellCommand(wideNeighbor),
  '& { $e=[char]27; Write-Host -NoNewline "$e[38;2;255;255;255m界$e[0mX`n" }');

eq('an incomplete wide glyph at the output edge cannot wrap into the next row',
  frameToBashCommand([[{ c: 'A' }, { c: '界', fg: '#ffffff' }]]),
  "printf '%b' 'A\\n'");

eq('an orphaned continuation becomes a background cell instead of disappearing',
  frameToPowerShellCommand([[
    { c: 'A' },
    { c: '', fg: '#ffffff', bg: '#010203', cont: true },
  ]]),
  '& { $e=[char]27; Write-Host -NoNewline "A$e[48;2;1;2;3m $e[0m`n" }');

const bashMeta = [[{ c: "'" }, { c: '\\' }]];
eq('Bash quoting preserves apostrophes and backslashes',
  frameToBashCommand(bashMeta),
  "printf '%b' ''\\''\\\\\\n'");
const powerShellMeta = [[{ c: '"' }, { c: '$' }]];
eq('PowerShell quoting preserves quotes and dollar signs',
  frameToPowerShellCommand(powerShellMeta),
  'Write-Host -NoNewline "`"`$`n"');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
