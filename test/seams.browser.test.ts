import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-chromium';
import type { Locator, Page } from 'playwright-chromium';
import { createServer } from 'vite';
import { requireValue } from './types/ui-test-types.ts';

type Rgb = readonly [red: number, green: number, blue: number];
type Pixel = number[];
type SeamPattern = 'solid' | 'checker' | 'sparse' | 'survey';
type SeamSurface = 'background' | 'glyph';

interface SeamFixture {
  id: string;
  colors: string[];
  columns: number;
  rows: number;
  cellW: number;
  cellH: number;
  pattern: SeamPattern;
  surface: SeamSurface;
  mask?: string[] | undefined;
  glyph?: string | undefined;
  horizontalBands?: boolean[] | undefined;
  verticalBands?: boolean[] | undefined;
  terminationLeak?: number | undefined;
}

interface FixtureSnapshot extends SeamFixture {
  left: number;
  top: number;
  width: number;
  height: number;
}

interface SeamSuiteSnapshot {
  width: number;
  height: number;
  fixtures: FixtureSnapshot[];
}

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const server = await createServer({
  root,
  logLevel: 'error',
  optimizeDeps: { noDiscovery: true },
  server: { host: '127.0.0.1', port: 0, strictPort: false },
});
await server.listen();
const address = requireValue(server.httpServer).address();
assert.ok(address && typeof address !== 'string', 'Vite must listen on a TCP port');
const base = `http://127.0.0.1:${address.port}`;
const browser = await chromium.launch({ headless: true });

