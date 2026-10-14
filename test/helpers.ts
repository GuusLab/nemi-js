import { base64UrlEncode, utf8Encode } from "../src/runtime";

export const ISSUER = "https://nemilab.com/oauth";
export const CLIENT_ID = "nemi_app_abcdefghijklmnopqrstuvwx";
export const CLIENT_SECRET = "nemi_cs_secretsecretsecretsecretsecretsecret123";
export const REDIRECT_URI = "https://example.com/callback";

export const DISCOVERY = {
  issuer: ISSUER,
  authorization_endpoint: "https://nemilab.com/oauth/authorize",
  token_endpoint: "https://nemilab.com/api/oauth/token",
  revocation_endpoint: "https://nemilab.com/api/oauth/revoke",
  userinfo_endpoint: "https://nemilab.com/api/oauth/userinfo",
  jwks_uri: "https://nemilab.com/oauth/jwks",
  scopes_supported: ["openid", "profile", "email", "offline_access", "files.read"],
};

export interface Call {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}

type Handler = (call: Call) => Response | undefined | Promise<Response | undefined>;

export function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", ...headers } });
}

function headersToObject(h: HeadersInit | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  new Headers(h).forEach((v, k) => {
    out[k] = v;
  });
  return out;
}

/**
 * A fetch double. Handlers run in order; the first that returns a Response
 * wins. Discovery is served automatically unless a handler takes it.
 */
export function mockFetch(...handlers: Handler[]) {
  const calls: Call[] = [];
  const fetch = async (input: string, init: RequestInit = {}): Promise<Response> => {
    const call: Call = {
      url: input,
      method: (init.method ?? "GET").toUpperCase(),
      headers: headersToObject(init.headers),
      body: init.body,
    };
    calls.push(call);
    for (const h of handlers) {
      const res = await h(call);
      if (res) return res;
    }
    if (call.url === `${ISSUER}/.well-known/openid-configuration`) return json(DISCOVERY);
    return new Response("not mocked: " + call.url, { status: 599 });
  };
  return { fetch, calls };
}

export function formBody(call: Call): Record<string, string> {
  return Object.fromEntries(new URLSearchParams(String(call.body)));
}

export interface SigningKey {
  kid: string;
  privateKey: CryptoKey;
  publicJwk: JsonWebKey & { kid: string };
}

export async function generateSigningKey(kid: string): Promise<SigningKey> {
  const pair = (await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"])) as CryptoKeyPair;
  const jwk = await crypto.subtle.exportKey("jwk", pair.publicKey);
  return {
    kid,
    privateKey: pair.privateKey,
    // Extra members on purpose: the SDK must ignore them.
    publicJwk: { ...jwk, kid, alg: "ES256", use: "sig", key_ops: ["verify"] } as JsonWebKey & { kid: string },
  };
}

export async function signJwt(
  key: SigningKey,
  payload: Record<string, unknown>,
  header: Record<string, unknown> = {},
): Promise<string> {
  const h = base64UrlEncode(utf8Encode(JSON.stringify({ alg: "ES256", typ: "JWT", kid: key.kid, ...header })));
  const p = base64UrlEncode(utf8Encode(JSON.stringify(payload)));
  // WebCrypto signs ECDSA as raw r||s, the JWS format. Node's crypto.sign would give DER.
  const sig = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key.privateKey, utf8Encode(`${h}.${p}`) as BufferSource);
  return `${h}.${p}.${base64UrlEncode(new Uint8Array(sig))}`;
}

export function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

export function idTokenClaims(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const now = nowSeconds();
  return {
    iss: ISSUER,
    aud: CLIENT_ID,
    sub: "pairwise-sub-123",
    iat: now,
    exp: now + 600,
    auth_time: now,
    name: "Ada Lovelace",
    preferred_username: "ada",
    email: "ada@example.com",
    email_verified: true,
    ...overrides,
  };
}

export const noSleep = async (): Promise<void> => {};
