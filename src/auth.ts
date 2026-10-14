import { NemiError, NemiNetworkError, NemiOAuthError } from "./errors";
import { checkClaims, computeAtHash, decodeJwt, importEs256Key, type Jwk, type Jwks, verifyEs256 } from "./jwt";
import { createPkcePair } from "./pkce";
import {
  appendQuery,
  type CryptoLike,
  encodeQuery,
  type FetchLike,
  parseQuery,
  randomString,
  resolveCrypto,
  resolveFetch,
  trimTrailingSlash,
} from "./runtime";
import { toCamel } from "./case";
import type { IdTokenClaims, NemiScope, NemiUserInfo, TokenSet } from "./types";

export const DEFAULT_ISSUER = "https://nemilab.com/oauth";
export const DEFAULT_API_BASE_URL = "https://nemilab.com/api/v1";

export interface NemiAuthOptions {
  /** `nemi_app_...` from the developer portal. */
  clientId: string;
  /** `nemi_cs_...`. Confidential (server side) apps only: never ship it to a browser or a mobile app. */
  clientSecret?: string;
  /** OAuth issuer. Defaults to `https://nemilab.com/oauth`. */
  issuer?: string;
  /** REST API base. Defaults to `https://nemilab.com/api/v1`. */
  apiBaseUrl?: string;
  /** Custom fetch, for tests, proxies or runtimes without a global one. */
  fetch?: FetchLike;
  /** Custom WebCrypto implementation (needed on Node 18 or React Native without a polyfill). */
  crypto?: CryptoLike;
  /** Seconds of clock skew allowed when checking `exp` and `iat`. Default 60. */
  clockToleranceSeconds?: number;
}

/** The OpenID Provider metadata fields the SDK reads. */
export interface NemiDiscoveryDocument {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  revocation_endpoint?: string;
  userinfo_endpoint?: string;
  jwks_uri: string;
  scopes_supported?: string[];
  [field: string]: unknown;
}

export interface AuthorizationUrlOptions {
  scopes: NemiScope[] | readonly NemiScope[] | string[] | string;
  redirectUri: string;
  /** Defaults to 32 random bytes. */
  state?: string;
  /** Defaults to 32 random bytes when `openid` is requested. */
  nonce?: string;
  /** `consent` always shows the consent screen. */
  prompt?: "consent" | "login" | "none" | (string & {});
  /** Extra query parameters, for future OIDC options. */
  extraParams?: Record<string, string>;
}

export interface AuthorizationRequest {
  /** Send the person here. */
  url: string;
  /** Store until the callback and compare. */
  state: string;
  /** Store until the callback, then send to `exchangeCode`. Keep it secret. */
  codeVerifier: string;
  /** Store until the callback, then pass to `verifyIdToken`. Set when `openid` is requested. */
  nonce?: string;
}

/** What an app must keep between redirecting to Nemi and handling the callback. */
export interface PendingSignIn {
  state: string;
  codeVerifier: string;
  nonce?: string;
  redirectUri: string;
}

export interface SignInResult {
  tokens: TokenSet;
  /** Verified id_token claims, when `openid` was granted. */
  claims?: IdTokenClaims;
}

export interface VerifyIdTokenOptions {
  /** The nonce sent with the authorization request. When given, the token must carry the same one. */
  nonce?: string;
  /** When given, the token's `at_hash` (if present) must match it. */
  accessToken?: string;
  /** Reject sign-ins older than this many seconds (needs `auth_time`). */
  maxAgeSeconds?: number;
}

function scopeString(scopes: AuthorizationUrlOptions["scopes"]): string {
  return typeof scopes === "string" ? scopes : Array.from(new Set(scopes)).join(" ");
}