async function scanScreenshot(
  page: Page,
  locator: Locator,
  suite: SeamSuiteSnapshot,
  dpr: number,
): Promise<number> {
  const buffer = await locator.screenshot({ type: 'png' });
  const result = await page.evaluate(async ({ base64, suite, dpr }) => {
    const colors = {
      rgb(hex: string): Rgb {
        return [
          Number.parseInt(hex.slice(1, 3), 16),
          Number.parseInt(hex.slice(3, 5), 16),
          Number.parseInt(hex.slice(5, 7), 16),
        ];
      },
      distance(pixel: Pixel, expected: Rgb): number {
        return Math.max(...expected.map(
          (value, index) => Math.abs((pixel[index] ?? 0) - value),
        ));
      },
      nearExpectedOrBlend(pixel: Pixel, expectedColors: ReadonlyArray<Rgb>, tolerance = 6): boolean {
        if (expectedColors.some((color) => this.distance(pixel, color) <= tolerance)) return true;
        for (let leftIndex = 0; leftIndex < expectedColors.length; leftIndex++) {
          for (let rightIndex = leftIndex + 1; rightIndex < expectedColors.length; rightIndex++) {
            const left = expectedColors[leftIndex]!;
            const right = expectedColors[rightIndex]!;
            const direction = right.map((value, channel) => value - left[channel]!);
            const denominator = direction.reduce((sum, value) => sum + value * value, 0);
            if (!denominator) continue;
            const offset = direction.reduce((sum, value, channel) =>
              sum + ((pixel[channel] ?? 0) - left[channel]!) * value, 0);
            const position = Math.max(0, Math.min(1, offset / denominator));
            const expected = left.map((value, channel) => value + direction[channel]! * position);
            if (Math.max(...expected.map((value, channel) =>
              Math.abs((pixel[channel] ?? 0) - value))) <= tolerance) return true;
          }
        }
        return false;
      },
    };
    const bytes = Uint8Array.from(atob(base64), (char) => char.charCodeAt(0));
    const bitmap = await createImageBitmap(new Blob([bytes], { type: 'image/png' }));
    const canvas = document.createElement('canvas');
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    const context = canvas.getContext('2d', { willReadFrequently: true });
    if (!context) throw new Error('2D screenshot decoder context is unavailable');
    context.drawImage(bitmap, 0, 0);
    bitmap.close();
    const image = context.getImageData(0, 0, canvas.width, canvas.height);
    const suiteScaleX = image.width / suite.width;
    const suiteScaleY = image.height / suite.height;
    const pixels = {
      at(x: number, y: number): Pixel {
        const offset = (y * image.width + x) * 4;
        return [image.data[offset]!, image.data[offset + 1]!, image.data[offset + 2]!, image.data[offset + 3]!];
      },
    };
    let scanned = 0;

    for (const fixture of suite.fixtures) {
      const originX = Math.round(fixture.left * suiteScaleX);
      const originY = Math.round(fixture.top * suiteScaleY);
      const imageWidth = Math.round((fixture.left + fixture.width) * suiteScaleX) - originX;
      const imageHeight = Math.round((fixture.top + fixture.height) * suiteScaleY) - originY;
      const scaleX = imageWidth / fixture.width;
      const scaleY = imageHeight / fixture.height;
      const expectedColors = fixture.colors.map((hex) => colors.rgb(hex));
      const marginX = Math.max(3, Math.ceil(scaleX * 4));
      const marginY = Math.max(3, Math.ceil(scaleY * 4));
      const fixturePixels = {
        at(x: number, y: number): Pixel {
          return pixels.at(originX + x, originY + y);
        },
        coverageAt(x: number, y: number, background: Rgb, foreground: Rgb): number {
          const pixel = this.at(x, y);
          const direction = foreground.map((value, channel) => value - background[channel]!);
          const denominator = direction.reduce((sum, value) => sum + value * value, 0);
          const offset = direction.reduce((sum, value, channel) =>
            sum + ((pixel[channel] ?? 0) - background[channel]!) * value, 0);
          return Math.max(0, Math.min(1, offset / denominator));
        },
        failure(message: string, x: number, y: number, pixel: Pixel): string {
          const glyph = fixture.glyph
            ? `, U+${fixture.glyph.codePointAt(0)!.toString(16).toUpperCase()}`
            : '';
          const center = this.at(Math.floor(imageWidth / 2), Math.floor(imageHeight / 2));
          return `${fixture.id} ${fixture.surface} ${message} at DPR ${dpr}, ${fixture.cellW}x${fixture.cellH}${glyph}, ${x},${y}: ${pixel}; center=${center}`;
        },
        expectedAt(column: number, row: number): Rgb {
          if (fixture.pattern === 'sparse') {
            return fixture.mask?.[row]?.[column] === '#' ? expectedColors[1]! : expectedColors[0]!;
          }
          return fixture.pattern === 'solid'
            ? expectedColors[0]!
            : expectedColors[(column + row) % 2]!;
        },
      };

      if (fixture.pattern === 'survey') {
        const background = expectedColors[0]!;
        const foreground = expectedColors[1]!;
        for (let column = 1; column < fixture.columns; column++) {
          const boundary = Math.round(column * fixture.cellW * scaleX);
          if (boundary < 2 || boundary + 1 >= imageWidth) continue;
          for (let y = marginY; y < imageHeight - marginY; y++) {
            const glyphRow = Math.min(fixture.horizontalBands?.length || 1, Math.floor(
              ((y + 0.5) / scaleY % fixture.cellH),
            ) + 1) - 1;
            if (fixture.horizontalBands && !fixture.horizontalBands[glyphRow]) continue;
            const reference = Math.min(
              fixturePixels.coverageAt(boundary - 2, y, background, foreground),
              fixturePixels.coverageAt(boundary + 1, y, background, foreground),
            );
            if (reference < 0.08) continue;
            for (const x of [boundary - 1, boundary]) {
              const pixel = fixturePixels.at(x, y);
              if (pixel[3] !== 255 ||
                fixturePixels.coverageAt(x, y, background, foreground) + 0.2 < reference) {
                return { scanned, error: fixturePixels.failure('vertical coverage valley', x, y, pixel) };
              }
              scanned++;
            }
          }
        }
        for (let row = 1; row < fixture.rows; row++) {
          const boundary = Math.round(row * fixture.cellH * scaleY);
          if (boundary < 2 || boundary + 1 >= imageHeight) continue;
          for (let x = marginX; x < imageWidth - marginX; x++) {
            const glyphColumn = Math.min(fixture.verticalBands?.length || 1, Math.floor(
              ((x + 0.5) / scaleX % fixture.cellW),
            ) + 1) - 1;
            if (fixture.verticalBands && !fixture.verticalBands[glyphColumn]) continue;
            const reference = Math.min(
              fixturePixels.coverageAt(x, boundary - 2, background, foreground),
              fixturePixels.coverageAt(x, boundary + 1, background, foreground),
            );
            if (reference < 0.08) continue;
            for (const y of [boundary - 1, boundary]) {
              const pixel = fixturePixels.at(x, y);
              if (pixel[3] !== 255 ||
                fixturePixels.coverageAt(x, y, background, foreground) + 0.2 < reference) {
                return { scanned, error: fixturePixels.failure('horizontal coverage valley', x, y, pixel) };
              }
              scanned++;
            }
          }
        }
        continue;
      }

      for (let y = marginY; y < imageHeight - marginY; y++) {
        for (let x = marginX; x < imageWidth - marginX; x++) {
          const logicalX = (x + 0.5) / scaleX;
          const logicalY = (y + 0.5) / scaleY;
          const column = Math.min(fixture.columns - 1, Math.floor(logicalX / fixture.cellW));
          const row = Math.min(fixture.rows - 1, Math.floor(logicalY / fixture.cellH));
          const expected = fixturePixels.expectedAt(column, row);
          const pixel = fixturePixels.at(x, y);
          const candidates = [expected];
          if (fixture.pattern !== 'solid') {
            const sampleX = x + 0.5;
            const sampleY = y + 0.5;
            const left = column * fixture.cellW * scaleX;
            const right = (column + 1) * fixture.cellW * scaleX;
            const top = row * fixture.cellH * scaleY;
            const bottom = (row + 1) * fixture.cellH * scaleY;
            const nearLeft = column > 0 && sampleX - left <= 2.5;
            const nearRight = column + 1 < fixture.columns && right - sampleX <= 2.5;
            const nearTop = row > 0 && sampleY - top <= 2.5;
            const nearBottom = row + 1 < fixture.rows && bottom - sampleY <= 2.5;
            if (nearLeft) {
              candidates.push(fixturePixels.expectedAt(column - 1, row));
            }
            if (nearRight) {
              candidates.push(fixturePixels.expectedAt(column + 1, row));
            }
            if (nearTop) {
              candidates.push(fixturePixels.expectedAt(column, row - 1));
            }
            if (nearBottom) {
              candidates.push(fixturePixels.expectedAt(column, row + 1));
            }
            if (nearLeft && nearTop) candidates.push(fixturePixels.expectedAt(column - 1, row - 1));
            if (nearLeft && nearBottom) candidates.push(fixturePixels.expectedAt(column - 1, row + 1));
            if (nearRight && nearTop) candidates.push(fixturePixels.expectedAt(column + 1, row - 1));
            if (nearRight && nearBottom) candidates.push(fixturePixels.expectedAt(column + 1, row + 1));
          }
          if (pixel[3] !== 255) {
            return { scanned, error: fixturePixels.failure('transparent seam', x, y, pixel) };
          }
          if (fixture.pattern === 'solid'
            ? colors.distance(pixel, expected) > 6
            : !colors.nearExpectedOrBlend(pixel, candidates)) {
            const neighbors = [-2, -1, 0, 1, 2]
              .filter((offset) => x + offset >= 0 && x + offset < imageWidth)
              .map((offset) => fixturePixels.at(x + offset, y).slice(0, 3).join('/'))
              .join(' ');
            return { scanned, error: fixturePixels.failure(
              `${fixture.pattern === 'checker' ? 'third-color gap' :
                (fixture.pattern === 'sparse' ? 'sparse boundary gap' : 'solid seam')} [${neighbors}]`,
              x, y, pixel,
            ) };
          }
          scanned++;
        }
      }

      for (let column = 1; column < fixture.columns; column++) {
        const boundary = Math.round(column * fixture.cellW * scaleX);
        for (const x of [boundary - 1, boundary]) {
          for (let y = marginY; y < imageHeight - marginY; y++) {
            const logicalY = (y + 0.5) / scaleY;
            const rowOffset = logicalY % fixture.cellH;
            if (fixture.pattern === 'sparse' &&
              Math.min(rowOffset, fixture.cellH - rowOffset) * scaleY <= 2.5) continue;
            const pixel = fixturePixels.at(x, y);
            const row = Math.min(fixture.rows - 1,
              Math.floor(logicalY / fixture.cellH));
            const boundaryColors = [
              fixturePixels.expectedAt(column - 1, row),
              fixturePixels.expectedAt(column, row),
            ];
            if (pixel[3] !== 255 || !colors.nearExpectedOrBlend(pixel, boundaryColors)) {
              return { scanned, error: fixturePixels.failure('vertical boundary gap', x, y, pixel) };
            }
          }
        }
      }
      for (let row = 1; row < fixture.rows; row++) {
        const boundary = Math.round(row * fixture.cellH * scaleY);
        for (const y of [boundary - 1, boundary]) {
          for (let x = marginX; x < imageWidth - marginX; x++) {
            const logicalX = (x + 0.5) / scaleX;
            const columnOffset = logicalX % fixture.cellW;
            if (fixture.pattern === 'sparse' &&
              Math.min(columnOffset, fixture.cellW - columnOffset) * scaleX <= 2.5) continue;
            const pixel = fixturePixels.at(x, y);
            const column = Math.min(fixture.columns - 1,
              Math.floor(logicalX / fixture.cellW));
            const boundaryColors = [
              fixturePixels.expectedAt(column, row - 1),
              fixturePixels.expectedAt(column, row),
            ];
            if (pixel[3] !== 255 || !colors.nearExpectedOrBlend(pixel, boundaryColors)) {
              return { scanned, error: fixturePixels.failure('horizontal boundary gap', x, y, pixel) };
            }
          }
        }
      }

      if (fixture.pattern === 'sparse' && fixture.mask) {
        const white = expectedColors[1]!;
        for (let row = 0; row < fixture.rows; row++) {
          let runStart = -1;
          for (let column = 0; column <= fixture.columns; column++) {
            const isolatedWhite = column < fixture.columns && fixture.mask[row]?.[column] === '#' &&
              fixture.mask[row - 1]?.[column] !== '#' && fixture.mask[row + 1]?.[column] !== '#';
            if (isolatedWhite && runStart < 0) runStart = column;
            if (isolatedWhite || runStart < 0) continue;
            if (column - runStart > 1) {
              const referenceX = Math.floor((runStart + 0.5) * fixture.cellW * scaleX);
              const runTop = Math.max(0, Math.round(row * fixture.cellH * scaleY) - 2);
              const runBottom = Math.min(imageHeight,
                Math.round((row + 1) * fixture.cellH * scaleY) + 2);
              for (let peer = runStart + 1; peer < column; peer++) {
                const peerX = Math.floor((peer + 0.5) * fixture.cellW * scaleX);
                for (let y = runTop; y < runBottom; y++) {
                  const referenceWhite = colors.distance(fixturePixels.at(referenceX, y), white) <= 6;
                  const peerWhite = colors.distance(fixturePixels.at(peerX, y), white) <= 6;
                  if (referenceWhite !== peerWhite) {
                    return { scanned, error: fixturePixels.failure(
                      `uneven glyph height in row ${row} against x=${referenceX} (${fixturePixels.at(referenceX, y)})`,
                      peerX, y, fixturePixels.at(peerX, y),
                    ) };
                  }
                }
              }
            }
            runStart = -1;
          }
        }
      }
    }

    return { scanned, error: null };
  }, { base64: buffer.toString('base64'), suite, dpr });
  assert.equal(result.error, null, result.error || undefined);
  return result.scanned;
}

