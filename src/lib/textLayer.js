import { isWide } from './width.js';

const HEX = /^#[0-9a-f]{6}$/i;
const segmenter = typeof Intl !== 'undefined' && Intl.Segmenter
  ? new Intl.Segmenter(undefined, { granularity: 'grapheme' })
  : null;

// Run indices remain UTF-16 offsets for textarea APIs; segmentation only prevents
// layout and color boundaries from splitting a grapheme cluster.
function textSegments(text) {
  if (segmenter) {
    return [...segmenter.segment(text)].map(({ segment, index }) => ({
      text: segment,
      index,
      end: index + segment.length,
    }));
  }
  const out = [];
  let index = 0;
  for (const glyph of Array.from(text)) {
    out.push({ text: glyph, index, end: index + glyph.length });
    index += glyph.length;
  }
  return out;
}

function glyphWidth(glyph, wideFn) {
  if (glyph === '\t') return 1;
  return wideFn(glyph) ? 2 : 1;
}

export function layoutText(text, width, wrap, wideFn = isWide) {
  const maxWidth = Math.max(1, Math.round(Number(width)) || 1);
  const glyphs = [];
  const rowStarts = [0];
  let row = 0;
  let column = 0;

  const startRow = (index) => {
    row++;
    column = 0;
    rowStarts[row] = index;
  };
  const place = (token) => {
    const cells = glyphWidth(token.text, wideFn);
    if (wrap && column > 0 && column + cells > maxWidth) startRow(token.index);
    glyphs.push({
      glyph: token.text,
      index: token.index,
      end: token.end,
      x: column,
      y: row,
      width: cells,
    });
    column += cells;
  };

  const paragraph = [];
  const flushParagraph = () => {
    if (!paragraph.length) return;
    const groups = [];
    for (const token of paragraph) {
      const whitespace = token.text === ' ' || token.text === '\t';
      const previous = groups.at(-1);
      if (!previous || previous.whitespace !== whitespace) groups.push({ whitespace, tokens: [token] });
      else previous.tokens.push(token);
    }

    for (const group of groups) {
      const groupWidth = group.tokens.reduce((sum, token) => sum + glyphWidth(token.text, wideFn), 0);
      if (wrap && !group.whitespace && column > 0 && groupWidth <= maxWidth && column + groupWidth > maxWidth) {
        startRow(group.tokens[0].index);
      }
      for (const token of group.tokens) {
        const cells = glyphWidth(token.text, wideFn);
        if (wrap && group.whitespace && column > 0 && column + cells > maxWidth) {
          startRow(token.end);
          continue;
        }
        place(token);
      }
    }
    paragraph.length = 0;
  };

  for (const token of textSegments(String(text ?? ''))) {
    if (token.text === '\n' || token.text === '\r\n' || token.text === '\r') {
      flushParagraph();
      startRow(token.end);
    } else {
      paragraph.push(token);
    }
  }
  flushParagraph();

  return { glyphs, lineCount: row + 1, rowStarts };
}

export function textLayoutColumns(layout, minimum = 1) {
  let columns = Math.max(1, Math.round(Number(minimum)) || 1);
  for (const glyph of layout?.glyphs || []) {
    columns = Math.max(columns, glyph.x + glyph.width);
  }
  return columns;
}

function normalizedHex(value, fallback = '#ffffff') {
  return HEX.test(value || '') ? value.toLowerCase() : fallback.toLowerCase();
}

function textExtent(textOrLength) {
  if (typeof textOrLength === 'string') {
    return { text: textOrLength, length: textOrLength.length };
  }
  return { text: null, length: Math.max(0, Math.round(Number(textOrLength)) || 0) };
}

function snapRangeToGraphemes(text, start, end) {
  if (!text || start === end) return { start, end };
  const segments = textSegments(text);
  let from = start;
  let to = end;
  if (!segments.some((segment) => segment.index === from)) {
    const segment = segments.find((candidate) => from > candidate.index && from < candidate.end);
    if (segment) from = segment.index;
  }
  if (to !== text.length && !segments.some((segment) => segment.index === to)) {
    const segment = segments.find((candidate) => to > candidate.index && to < candidate.end);
    if (segment) to = segment.end;
  }
  return { start: from, end: to };
}
function mergeRuns(runs) {
  const sorted = runs
    .filter((run) => run.start < run.end)
    .sort((a, b) => a.start - b.start || a.end - b.end);
  const out = [];
  for (const run of sorted) {
    const previous = out.at(-1);
    if (previous && previous.end === run.start && previous.fg === run.fg) previous.end = run.end;
    else out.push({ ...run });
  }
  return out;
}