function originOf(url: string): string {
  const m = /^([a-z][a-z0-9+.-]*:\/\/[^/?#]+)/i.exec(url);
  return m ? (m[1] as string) : url;
}

/**
 * OAuth 2.0 and OpenID Connect client for Sign in with Nemi. Every flow uses
 * PKCE S256. Endpoints are read lazily from the discovery document at
 * `{issuer}/.well-known/openid-configuration`.
 */
export class NemiAuth {
  readonly clientId: string;
  readonly issuer: string;
  readonly apiBaseUrl: string;
  /** @internal */
  readonly fetch: FetchLike;
  readonly #clientSecret?: string;
  readonly #cryptoOverride?: CryptoLike;
  readonly #clockTolerance: number;
  #discovery?: Promise<NemiDiscoveryDocument>;
  #jwks?: Jwks;
  #jwksFetch?: Promise<Jwks>;
  readonly #keyCache = new Map<string, Promise<CryptoKey>>();

  constructor(options: NemiAuthOptions) {
    if (!options || !options.clientId) throw new NemiError("NemiAuth needs a clientId");
    this.clientId = options.clientId;
    this.issuer = trimTrailingSlash(options.issuer ?? DEFAULT_ISSUER);
    this.apiBaseUrl = trimTrailingSlash(options.apiBaseUrl ?? DEFAULT_API_BASE_URL);
    this.fetch = resolveFetch(options.fetch);
    if (options.clientSecret) this.#clientSecret = options.clientSecret;
    if (options.crypto) this.#cryptoOverride = options.crypto;
    this.#clockTolerance = options.clockToleranceSeconds ?? 60;
  }

  /** True when a client secret was configured (a confidential app). */
  get isConfidential(): boolean {
    return this.#clientSecret !== undefined;
  }

  /** @internal */
  get crypto(): CryptoLike {
    return resolveCrypto(this.#cryptoOverride);
  }

  /** Fetch (once) and return the discovery document. */
  discover(): Promise<NemiDiscoveryDocument> {
    if (!this.#discovery) {
      this.#discovery = this.#loadDiscovery().catch((err) => {
        this.#discovery = undefined;
        throw err;
      });
    }
    return this.#discovery;
  }

  async #loadDiscovery(): Promise<NemiDiscoveryDocument> {
    const url = `${this.issuer}/.well-known/openid-configuration`;
    const doc = await this.#getJson<Partial<NemiDiscoveryDocument>>(url, "discovery document");
    if (doc.issuer !== undefined && trimTrailingSlash(doc.issuer) !== this.issuer) {
      throw new NemiOAuthError("invalid_issuer", `Discovery issuer ${doc.issuer} does not match ${this.issuer}`);
    }
    const origin = originOf(this.issuer);
    return {
      ...doc,
      issuer: this.issuer,
      authorization_endpoint: doc.authorization_endpoint ?? `${this.issuer}/authorize`,
      token_endpoint: doc.token_endpoint ?? `${origin}/api/oauth/token`,
      revocation_endpoint: doc.revocation_endpoint ?? `${origin}/api/oauth/revoke`,
      userinfo_endpoint: doc.userinfo_endpoint ?? `${origin}/api/oauth/userinfo`,
      jwks_uri: doc.jwks_uri ?? `${this.issuer}/jwks`,
    };
  }

  async #getJson<T>(url: string, what: string, headers?: Record<string, string>): Promise<T> {
    let res: Response;
    try {
      res = await this.fetch(url, { method: "GET", headers: { Accept: "application/json", ...headers } });
    } catch (err) {
      throw new NemiNetworkError(`Could not load the Nemi ${what}`, { cause: err });
    }
    if (!res.ok) throw await oauthErrorFromResponse(res, `Could not load the Nemi ${what}`);
    return (await res.json()) as T;
  }

  /**
   * Build the URL to send the person to. PKCE S256 is always used. Store the
   * returned `state`, `codeVerifier` and `nonce` until the callback.
   */
  async createAuthorizationUrl(options: AuthorizationUrlOptions): Promise<AuthorizationRequest> {
    const crypto = this.crypto;
    const scope = scopeString(options.scopes);
    const state = options.state ?? randomString(crypto);
    const wantsOpenId = scope.split(" ").includes("openid");
    const nonce = options.nonce ?? (wantsOpenId ? randomString(crypto) : undefined);
    const { codeVerifier, codeChallenge } = await createPkcePair(crypto);
    const discovery = await this.discover();
    const url = appendQuery(discovery.authorization_endpoint, {
      response_type: "code",
      client_id: this.clientId,
      redirect_uri: options.redirectUri,
      scope,
      state,
      nonce,
      code_challenge: codeChallenge,
      code_challenge_method: "S256",
      prompt: options.prompt,
      ...options.extraParams,
    });
    const result: AuthorizationRequest = { url, state, codeVerifier };
    if (nonce !== undefined) result.nonce = nonce;
    return result;
  }

  /** Exchange an authorization code for tokens. */
  async exchangeCode(params: { code: string; codeVerifier: string; redirectUri: string }): Promise<TokenSet> {
    return this.#tokenRequest({
      grant_type: "authorization_code",
      code: params.code,
      redirect_uri: params.redirectUri,
      code_verifier: params.codeVerifier,
    });
  }

  /**
   * Trade a refresh token for new tokens. Refresh tokens rotate: store the
   * returned `refreshToken` and never reuse the old one, because presenting
   * a rotated token revokes the whole session.
   */
  async refresh(refreshToken: string, options?: { scope?: string | string[] }): Promise<TokenSet> {
    const scope = options?.scope === undefined ? undefined : scopeString(options.scope);
    return this.#tokenRequest({ grant_type: "refresh_token", refresh_token: refreshToken, scope });
  }

  /** Revoke an access or refresh token (RFC 7009). Revoking a refresh token ends the session. */
  async revoke(token: string, options?: { tokenTypeHint?: "access_token" | "refresh_token" }): Promise<void> {
    const discovery = await this.discover();
    const endpoint = discovery.revocation_endpoint as string;
    const res = await this.#postForm(endpoint, {
      token,
      token_type_hint: options?.tokenTypeHint,
      ...this.#clientAuth(),
    });
    if (!res.ok) throw await oauthErrorFromResponse(res, "Revocation failed");
  }

  /** Call the UserInfo endpoint. Claims are filtered by the granted scopes. */
  async userInfo(accessToken: string): Promise<NemiUserInfo> {
    const discovery = await this.discover();
    const raw = await this.#getJson<Record<string, unknown>>(discovery.userinfo_endpoint as string, "user info", {
      Authorization: `Bearer ${accessToken}`,
    });
    return toCamel<NemiUserInfo>(raw);
  }

  /**
   * Verify an id_token: ES256 signature against the issuer's JWKS, then
   * `iss`, `aud`, `exp`, `iat`, the nonce and (optionally) `at_hash`. The JWKS
   * is cached and fetched again when a token names an unknown `kid`.
   */
  async verifyIdToken(idToken: string, options: VerifyIdTokenOptions = {}): Promise<IdTokenClaims> {
    const crypto = this.crypto;
    const decoded = decodeJwt(idToken);
    if (decoded.header.alg !== "ES256") {
      throw new NemiOAuthError("invalid_id_token", `Unsupported alg ${String(decoded.header.alg)}`);
    }
    const jwk = await this.#findKey(decoded.header.kid);
    const key = await this.#importKey(jwk);
    const valid = await verifyEs256(crypto, key, decoded);
    if (!valid) throw new NemiOAuthError("invalid_id_token", "The signature is not valid");
    const claims = checkClaims(decoded.payload, {
      issuer: this.issuer,
      audience: this.clientId,
      nonce: options.nonce,
      clockToleranceSeconds: this.#clockTolerance,
      now: Date.now(),
      maxAgeSeconds: options.maxAgeSeconds,
    });
    if (options.accessToken !== undefined && typeof claims.at_hash === "string") {
      const expected = await computeAtHash(crypto, options.accessToken);
      if (expected !== claims.at_hash) throw new NemiOAuthError("invalid_id_token", "at_hash does not match");
    }
    return claims;
  }

  /**
   * Validate a redirect callback URL against the stored values, exchange the
   * code and verify the id_token. Used by the browser and server helpers.
   */
  async handleCallback(callbackUrl: string, pending: PendingSignIn): Promise<SignInResult> {
    const code = this.parseCallback(callbackUrl, pending.state);
    const tokens = await this.exchangeCode({ code, codeVerifier: pending.codeVerifier, redirectUri: pending.redirectUri });
    const result: SignInResult = { tokens };
    if (tokens.idToken) {
      result.claims = await this.verifyIdToken(tokens.idToken, {
        nonce: pending.nonce,
        accessToken: tokens.accessToken,
      });
    }
    return result;
  }

  /**
   * Check a callback URL: surfaces `error=...` as a NemiOAuthError, compares
   * `state`, checks `iss` when present (RFC 9207) and returns the code.
   */
  parseCallback(callbackUrl: string, expectedState: string): string {
    const params = parseQuery(callbackUrl);
    if (params.error) {
      throw new NemiOAuthError(params.error, params.error_description);
    }
    if (!params.state || params.state !== expectedState) {
      throw new NemiOAuthError("invalid_state", "The state in the callback does not match the stored state");
    }
    if (params.iss !== undefined && trimTrailingSlash(params.iss) !== this.issuer) {
      throw new NemiOAuthError("invalid_issuer", `The callback came from issuer ${params.iss}`);
    }
    if (!params.code) throw new NemiOAuthError("invalid_request", "The callback has no code");
    return params.code;
  }

  async #findKey(kid: string | undefined): Promise<Jwk> {
    const pick = (jwks: Jwks): Jwk | undefined => {
      const usable = jwks.keys.filter((k) => k.kty === "EC" && (k.use === undefined || k.use === "sig"));
      if (kid !== undefined) return usable.find((k) => k.kid === kid);
      return usable.length === 1 ? usable[0] : undefined;
    };
    if (this.#jwks) {
      const hit = pick(this.#jwks);
      if (hit) return hit;
    }
    const fresh = await this.#loadJwks();
    const hit = pick(fresh);
    if (!hit) throw new NemiOAuthError("invalid_id_token", `No signing key found for kid ${kid ?? "(none)"}`);
    return hit;
  }

  #loadJwks(): Promise<Jwks> {
    if (!this.#jwksFetch) {
      this.#jwksFetch = (async () => {
        const discovery = await this.discover();
        const jwks = await this.#getJson<Jwks>(discovery.jwks_uri, "signing keys");
        if (!jwks || !Array.isArray(jwks.keys)) throw new NemiOAuthError("invalid_id_token", "The JWKS has no keys");
        this.#jwks = jwks;
        return jwks;
      })().finally(() => {
        this.#jwksFetch = undefined;
      });
    }
    return this.#jwksFetch;
  }

  #importKey(jwk: Jwk): Promise<CryptoKey> {
    const cacheKey = `${jwk.kid ?? ""}:${jwk.x ?? ""}:${jwk.y ?? ""}`;
    let key = this.#keyCache.get(cacheKey);
    if (!key) {
      key = importEs256Key(this.crypto, jwk);
      key.catch(() => this.#keyCache.delete(cacheKey));
      this.#keyCache.set(cacheKey, key);
    }
    return key;
  }

  #clientAuth(): Record<string, string> {
    const out: Record<string, string> = { client_id: this.clientId };
    if (this.#clientSecret) out.client_secret = this.#clientSecret;
    return out;
  }

  async #postForm(url: string, body: Record<string, string | undefined>): Promise<Response> {
    try {
      return await this.fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
        body: encodeQuery(body),
      });
    } catch (err) {
      throw new NemiNetworkError("Could not reach the Nemi token endpoint", { cause: err });
    }
  }

  async #tokenRequest(body: Record<string, string | undefined>): Promise<TokenSet> {
    const discovery = await this.discover();
    const res = await this.#postForm(discovery.token_endpoint, { ...body, ...this.#clientAuth() });
    if (!res.ok) throw await oauthErrorFromResponse(res, "Token request failed");
    const raw = (await res.json()) as Record<string, unknown>;
    if (typeof raw.access_token !== "string") {
      throw new NemiOAuthError("server_error", "The token response has no access_token");
    }
    return tokenSetFromResponse(raw);
  }
}

