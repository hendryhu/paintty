import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { cleanup, render } from '@testing-library/svelte';
import Icon from '../src/components/Icon.svelte';
import { ICON_DATA } from '../src/lib/iconData.js';

const sourceRoot = join(process.cwd(), 'src');
const iconDataPath = join(sourceRoot, 'lib/iconData.js');
const iconLiteralPattern = /(['"`])((?:material-symbols|mdi|ph):[a-zA-Z0-9_-]+)\1/g;

function sourceFiles(directory) {
  return readdirSync(directory)
    .map((name) => join(directory, name))
    .flatMap((entry) => (statSync(entry).isDirectory() ? sourceFiles(entry) : [entry]))
    .filter((entry) => /\.(?:svelte|js|ts)$/.test(entry))
    .filter((entry) => entry !== iconDataPath);
}

const scannedSource = sourceFiles(sourceRoot).map((path) => ({
  path,
  text: readFileSync(path, 'utf8'),
}));

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('offline icon coverage', () => {
  test('bundles exactly the icon string literals and dynamic known values used by source', () => {
    const usedNames = new Set();
    for (const { text } of scannedSource) {
      for (const match of text.matchAll(iconLiteralPattern)) usedNames.add(match[2]);
    }

    expect(Object.keys(ICON_DATA).sort()).toEqual([...usedNames].sort());
  });

  test('uses only the network-free Iconify entry', () => {
    for (const { path, text } of scannedSource) {
      expect(text, path).not.toMatch(/from\s+['"]@iconify\/svelte['"]/);
    }
  });

  test('preserves the noncanonical effect-track name without duplicating icon data', () => {
    expect(ICON_DATA['material-symbols:auto-fix-high-outline'])
      .toBe(ICON_DATA['material-symbols:auto-fix-high']);
  });
});

describe('offline icon rendering', () => {
  test.each([
    ['material-symbols:add-rounded', 'Material Symbols'],
    ['mdi:ghost-outline', 'Material Design Icons'],
    ['ph:line-segment-fill', 'Phosphor'],
  ])('renders %s geometry and forwards SVG props', (name, label) => {
    const mounted = render(Icon, {
      icon: name,
      width: '19',
      class: 'icon-probe',
      'data-provider': label,
      'aria-hidden': 'false',
      'aria-label': label,
    });
    const svg = mounted.container.querySelector('svg');
    const data = ICON_DATA[name];
    const left = data.left ?? 0;
    const top = data.top ?? 0;
    const width = data.width ?? 16;
    const height = data.height ?? 16;

    expect(svg).not.toBeNull();
    expect(svg.getAttribute('viewBox')).toBe(`${left} ${top} ${width} ${height}`);
    expect(svg.getAttribute('width')).toBe('19');
    expect(svg.getAttribute('height')).toBe('19');
    expect(svg.getAttribute('class')).toBe('icon-probe');
    expect(svg.getAttribute('data-provider')).toBe(label);
    expect(svg.getAttribute('aria-hidden')).toBeNull();
    expect(svg.getAttribute('aria-label')).toBe(label);
    expect(svg.querySelector('path, circle, rect, line, polygon, polyline')).not.toBeNull();
  });

  test('renders a visible diagnostic and never delegates a missing name', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const mounted = render(Icon, { icon: 'mdi:not-bundled', width: '17', class: 'missing' });
    const svg = mounted.container.querySelector('[data-missing-icon="mdi:not-bundled"]');

    expect(svg).not.toBeNull();
    expect(svg.getAttribute('width')).toBe('17');
    expect(svg.getAttribute('class')).toBe('missing');
    expect(svg.querySelector('rect').getAttribute('fill')).toBe('#ff00ff');
    expect(error).toHaveBeenCalledWith('Missing bundled icon: mdi:not-bundled');
  });
});