function overlayRun(runs, next) {
  const out = [];
  for (const run of runs) {
    if (run.end <= next.start || run.start >= next.end) {
      out.push(run);
      continue;
    }
    if (run.start < next.start) out.push({ ...run, end: next.start });
    if (run.end > next.end) out.push({ ...run, start: next.end });
  }
  out.push(next);
  return mergeRuns(out);
}

// Runs are sparse overrides of the base color; later overlapping runs win, then
// adjacent equal colors collapse to one grapheme-aligned interval.
export function normalizeTextRuns(runs, textOrLength, baseColor = '#ffffff') {
  const { text, length } = textExtent(textOrLength);
  const base = normalizedHex(baseColor);
  let out = [];
  for (const source of Array.isArray(runs) ? runs : []) {
    const rawStart = Math.max(0, Math.min(length, Math.round(Number(source?.start)) || 0));
    const rawEnd = Math.max(rawStart, Math.min(length, Math.round(Number(source?.end)) || 0));
    const { start, end } = snapRangeToGraphemes(text, rawStart, rawEnd);
    if (start === end || !HEX.test(source?.fg || '')) continue;
    const fg = source.fg.toLowerCase();
    out = overlayRun(out, { start, end, fg });
  }
  return mergeRuns(out.filter((run) => run.fg !== base));
}
export function applyTextColor(runs, start, end, color, textOrLength, baseColor = '#ffffff') {
  const { text, length } = textExtent(textOrLength);
  const rawFrom = Math.max(0, Math.min(length, Math.round(Number(start)) || 0));
  const rawTo = Math.max(rawFrom, Math.min(length, Math.round(Number(end)) || 0));
  const range = snapRangeToGraphemes(text, rawFrom, rawTo);
  const from = range.start;
  const to = range.end;
  const base = normalizedHex(baseColor);
  const fg = normalizedHex(color, base);
  let out = normalizeTextRuns(runs, text ?? length, base);
  if (from === to) return out;
  if (fg === base) {
    return mergeRuns(out.flatMap((run) => {
      if (run.end <= from || run.start >= to) return [run];
      const pieces = [];
      if (run.start < from) pieces.push({ ...run, end: from });
      if (run.end > to) pieces.push({ ...run, start: to });
      return pieces;
    }));
  }
  return overlayRun(out, { start: from, end: to, fg });
}
function colorAt(runs, index, baseColor) {
  return runs.find((run) => index >= run.start && index < run.end)?.fg || baseColor;
}

// Treat one input event as a changed middle span between common prefix and suffix;
// inserted text inherits the color at that edit boundary.
export function remapTextColorRuns(oldText, newText, runs, baseColor = '#ffffff') {
  const before = String(oldText ?? '');
  const after = String(newText ?? '');
  const base = normalizedHex(baseColor);
  const source = normalizeTextRuns(runs, before, base);
  if (before === after) return source;

  let start = 0;
  while (start < before.length && start < after.length && before[start] === after[start]) start++;
  let suffix = 0;
  while (suffix < before.length - start && suffix < after.length - start &&
    before[before.length - 1 - suffix] === after[after.length - 1 - suffix]) suffix++;

  const oldEnd = before.length - suffix;
  const newEnd = after.length - suffix;
  const delta = newEnd - oldEnd;
  const inheritedIndex = start < before.length ? start : Math.max(0, start - 1);
  const inherited = colorAt(source, inheritedIndex, base);
  const moved = [];

  for (const run of source) {
    if (run.end <= start) {
      moved.push({ ...run });
      continue;
    }
    if (run.start >= oldEnd) {
      moved.push({ ...run, start: run.start + delta, end: run.end + delta });
      continue;
    }
    if (run.start < start) moved.push({ ...run, end: start });
    if (run.end > oldEnd) moved.push({ ...run, start: newEnd, end: run.end + delta });
  }
  if (newEnd > start && inherited !== base) moved.push({ start, end: newEnd, fg: inherited });
  return normalizeTextRuns(moved, after, base);
}

