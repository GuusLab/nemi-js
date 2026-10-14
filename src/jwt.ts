import { NemiOAuthError } from "./errors";
import { base64UrlDecode, base64UrlEncode, type CryptoLike, sha256, utf8Decode, utf8Encode } from "./runtime";
import type { IdTokenClaims } from "./types";

export interface Jwk {
  kty: string;
  kid?: string;
  crv?: string;
  x?: string;
  y?: string;
  alg?: string;
  use?: string;
  [k: string]: unknown;
}

export interface Jwks {
  keys: Jwk[];
}

export interface DecodedJwt {
  header: { alg?: string; kid?: string; typ?: string; [k: string]: unknown };
  payload: Record<string, unknown>;
  signingInput: Uint8Array;
  signature: Uint8Array;
}

function bad(description: string, cause?: unknown): NemiOAuthError {
  return new NemiOAuthError("invalid_id_token", description, { cause });
}

/** Split and decode a compact JWS without verifying it. */
export function decodeJwt(token: string): DecodedJwt {
  const parts = token.split(".");
  if (parts.length !== 3) throw bad("The token is not a compact JWS");
  const [h, p, s] = parts as [string, string, string];
  try {
    return {
      header: JSON.parse(utf8Decode(base64UrlDecode(h))),
      payload: JSON.parse(utf8Decode(base64UrlDecode(p))),
      signingInput: utf8Encode(`${h}.${p}`),
      signature: base64UrlDecode(s),
    };
  } catch (err) {
    throw bad("The token could not be decoded", err);
  }
}

/** Import a P-256 public JWK. Only kty, crv, x and y are passed: extra members trip some runtimes. */
export function importEs256Key(crypto: CryptoLike, jwk: Jwk): Promise<CryptoKey> {
  if (jwk.kty !== "EC" || jwk.crv !== "P-256" || !jwk.x || !jwk.y) {
    throw bad(`Key ${jwk.kid ?? "(no kid)"} is not a P-256 EC key`);
  }
  return crypto.subtle.importKey(
    "jwk",
    { kty: "EC", crv: "P-256", x: jwk.x, y: jwk.y } as JsonWebKey,
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["verify"],
  );
}

/** ES256 signatures in JWS are raw r||s, which is exactly what WebCrypto expects. */
export function verifyEs256(crypto: CryptoLike, key: CryptoKey, decoded: DecodedJwt): Promise<boolean> {
  if (decoded.signature.length !== 64) return Promise.resolve(false);
  return crypto.subtle.verify(
    { name: "ECDSA", hash: "SHA-256" },
    key,
    decoded.signature as BufferSource,
    decoded.signingInput as BufferSource,
  );
}

export interface ClaimChecks {
  issuer: string;
  audience: string;
  nonce?: string;
  clockToleranceSeconds: number;
  now: number;
  maxAgeSeconds?: number;
}

export function checkClaims(payload: Record<string, unknown>, checks: ClaimChecks): IdTokenClaims {
  const nowSec = Math.floor(checks.now / 1000);
  const leeway = checks.clockToleranceSeconds;
  if (payload.iss !== checks.issuer) throw bad(`Unexpected issuer ${String(payload.iss)}`);
  const aud = payload.aud;
  const audiences = Array.isArray(aud) ? aud : [aud];
  if (!audiences.includes(checks.audience)) throw bad("The token was issued for a different client");
  if (Array.isArray(aud) && aud.length > 1 && payload.azp !== undefined && payload.azp !== checks.audience) {
    throw bad("The token azp does not match this client");
  }
  if (typeof payload.sub !== "string" || !payload.sub) throw bad("The token has no subject");
  if (typeof payload.exp !== "number") throw bad("The token has no expiry");
  if (payload.exp + leeway < nowSec) throw bad("The token has expired");
  if (typeof payload.iat === "number" && payload.iat - leeway > nowSec) throw bad("The token was issued in the future");
  if (checks.nonce !== undefined) {
    if (payload.nonce === undefined) throw bad("The token has no nonce but one was expected");
    if (payload.nonce !== checks.nonce) throw bad("The token nonce does not match");
  }
  if (checks.maxAgeSeconds !== undefined) {
    if (typeof payload.auth_time !== "number") throw bad("The token has no auth_time");
    if (payload.auth_time + checks.maxAgeSeconds + leeway < nowSec) throw bad("The sign-in is too old");
  }
  return payload as IdTokenClaims;
}

/** OIDC at_hash: base64url of the left half of SHA-256(access_token). */
export async function computeAtHash(crypto: CryptoLike, accessToken: string): Promise<string> {
  const digest = await sha256(crypto, accessToken);
  return base64UrlEncode(digest.subarray(0, 16));
}
