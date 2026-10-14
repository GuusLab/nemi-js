/**
 * Key conversion between the camelCase used in TypeScript and the snake_case
 * used on the wire. Only keys that look like identifiers are converted, so
 * cell references such as `A1` and other data keys pass through untouched.
 * Values under keys listed in OPAQUE_KEYS are copied as is: they are maps of
 * user data, not API fields.
 */

const OPAQUE_KEYS = new Set(["cells", "answers", "metadata", "headers", "elements"]);

export function camelToSnakeKey(key: string): string {
  if (!/^[a-z][a-zA-Z0-9]*$/.test(key)) return key;
  return key.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);
}

export function snakeToCamelKey(key: string): string {
  if (!/^[a-z][a-z0-9]*(_[a-z0-9]+)+$/.test(key)) return key;
  return key.replace(/_([a-z0-9])/g, (_, c: string) => c.toUpperCase());
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object") return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function convert(value: unknown, keyFn: (k: string) => string): unknown {
  if (Array.isArray(value)) return value.map((v) => convert(v, keyFn));
  if (!isPlainObject(value)) return value;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value)) {
    const nk = keyFn(k);
    out[nk] = OPAQUE_KEYS.has(k) || OPAQUE_KEYS.has(nk) ? v : convert(v, keyFn);
  }
  return out;
}

/** Deeply convert object keys from camelCase to snake_case. */
export function toSnake<T = unknown>(value: unknown): T {
  return convert(value, camelToSnakeKey) as T;
}

/** Deeply convert object keys from snake_case to camelCase. */
export function toCamel<T = unknown>(value: unknown): T {
  return convert(value, snakeToCamelKey) as T;
}
