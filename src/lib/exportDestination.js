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

function leafName(value) {
  const parts = String(value ?? '').replace(/\\/g, '/').split('/');
  return (parts.at(-1) || '').trim();
}

function cleanLeaf(value) {
  return leafName(value)
    .replace(/[\u0000-\u001f\u007f<>:"/\\|?*]+/g, '-')
    .replace(/\s+/g, ' ')
    .replace(/^[. ]+|[. ]+$/g, '')
    .slice(0, 180);
}

function normalizedExtension(value) {
  const extension = String(value || '').toLowerCase();
  if (!/^\.[a-z0-9]+$/.test(extension)) throw new TypeError('Export extension is invalid.');
  return extension;
}

function stripKnownExtensions(value) {
  let name = value;
  while (true) {
    const dot = name.lastIndexOf('.');
    const extension = dot > 0 ? name.slice(dot).toLowerCase() : '';
    if (!OUTPUT_EXTENSIONS.has(extension)) return name;
    name = name.slice(0, dot);
  }
}

function sanitizeWindowsReservedStem(value) {
  const dot = value.indexOf('.');
  const firstStem = dot < 0 ? value : value.slice(0, dot);
  return WINDOWS_RESERVED_NAME.test(firstStem)
    ? `${firstStem}-file${dot < 0 ? '' : value.slice(dot)}`
    : value;
}

export function sanitizeExportFilenameDraft(value) {
  return cleanLeaf(value);
}

export function hasExportExtension(value, extension) {
  const expected = normalizedExtension(extension);
  const name = cleanLeaf(value);
  return name.length > expected.length && name.toLowerCase().endsWith(expected);
}

export function normalizeExportFilename(value, extension, fallback = 'untitled') {
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

export function exportOutputSpec(format, { includeAudio = false } = {}) {
  if (format === 'animation-json') {
    return includeAudio
      ? { extension: '.zip', mime: 'application/zip', description: 'Paintty Animation ZIP' }
      : { extension: '.json', mime: 'application/json', description: 'Paintty Animation JSON' };
  }
  const spec = OUTPUT_SPECS[format];
  if (!spec) throw new Error(`Unknown export format: ${format}.`);
  return spec;
}

export function compatibleRetainedTarget(target, filename, extension) {
  return target?.name === filename && hasExportExtension(filename, extension) ? target : null;
}

function abortError(signal) {
  if (signal?.reason instanceof Error) return signal.reason;
  if (typeof DOMException === 'function') return new DOMException('Export cancelled.', 'AbortError');
  const error = new Error('Export cancelled.');
  error.name = 'AbortError';
  return error;
}

function throwIfAborted(signal) {
  if (signal?.aborted) throw abortError(signal);
}

function abortable(promise, signal) {
  const pending = Promise.resolve(promise);
  if (!signal) return pending;
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (callback, value) => {
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

async function writeFileHandle(handle, blob, signal) {
  throwIfAborted(signal);
  const writablePromise = Promise.resolve().then(() => handle.createWritable());
  let writable;
  try {
    writable = await abortable(writablePromise, signal);
  } catch (error) {
    if (signal?.aborted) {
      writablePromise.then((stream) => stream.abort?.(abortError(signal))).catch(() => {});
    }
    throw error;
  }

  let abortPromise = null;
  const abortWritable = () => {
    if (abortPromise) return abortPromise;
    abortPromise = typeof writable.abort === 'function'
      ? Promise.resolve().then(() => writable.abort(abortError(signal))).catch(() => {})
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

export function createFileHandleTarget(handle, fallbackName = 'untitled') {
  if (!handle || typeof handle.createWritable !== 'function') {
    throw new TypeError('A writable file handle is required.');
  }
  return {
    name: sanitizeExportFilenameDraft(handle.name) ||
      sanitizeExportFilenameDraft(fallbackName) || 'untitled',
    durable: true,
    async write(blob, { signal } = {}) {
      await writeFileHandle(handle, blob, signal);
    },
  };
}

// Native picker methods require `window` as their receiver; injected test functions
// deliberately run without a browser owner.
function pickerOwner(options) {
  if (typeof options?.showSaveFilePicker === 'function') {
    return { owner: null, picker: options.showSaveFilePicker };
  }
  const owner = typeof window === 'undefined' ? null : window;
  return { owner, picker: owner?.showSaveFilePicker };
}

export function exportPickerAvailable(options = {}) {
  return typeof pickerOwner(options).picker === 'function';
}

export async function pickExportFileTarget(filename, spec, options = {}) {
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
    if (error?.name === 'AbortError') return null;
    throw error;
  }
}
