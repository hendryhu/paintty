import type {
  ExportSpec,
  FileSystemFileHandleLike,
  FileSystemWritableLike,
  SaveTarget,
} from './types/project-types.js';

const OUTPUT_EXTENSIONS = new Set([
  '.ans', '.jpeg', '.jpg', '.json', '.mp4', '.paintty', '.png', '.txt', '.zip',
]);
const WINDOWS_RESERVED_NAME = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;

const OUTPUT_SPECS = Object.freeze({
  png: Object.freeze({ extension: '.png', mime: 'image/png', description: 'PNG image' }),
  jpg: Object.freeze({ extension: '.jpg', mime: 'image/jpeg', description: 'JPG image' }),
  video: Object.freeze({ extension: '.mp4', mime: 'video/mp4', description: 'MP4 video' }),
  txt: Object.freeze({ extension: '.txt', mime: 'text/plain', description: 'Text' }),
  ansi: Object.freeze({ extension: '.ans', mime: 'text/plain', description: 'ANSI text' }),
});

type ShowSaveFilePicker = (options: {
  suggestedName: string;
  types: Array<{
    description: string;
    accept: Record<string, string[]>;
  }>;
}) => Promise<FileSystemFileHandleLike>;

interface ExportPickerOptions {
  signal?: AbortSignal;
  showSaveFilePicker?: ShowSaveFilePicker;
}

function leafName(value: unknown): string {
  const parts = String(value ?? '').replace(/\\/g, '/').split('/');
  return (parts.at(-1) || '').trim();
}

function cleanLeaf(value: unknown): string {
  return leafName(value)
    .replace(/[\u0000-\u001f\u007f<>:"/\\|?*]+/g, '-')
    .replace(/\s+/g, ' ')
    .replace(/^[. ]+|[. ]+$/g, '')
    .slice(0, 180);
}

function normalizedExtension(value: unknown): string {
  const extension = String(value || '').toLowerCase();
  if (!/^\.[a-z0-9]+$/.test(extension)) throw new TypeError('Export extension is invalid.');
  return extension;
}

function stripKnownExtensions(value: string): string {
  let name = value;
  while (true) {
    const dot = name.lastIndexOf('.');
    const extension = dot > 0 ? name.slice(dot).toLowerCase() : '';
    if (!OUTPUT_EXTENSIONS.has(extension)) return name;
    name = name.slice(0, dot);
  }
}

function sanitizeWindowsReservedStem(value: string): string {
  const dot = value.indexOf('.');
  const firstStem = dot < 0 ? value : value.slice(0, dot);
  return WINDOWS_RESERVED_NAME.test(firstStem)
    ? `${firstStem}-file${dot < 0 ? '' : value.slice(dot)}`
    : value;
}

export function sanitizeExportFilenameDraft(value: unknown): string {
  return cleanLeaf(value);
}

export function hasExportExtension(value: unknown, extension: unknown): boolean {
  const expected = normalizedExtension(extension);
  const name = cleanLeaf(value);
  return name.length > expected.length && name.toLowerCase().endsWith(expected);
}

export function normalizeExportFilename(
  value: unknown,
  extension: unknown,
  fallback: unknown = 'untitled',
): string {
  const expected = normalizedExtension(extension);
  let name = cleanLeaf(value);
  const preservesExpectedExtension = hasExportExtension(name, expected);
  let stem = preservesExpectedExtension ? name.slice(0, -expected.length) : stripKnownExtensions(name);
  stem = stem.replace(/^[. -]+|[. ]+$/g, '');
  if (!stem) {
    const fallbackName = cleanLeaf(fallback);
    stem = stripKnownExtensions(fallbackName).replace(/^[. -]+|[. ]+$/g, '') || 'untitled';
  }
  stem = sanitizeWindowsReservedStem(stem);
  stem = stem.slice(0, Math.max(1, 180 - expected.length));
  return `${stem}${preservesExpectedExtension ? name.slice(-expected.length) : expected}`;
}

export function exportOutputSpec(
  format: string,
  { includeAudio = false }: { includeAudio?: boolean } = {},
): ExportSpec {
  if (format === 'animation-json') {
    return includeAudio
      ? { extension: '.zip', mime: 'application/zip', description: 'Paintty Animation ZIP' }
      : { extension: '.json', mime: 'application/json', description: 'Paintty Animation JSON' };
  }
  const spec = Object.prototype.hasOwnProperty.call(OUTPUT_SPECS, format)
    ? OUTPUT_SPECS[format as keyof typeof OUTPUT_SPECS]
    : undefined;
  if (!spec) throw new Error(`Unknown export format: ${format}.`);
  return spec;
}

export function compatibleRetainedTarget(
  target: SaveTarget | null | undefined,
  filename: string,
  extension: string,
): SaveTarget | null {
  return target?.name === filename && hasExportExtension(filename, extension) ? target : null;
}

function abortError(signal?: AbortSignal): Error {
  if (signal?.reason instanceof Error) return signal.reason;
  if (typeof DOMException === 'function') return new DOMException('Export cancelled.', 'AbortError');
  const error = new Error('Export cancelled.');
  error.name = 'AbortError';
  return error;
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw abortError(signal);
}

function abortable<T>(promise: T | PromiseLike<T>, signal?: AbortSignal): Promise<T> {
  const pending = Promise.resolve(promise);
  if (!signal) return pending;
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const finish = <V>(callback: (value: V) => void, value: V): void => {
      if (settled) return;
      settled = true;
      signal.removeEventListener('abort', cancel);
      callback(value);
    };
    const cancel = () => finish(reject, abortError(signal));
    signal.addEventListener('abort', cancel, { once: true });
    pending.then(
      (value) => finish(resolve, value),
      (error) => finish(reject, error),
    );
    if (signal.aborted) cancel();
  });
}

