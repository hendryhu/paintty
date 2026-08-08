import { normalizeOutputGrid } from './outputGrid.js';

function hexRgb(hex) {
  const value = parseInt(String(hex || '').replace('#', ''), 16);
  return {
    r: Number.isFinite(value) ? (value >> 16) & 255 : 0,
    g: Number.isFinite(value) ? (value >> 8) & 255 : 0,
    b: Number.isFinite(value) ? value & 255 : 0,
  };
}

function visibleCell(cell) {
  return !!cell && !cell.cont && (!!cell.bg || (!!cell.c && cell.c !== ' '));
}

function lastVisibleColumn(row) {
  for (let index = row.length - 1; index >= 0; index--) {
    if (visibleCell(row[index])) return index;
  }
  return -1;
}

function styleOf(cell) {
  const blink = !!cell.blink;
  const fg = cell.fg || null;
  const bg = cell.bg || null;
  return {
    blink,
    fg,
    bg,
    styled: blink || !!fg || !!bg,
    key: `${blink ? 1 : 0}|${fg || ''}|${bg || ''}`,
  };
}

function styleCodes(style, escape) {
  let codes = '';
  if (style.blink) codes += `${escape}[5m`;
  if (style.fg) {
    const { r, g, b } = hexRgb(style.fg);
    codes += `${escape}[38;2;${r};${g};${b}m`;
  }
  if (style.bg) {
    const { r, g, b } = hexRgb(style.bg);
    codes += `${escape}[48;2;${r};${g};${b}m`;
  }
  return codes;
}

// Continuation slots emit nothing because their leader advances two terminal columns;
// resets before plain gaps prevent a prior background from bleeding into them.
function renderRows(rows, dialect) {
  let body = '';
  let usesEscape = false;

  for (const row of normalizeOutputGrid(rows)) {
    const last = lastVisibleColumn(row);
    let currentStyle = null;

    for (let x = 0; x <= last; x++) {
      const cell = row[x];
      if (cell?.cont) continue;

      if (!visibleCell(cell)) {
        if (currentStyle?.styled) {
          body += dialect.reset;
          usesEscape = true;
        }
        currentStyle = null;
        body += ' ';
        continue;
      }

      const nextStyle = styleOf(cell);
      if (!currentStyle || currentStyle.key !== nextStyle.key) {
        if (currentStyle?.styled) {
          body += dialect.reset;
          usesEscape = true;
        }
        const codes = styleCodes(nextStyle, dialect.escape);
        if (codes) {
          body += codes;
          usesEscape = true;
        }
        currentStyle = nextStyle;
      }
      body += dialect.escapeGlyph(cell.c || ' ');
    }

    if (currentStyle?.styled) {
      body += dialect.reset;
      usesEscape = true;
    }
    body += dialect.newline;
  }

  return { body, usesEscape };
}

const ANSI = {
  escape: '\x1b',
  reset: '\x1b[0m',
  newline: '\n',
  escapeGlyph: (glyph) => glyph,
};

const BASH = {
  escape: '\\033',
  reset: '\\033[0m',
  newline: '\\n',
  escapeGlyph: (glyph) => glyph.replace(/\\/g, '\\\\'),
};

const POWERSHELL = {
  escape: '$e',
  reset: '$e[0m',
  newline: '`n',
  escapeGlyph: (glyph) => glyph.replace(/[`"$]/g, (character) => '`' + character),
};

export function frameToAnsiText(rows) {
  return renderRows(rows, ANSI).body;
}

export function frameToBashCommand(rows) {
  const { body } = renderRows(rows, BASH);
  const safe = body.replace(/'/g, `'\\''`);
  return `printf '%b' '${safe}'`;
}

export function frameToPowerShellCommand(rows) {
  const { body, usesEscape } = renderRows(rows, POWERSHELL);
  if (!usesEscape) return `Write-Host -NoNewline "${body}"`;
  return `& { $e=[char]27; Write-Host -NoNewline "${body}" }`;
}
