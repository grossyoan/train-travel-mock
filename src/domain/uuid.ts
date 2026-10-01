/** RFC 4122 / RFC 9562 helpers. Name-based (v5) UUIDs give stable ids for generated data. */

/** The RFC 4122 URL namespace: names below are URLs, so they never collide with other generators. */
const URL_NAMESPACE = "6ba7b811-9dad-11d1-80b4-00c04fd430c8";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(value: string): boolean {
  return UUID_PATTERN.test(value);
}

function toBytes(uuid: string): Uint8Array {
  const hex = uuid.replaceAll("-", "");
  return Uint8Array.from({ length: 16 }, (_, index) => Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16));
}

function format(bytes: Uint8Array): string {
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

/** UUID v5 (SHA-1, name-based) of `name` in the URL namespace. */
export async function uuidV5(name: string): Promise<string> {
  const namespace = toBytes(URL_NAMESPACE);
  const encoded = new TextEncoder().encode(name);
  const input = new Uint8Array(namespace.length + encoded.length);
  input.set(namespace);
  input.set(encoded, namespace.length);
  const hash = new Uint8Array(await crypto.subtle.digest("SHA-1", input)).slice(0, 16);
  hash[6] = ((hash[6] ?? 0) & 0x0f) | 0x50;
  hash[8] = ((hash[8] ?? 0) & 0x3f) | 0x80;
  return format(hash);
}
