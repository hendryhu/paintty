import type { BlobLike, MediaBytesSource, Sha256 } from './types/media-types.js';

export const SHA256_PATTERN = /^[0-9a-f]{64}$/;

export function assertSha256(value: unknown, label = 'Media SHA-256'): Sha256 {
  if (typeof value !== 'string' || !SHA256_PATTERN.test(value)) {
    throw new TypeError(`${label} must be 64 lowercase hexadecimal characters.`);
  }
  return value;
}

export function mediaPackagePath(hash: unknown): string {
  const value = assertSha256(hash);
  return `assets/sha256/${value.slice(0, 2)}/${value}`;
}

export async function mediaBytes(value: MediaBytesSource | unknown): Promise<Uint8Array<ArrayBufferLike>> {
  if (value instanceof Uint8Array) {
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  }
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value)) {
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  }
  if (isBlobLike(value)) {
    return new Uint8Array(await value.arrayBuffer());
  }
  throw new TypeError('Media bytes must be a Blob, ArrayBuffer, or typed array.');
}

function isBlobLike(value: unknown): value is BlobLike {
  return value !== null && typeof value === 'object' &&
    'arrayBuffer' in value && typeof value.arrayBuffer === 'function';
}

export async function sha256Hex(
  value: MediaBytesSource | unknown,
  crypto: Crypto | undefined = globalThis.crypto,
): Promise<Sha256> {
  const bytes = await mediaBytes(value);
  if (typeof crypto?.subtle?.digest !== 'function') {
    throw new Error('SHA-256 is unavailable in this browser.');
  }
  const digest = await crypto.subtle.digest(
    'SHA-256',
    bytes.buffer.slice(
      bytes.byteOffset,
      bytes.byteOffset + bytes.byteLength,
    ) as ArrayBuffer,
  );
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}