export function renderTextToCells(text, box, fg, wrap, runs = [], wideFn = isWide) {
  const cells = {};
  if (!text || !box) return cells;
  const base = normalizedHex(fg);
  const colors = normalizeTextRuns(runs, String(text), base);
  const layout = layoutText(text, box.w, wrap, wideFn);
  for (const item of layout.glyphs) {
    if (item.glyph === ' ' || item.glyph === '\t') continue;
    const x = Math.round(Number(box.x) || 0) + item.x;
    const y = Math.round(Number(box.y) || 0) + item.y;
    const color = colorAt(colors, item.index, base);
    cells[`${x},${y}`] = { c: item.glyph, fg: color, bg: null };
    if (item.width === 2) cells[`${x + 1},${y}`] = { c: '', fg: color, bg: null, cont: true };
  }
  return cells;
}

export function textOverflowsBox(text, box, wrap, wideFn = isWide) {
  if (!box) return false;
  const width = Math.max(1, Math.round(Number(box.w)) || 1);
  const height = Math.max(1, Math.round(Number(box.h)) || 1);
  const layout = layoutText(text, width, wrap, wideFn);
  return layout.lineCount > height || layout.glyphs.some((glyph) => glyph.x + glyph.width > width);
}

function splitTextLines(source) {
  const lines = [];
  let start = 0;
  let index = 0;
  while (index < source.length) {
    if (source[index] !== '\n' && source[index] !== '\r') {
      index++;
      continue;
    }
    const separatorEnd = source[index] === '\r' && source[index + 1] === '\n'
      ? index + 2
      : index + 1;
    lines.push({ start, contentEnd: index, end: separatorEnd });
    start = separatorEnd;
    index = separatorEnd;
  }
  lines.push({ start, contentEnd: source.length, end: source.length });
  return lines;
}

function remapKeptTextRuns(runs, source, text, ranges, baseColor) {
  const sourceRuns = normalizeTextRuns(runs, source, baseColor);
  const mapped = [];
  for (const range of ranges) {
    for (const run of sourceRuns) {
      const start = Math.max(range.start, run.start);
      const end = Math.min(range.end, run.end);
      if (start >= end) continue;
      mapped.push({
        start: range.outputStart + start - range.start,
        end: range.outputStart + end - range.start,
        fg: run.fg,
      });
    }
  }
  return normalizeTextRuns(mapped, text, baseColor);
}

export function cutTextToBox(text, box, wrap, runs, baseColor = '#ffffff', wideFn = isWide) {
  const source = String(text ?? '');
  if (!box) return { text: source, runs: normalizeTextRuns(runs, source, baseColor) };
  const width = Math.max(1, Math.round(Number(box.w)) || 1);
  const height = Math.max(1, Math.round(Number(box.h)) || 1);
  const layout = layoutText(source, width, wrap, wideFn);
  const horizontalOverflow = layout.glyphs.find((glyph) => glyph.x + glyph.width > width);
  if (layout.lineCount <= height && !horizontalOverflow) {
    return { text: source, runs: normalizeTextRuns(runs, source, baseColor) };
  }

  if (!wrap) {
    const lines = splitTextLines(source).slice(0, height);
    let clipped = '';
    const ranges = [];
    const appendRange = (start, end) => {
      if (start >= end) return;
      ranges.push({ start, end, outputStart: clipped.length });
      clipped += source.slice(start, end);
    };
    lines.forEach((line, index) => {
      const lineText = source.slice(line.start, line.contentEnd);
      const overflow = layoutText(lineText, width, false, wideFn).glyphs
        .find((glyph) => glyph.x + glyph.width > width);
      let contentEnd = line.start + (overflow?.index ?? lineText.length);
      if (overflow) {
        while (contentEnd > line.start && (source[contentEnd - 1] === ' ' || source[contentEnd - 1] === '\t')) {
          contentEnd--;
        }
      }
      appendRange(line.start, contentEnd);
      if (index < lines.length - 1) appendRange(line.contentEnd, line.end);
    });
    return {
      text: clipped,
      runs: remapKeptTextRuns(runs, source, clipped, ranges, baseColor),
    };
  }

  let end = Math.max(0, Math.min(source.length, layout.rowStarts[height] ?? source.length));
  if (horizontalOverflow) end = Math.min(end, horizontalOverflow.index);
  while (end > 0 && (source[end - 1] === ' ' || source[end - 1] === '\t' || source[end - 1] === '\n' || source[end - 1] === '\r')) end--;
  return {
    text: source.slice(0, end),
    runs: normalizeTextRuns(runs, source.slice(0, end), baseColor),
  };
}
