export const SHA256_PATTERN = /^[0-9a-f]{64}$/;

export function assertSha256(value, label = 'Media SHA-256') {
  if (typeof value !== 'string' || !SHA256_PATTERN.test(value)) {
    throw new TypeError(`${label} must be 64 lowercase hexadecimal characters.`);
  }
  return value;
}

export function mediaPackagePath(hash) {
  const value = assertSha256(hash);
  return `assets/sha256/${value.slice(0, 2)}/${value}`;
}

export async function mediaBytes(value) {
  if (value instanceof Uint8Array) {
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  }
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value)) {
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  }
  if (value && typeof value.arrayBuffer === 'function') {
    return new Uint8Array(await value.arrayBuffer());
  }
  throw new TypeError('Media bytes must be a Blob, ArrayBuffer, or typed array.');
}

export async function sha256Hex(value, crypto = globalThis.crypto) {
  const bytes = await mediaBytes(value);
  if (typeof crypto?.subtle?.digest !== 'function') {
    throw new Error('SHA-256 is unavailable in this browser.');
  }
  const digest = await crypto.subtle.digest(
    'SHA-256',
    bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
  );
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}
