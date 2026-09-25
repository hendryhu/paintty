import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { requireValue } from './types/ui-test-types.ts';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const srcRoot = path.join(root, 'src');
const sourceExtensions = new Set(['.ts', '.svelte']);

function sourceFiles(directory: string): string[] {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const resolved = path.join(directory, entry.name);
    return entry.isDirectory() ? sourceFiles(resolved) : [resolved];
  }).filter((file) => sourceExtensions.has(path.extname(file)));
}

function maskNonCode(source: string): string {
  const output: string[] = Array.from(source, (char) => char === '\n' || char === '\r' ? char : ' ');

  function scanString(index: number, quote: string): number {
    for (index++; index < source.length; index++) {
      if (source[index] === '\\') index++;
      else if (source[index] === quote) return index + 1;
    }
    return index;
  }

  function scanTemplate(index: number): number {
    for (index++; index < source.length;) {
      if (source[index] === '\\') index += 2;
      else if (source[index] === '`') return index + 1;
      else if (source[index] === '$' && source[index + 1] === '{') index = scanCode(index + 2, 1);
      else index++;
    }
    return index;
  }

  function scanCode(index: number, braceDepth = 0): number {
    for (; index < source.length; index++) {
      const char = requireValue(source[index]);
      const next = source[index + 1];
      if (char === "'" || char === '"') {
        index = scanString(index, char) - 1;
        continue;
      }
      if (char === '`') {
        index = scanTemplate(index) - 1;
        continue;
      }
      if (char === '/' && next === '/') {
        while (index < source.length && source[index] !== '\n') index++;
        index--;
        continue;
      }
      if (char === '/' && next === '*') {
        index += 2;
        while (index < source.length && !(source[index] === '*' && source[index + 1] === '/')) index++;
        index++;
        continue;
      }
      output[index] = char;
      if (braceDepth && char === '{') braceDepth++;
      if (braceDepth && char === '}' && --braceDepth === 0) return index + 1;
    }
    return index;
  }

  scanCode(0);
  return output.join('');
}

interface ScriptRegion {
  source: string;
  offset: number;
}

interface ScriptViolation {
  kind: string;
  index: number;
}

interface FileViolation extends ScriptViolation {
  file: string;
  line: number;
}

function scriptRegions(file: string, source: string): ScriptRegion[] {
  if (path.extname(file) !== '.svelte') return [{ source, offset: 0 }];
  return Array.from(source.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/gi), (match) => ({
    source: requireValue(match[1]),
    offset: match.index + match[0].indexOf(requireValue(match[1])),
  }));
}

function inspectScript(source: string, offset = 0): ScriptViolation[] {
  const code = maskNonCode(source);
  const violations: ScriptViolation[] = [];
  const codePatterns: Array<readonly [kind: string, pattern: RegExp]> = [
    ['native dialog call', /(?<![\w$.])(?:alert|confirm|prompt)\s*(?:\?\.)?\s*\(/g],
    ['native dialog call', /\b(?:window|globalThis|self|top|parent)\s*(?:\.|\?\.)\s*(?:alert|confirm|prompt)\s*(?:\?\.)?\s*\(/g],
    ['onbeforeunload registration', /(?<![\w$.])onbeforeunload\s*=/g],
    ['onbeforeunload registration', /\b(?:window|globalThis|self|top|parent)\s*(?:\.|\?\.)\s*onbeforeunload\s*=/g],
  ];
  for (const [kind, pattern] of codePatterns) {
    for (const match of code.matchAll(pattern)) violations.push({ kind, index: offset + match.index });
  }

  const listener = /(?:\b(?:window|globalThis|self)\s*(?:\.|\?\.)\s*)?addEventListener\s*\(\s*(['"`])beforeunload\1/g;
  for (const match of source.matchAll(listener)) {
    if (code[match.index] !== ' ') violations.push({ kind: 'beforeunload listener', index: offset + match.index });
  }
  return violations;
}

function inspectFile(file: string): FileViolation[] {
  const source = fs.readFileSync(file, 'utf8');
  const violations = scriptRegions(file, source).flatMap((region) => inspectScript(region.source, region.offset));
  if (path.extname(file) === '.svelte') {
    for (const match of source.matchAll(/<svelte:window\b[^>]*\bon:beforeunload\b/gi)) {
      violations.push({ kind: 'Svelte beforeunload listener', index: match.index });
    }
  }
  return violations.map((violation) => ({
    ...violation,
    file,
    line: source.slice(0, violation.index).split('\n').length,
  }));
}

assert.deepEqual(inspectScript(`const copy = 'confirm() alert() prompt() beforeunload';`), []);
assert.equal(inspectScript(`
  confirm('leave');
  window.alert('error');
  addEventListener('beforeunload', save);
  window.onbeforeunload = save;
`).length, 4);

const violations = sourceFiles(srcRoot).flatMap(inspectFile);
assert.deepEqual(
  violations.map(({ file, line, kind }) => `${path.relative(root, file)}:${line} ${kind}`),
  [],
  'production code must not contain direct native-dialog calls or beforeunload registrations',
);

console.log('ok - no direct native-dialog spellings or beforeunload registrations');