async function runDpr(dpr: number): Promise<number> {
  const context = await browser.newContext({
    viewport: { width: 800, height: 600 },
    deviceScaleFactor: dpr,
  });
  try {
    const page = await context.newPage();
    await page.goto(`${base}/test/browser/seam.html`);
    await page.waitForFunction(() => Reflect.get(window, 'seamSuite'));
    const suite = await page.evaluate<SeamSuiteSnapshot>(() => {
      const container = document.querySelector('#fixtures');
      if (!(container instanceof HTMLElement)) throw new Error('Seam fixture container is unavailable');
      const containerBounds = container.getBoundingClientRect();
      const state = Reflect.get(window, 'seamSuite') as { fixtures: SeamFixture[] };
      return {
        width: containerBounds.width,
        height: containerBounds.height,
        fixtures: state.fixtures.map((fixture) => {
          const canvas = document.getElementById(fixture.id);
          if (!(canvas instanceof HTMLCanvasElement)) throw new Error(`Missing fixture ${fixture.id}`);
          const bounds = canvas.getBoundingClientRect();
          return {
            ...fixture,
            left: bounds.left - containerBounds.left,
            top: bounds.top - containerBounds.top,
            width: bounds.width,
            height: bounds.height,
          };
        }),
      };
    });
    for (const fixture of suite.fixtures) {
      if (fixture.pattern === 'sparse') {
        assert.ok((fixture.terminationLeak || 0) <= 2,
          `${fixture.id} added ${fixture.terminationLeak} foreground levels inside an empty cell`);
      }
    }
    let scanned = 0;
    for (const fixture of suite.fixtures) {
      scanned += await scanScreenshot(page, page.locator(`#${fixture.id}`), {
        width: fixture.width,
        height: fixture.height,
        fixtures: [{ ...fixture, left: 0, top: 0 }],
      }, dpr);
    }
    return scanned;
  } finally {
    await context.close();
  }
}

try {
  let scanned = 0;
  for (const dpr of [0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2]) {
    scanned += await runDpr(dpr);
  }
  console.log(`Browser seam scanner passed across ${scanned.toLocaleString()} screenshot pixels.`);
} finally {
  await browser.close();
  await server.close();
}
