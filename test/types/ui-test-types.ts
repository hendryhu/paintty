import assert from 'node:assert/strict';

export function requireValue<T>(
  value: T | null | undefined,
  message = 'Expected a value',
): T {
  assert.ok(value != null, message);
  return value;
}

export function requireElement<T extends Element>(
  selector: string,
  root: ParentNode = document,
): T {
  return requireValue(root.querySelector<T>(selector), `Missing element: ${selector}`);
}

type ElementConstructor<T extends Element> = abstract new (...args: never[]) => T;

export function requireInstance<T extends Element>(
  value: unknown,
  constructor: ElementConstructor<T>,
  message = `Expected ${constructor.name}`,
): T {
  assert.ok(value instanceof constructor, message);
  return value;
}

export function testRect(width: number, height: number): DOMRect {
  return DOMRect.fromRect({ x: 0, y: 0, width, height });
}

export class TestResizeObserver implements ResizeObserver {
  constructor(_callback: ResizeObserverCallback) {}

  disconnect(): void {}
  observe(_target: Element, _options?: ResizeObserverOptions): void {}
  unobserve(_target: Element): void {}
}

export function testMediaQueryList(media = ''): MediaQueryList {
  return {
    matches: false,
    media,
    onchange: null,
    addListener() {},
    removeListener() {},
    addEventListener() {},
    removeEventListener() {},
    dispatchEvent: () => true,
  };
}

export function testCanvasContext(
  methods: Partial<CanvasRenderingContext2D>,
): CanvasRenderingContext2D {
  const context: CanvasRenderingContext2D = Object.create(null);
  return Object.assign(context, methods);
}

export function testImageData(width: number, height: number, settings?: ImageDataSettings): ImageData;
export function testImageData(imageData: ImageData): ImageData;
export function testImageData(
  widthOrImageData: number | ImageData,
  height?: number,
  settings?: ImageDataSettings,
): ImageData {
  if (widthOrImageData instanceof ImageData) {
    return new ImageData(widthOrImageData.width, widthOrImageData.height, settings);
  }
  return new ImageData(widthOrImageData, requireValue(height), settings);
}

interface TestHtmlElementOptions {
  isConnected?: boolean;
  focus?: (options?: FocusOptions) => void;
  querySelector?: (selector: string) => HTMLElement | null;
}

export function testHtmlElement(options: TestHtmlElementOptions = {}): HTMLElement {
  const element: HTMLElement = Object.create(null);
  return Object.assign(element, options);
}

export function testDocument(activeElement: Element | null): Document {
  const testDocument: Document = Object.create(null);
  return Object.assign(testDocument, { activeElement });
}
