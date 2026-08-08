export const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function isUuid(value) {
  return typeof value === 'string' && UUID_PATTERN.test(value);
}

export function assertUuid(value, label = 'UUID') {
  if (!isUuid(value)) throw new TypeError(`${label} must be an RFC 4122 UUID.`);
  return value;
}

export function uuidKey(value) {
  return assertUuid(value).toLowerCase();
}

export function uuidFromCrypto(crypto = globalThis.crypto) {
  if (typeof crypto?.randomUUID === 'function') {
    return assertUuid(crypto.randomUUID.call(crypto), 'Generated UUID');
  }
  if (typeof crypto?.getRandomValues !== 'function') {
    throw new Error('Secure UUID generation is unavailable.');
  }
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = [...bytes].map((byte) => byte.toString(16).padStart(2, '0'));
  return [
    hex.slice(0, 4).join(''),
    hex.slice(4, 6).join(''),
    hex.slice(6, 8).join(''),
    hex.slice(8, 10).join(''),
    hex.slice(10).join(''),
  ].join('-');
}

let generateUuid = () => uuidFromCrypto();

export function newUuid(kind = 'entity') {
  return assertUuid(generateUuid(kind), `Generated ${kind} UUID`);
}

export function setUuidGenerator(generator) {
  if (typeof generator !== 'function') throw new TypeError('UUID generator must be a function.');
  const previous = generateUuid;
  generateUuid = generator;
  return () => { generateUuid = previous; };
}