/** Convert a raw token endpoint response into a TokenSet with an absolute expiry. */
export function tokenSetFromResponse(raw: Record<string, unknown>, now: number = Date.now()): TokenSet {
  const tokens: TokenSet = {
    accessToken: raw.access_token as string,
    tokenType: (raw.token_type as string | undefined) ?? "Bearer",
  };
  if (typeof raw.expires_in === "number") {
    tokens.expiresIn = raw.expires_in;
    tokens.expiresAt = now + raw.expires_in * 1000;
  }
  if (typeof raw.refresh_token === "string") tokens.refreshToken = raw.refresh_token;
  if (typeof raw.scope === "string") tokens.scope = raw.scope;
  if (typeof raw.id_token === "string") tokens.idToken = raw.id_token;
  return tokens;
}

async function oauthErrorFromResponse(res: Response, fallback: string): Promise<NemiOAuthError> {
  let text = "";
  try {
    text = await res.text();
  } catch {
    // ignore unreadable bodies
  }
  try {
    const body = JSON.parse(text) as { error?: unknown; error_description?: unknown };
    if (typeof body.error === "string") {
      return new NemiOAuthError(
        body.error,
        typeof body.error_description === "string" ? body.error_description : undefined,
        { status: res.status },
      );
    }
  } catch {
    // not JSON
  }
  const code = res.status >= 500 ? "server_error" : "invalid_request";
  return new NemiOAuthError(code, `${fallback} (HTTP ${res.status})`, { status: res.status });
}