async function writeFileHandle(
  handle: FileSystemFileHandleLike,
  blob: Blob,
  signal?: AbortSignal,
): Promise<void> {
  throwIfAborted(signal);
  const writablePromise = Promise.resolve().then(() => handle.createWritable());
  let writable: FileSystemWritableLike;
  try {
    writable = await abortable(writablePromise, signal);
  } catch (error) {
    if (signal?.aborted) {
      writablePromise.then((stream) => stream.abort?.(abortError(signal))).catch(() => {});
    }
    throw error;
  }

  let abortPromise: Promise<void> | null = null;
  const abortWritable = () => {
    if (abortPromise) return abortPromise;
    const abort = writable.abort;
    abortPromise = typeof abort === 'function'
      ? Promise.resolve().then(() => abort.call(writable, abortError(signal))).catch(() => {})
      : Promise.resolve();
    return abortPromise;
  };
  signal?.addEventListener('abort', abortWritable, { once: true });
  try {
    // Aborting the writable discards partial output; only close may commit the file.
    await abortable(writable.write(blob), signal);
    throwIfAborted(signal);
    await abortable(writable.close(), signal);
    throwIfAborted(signal);
  } catch (error) {
    await abortWritable();
    if (signal?.aborted) throw abortError(signal);
    throw error;
  } finally {
    signal?.removeEventListener('abort', abortWritable);
  }
}

export function createFileHandleTarget(
  handle: unknown,
  fallbackName = 'untitled',
): SaveTarget {
  if (!isFileSystemFileHandle(handle)) {
    throw new TypeError('A writable file handle is required.');
  }
  return {
    name: sanitizeExportFilenameDraft(handle.name) ||
      sanitizeExportFilenameDraft(fallbackName) || 'untitled',
    durable: true,
    async write(blob: Blob, { signal }: { signal?: AbortSignal } = {}) {
      await writeFileHandle(handle, blob, signal);
    },
  };
}

// Native picker methods require `window` as their receiver; injected test functions
// deliberately run without a browser owner.
function isFileSystemFileHandle(value: unknown): value is FileSystemFileHandleLike {
  return value !== null && typeof value === 'object' &&
    'name' in value && typeof value.name === 'string' &&
    'createWritable' in value && typeof value.createWritable === 'function';
}

function pickerOwner(options: ExportPickerOptions): {
  owner: Window | null;
  picker: ShowSaveFilePicker | undefined;
} {
  if (typeof options?.showSaveFilePicker === 'function') {
    return { owner: null, picker: options.showSaveFilePicker };
  }
  const owner = typeof window === 'undefined' ? null : window;
  const browserWindow = owner as (Window & { showSaveFilePicker?: ShowSaveFilePicker }) | null;
  return { owner, picker: browserWindow?.showSaveFilePicker };
}

export function exportPickerAvailable(options: ExportPickerOptions = {}): boolean {
  return typeof pickerOwner(options).picker === 'function';
}

export async function pickExportFileTarget(
  filename: string,
  spec: ExportSpec,
  options: ExportPickerOptions = {},
): Promise<SaveTarget | null | undefined> {
  const { owner, picker } = pickerOwner(options);
  if (typeof picker !== 'function') return undefined;
  const { signal } = options;
  throwIfAborted(signal);
  try {
    const pendingHandle = picker.call(owner, {
      suggestedName: filename,
      types: [{
        description: spec.description,
        accept: { [spec.mime]: spec.extension ? [spec.extension] : [] },
      }],
    });
    const handle = await abortable(pendingHandle, signal);
    throwIfAborted(signal);
    return createFileHandleTarget(handle, filename);
  } catch (error) {
    if (signal?.aborted) throw abortError(signal);
    if (error instanceof Error && error.name === 'AbortError') return null;
    throw error;
  }
}
