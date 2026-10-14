import { NemiError } from "./errors";

/** The `fetch` signature the SDK needs. Pass your own to use a custom agent or a test double. */
export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

/** The parts of WebCrypto the SDK uses. `globalThis.crypto` fits, so does Node's `webcrypto`. */
export interface CryptoLike {
  getRandomValues<T extends ArrayBufferView>(array: T): T;
  subtle: SubtleCrypto;
}

export function resolveFetch(custom?: FetchLike): FetchLike {
  if (custom) return custom;
  const f = (globalThis as { fetch?: FetchLike }).fetch;
  if (typeof f !== "function") {
    throw new NemiError("No global fetch found. Pass `fetch` in the options (Node 18+ has it built in).");
  }
  return (input, init) => f(input, init);
}

export function resolveCrypto(custom?: CryptoLike): CryptoLike {
  if (custom) return custom;
  const c = (globalThis as { crypto?: CryptoLike }).crypto;
  if (!c || typeof c.getRandomValues !== "function" || !c.subtle) {
    throw new NemiError(
      "No WebCrypto found. Pass `crypto` in the options, for example `crypto: (await import('node:crypto')).webcrypto` on Node 18, or use `@guuslab/nemi/server` which does this for you.",
    );
  }
  return c;
}

const B64URL = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
const B64URL_LOOKUP: Record<string, number> = {};
for (let i = 0; i < B64URL.length; i++) B64URL_LOOKUP[B64URL[i] as string] = i;
// Accept standard base64 too, so a JWK with `+` or `/` still decodes.
B64URL_LOOKUP["+"] = 62;
B64URL_LOOKUP["/"] = 63;

/** Base64url without padding, pure JS so it runs where `btoa` and `Buffer` do not. */
export function base64UrlEncode(bytes: Uint8Array): string {
  let out = "";
  let i = 0;
  for (; i + 2 < bytes.length; i += 3) {
    const n = ((bytes[i] as number) << 16) | ((bytes[i + 1] as number) << 8) | (bytes[i + 2] as number);
    out += B64URL[(n >> 18) & 63]! + B64URL[(n >> 12) & 63]! + B64URL[(n >> 6) & 63]! + B64URL[n & 63]!;
  }
  const rest = bytes.length - i;
  if (rest === 1) {
    const n = (bytes[i] as number) << 16;
    out += B64URL[(n >> 18) & 63]! + B64URL[(n >> 12) & 63]!;
  } else if (rest === 2) {
    const n = ((bytes[i] as number) << 16) | ((bytes[i + 1] as number) << 8);
    out += B64URL[(n >> 18) & 63]! + B64URL[(n >> 12) & 63]! + B64URL[(n >> 6) & 63]!;
  }
  return out;
}

export function base64UrlDecode(input: string): Uint8Array {
  const clean = input.replace(/=+$/, "");
  const out = new Uint8Array(Math.floor((clean.length * 3) / 4));
  let buffer = 0;
  let bits = 0;
  let o = 0;
  for (const ch of clean) {
    const v = B64URL_LOOKUP[ch];
    if (v === undefined) throw new NemiError("Invalid base64url input");
    buffer = (buffer << 6) | v;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out[o++] = (buffer >> bits) & 0xff;
    }
  }
  return out.subarray(0, o);
}

// TextEncoder and TextDecoder are missing on some React Native engines, so a
// small pure JS fallback is used when they are not there.
export function utf8Encode(s: string): Uint8Array {
  if (typeof TextEncoder !== "undefined") return new TextEncoder().encode(s);
  const out: number[] = [];
  for (const ch of s) {
    const cp = ch.codePointAt(0) as number;
    if (cp < 0x80) out.push(cp);
    else if (cp < 0x800) out.push(0xc0 | (cp >> 6), 0x80 | (cp & 63));
    else if (cp < 0x10000) out.push(0xe0 | (cp >> 12), 0x80 | ((cp >> 6) & 63), 0x80 | (cp & 63));
    else out.push(0xf0 | (cp >> 18), 0x80 | ((cp >> 12) & 63), 0x80 | ((cp >> 6) & 63), 0x80 | (cp & 63));
  }
  return new Uint8Array(out);
}

export function utf8Decode(b: Uint8Array): string {
  if (typeof TextDecoder !== "undefined") return new TextDecoder().decode(b);
  let out = "";
  for (let i = 0; i < b.length; ) {
    const c = b[i++] as number;
    let cp: number;
    if (c < 0x80) cp = c;
    else if (c < 0xe0) cp = ((c & 31) << 6) | ((b[i++] as number) & 63);
    else if (c < 0xf0) cp = ((c & 15) << 12) | (((b[i++] as number) & 63) << 6) | ((b[i++] as number) & 63);
    else
      cp =
        ((c & 7) << 18) |
        (((b[i++] as number) & 63) << 12) |
        (((b[i++] as number) & 63) << 6) |
        ((b[i++] as number) & 63);
    out += String.fromCodePoint(cp);
  }
  return out;
}

export function randomString(crypto: CryptoLike, byteLength = 32): string {
  const bytes = new Uint8Array(byteLength);
  crypto.getRandomValues(bytes);
  return base64UrlEncode(bytes);
}

export async function sha256(crypto: CryptoLike, data: string | Uint8Array): Promise<Uint8Array> {
  const bytes = typeof data === "string" ? utf8Encode(data) : data;
  const digest = await crypto.subtle.digest("SHA-256", bytes as BufferSource);
  return new Uint8Array(digest);
}

export const defaultSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

type QueryValue = string | number | boolean | null | undefined;

/**
 * `a=1&b=2` built with encodeURIComponent. URLSearchParams is avoided on
 * purpose: React Native ships an incomplete implementation.
 */
export function encodeQuery(params: Record<string, QueryValue>): string {
  const parts: string[] = [];
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null) continue;
    parts.push(`${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`);
  }
  return parts.join("&");
}

export function appendQuery(url: string, params: Record<string, QueryValue>): string {
  const q = encodeQuery(params);
  if (!q) return url;
  return url + (url.includes("?") ? "&" : "?") + q;
}

/** Parse the query string of a URL into a plain object, without relying on URL or URLSearchParams. */
export function parseQuery(url: string): Record<string, string> {
  const hashIndex = url.indexOf("#");
  const withoutHash = hashIndex >= 0 ? url.slice(0, hashIndex) : url;
  const q = withoutHash.indexOf("?");
  const out: Record<string, string> = {};
  if (q < 0) return out;
  for (const part of withoutHash.slice(q + 1).split("&")) {
    if (!part) continue;
    const eq = part.indexOf("=");
    const k = eq >= 0 ? part.slice(0, eq) : part;
    const v = eq >= 0 ? part.slice(eq + 1) : "";
    out[decodeURIComponent(k.replace(/\+/g, " "))] = decodeURIComponent(v.replace(/\+/g, " "));
  }
  return out;
}

export function trimTrailingSlash(s: string): string {
  return s.replace(/\/+$/, "");
}
