import { NemiAuth, type AuthorizationUrlOptions, type NemiAuthOptions, type PendingSignIn, type SignInResult } from "./auth";
import { NemiClient, type NemiClientOptions } from "./client";
import { NemiError } from "./errors";
import type { CryptoLike } from "./runtime";
import type { NemiScope, TokenSet } from "./types";

export interface CreateNemiAuthOptions extends Omit<NemiAuthOptions, "clientSecret"> {
  clientSecret: string;
  /** The registered callback URL on your server. */
  redirectUri: string;
  /** Default scopes for `startSignIn`. Default `openid profile email`. */
  scopes?: NemiScope[] | string[];
}

export interface StartSignInOptions {
  scopes?: AuthorizationUrlOptions["scopes"];
  prompt?: AuthorizationUrlOptions["prompt"];
  extraParams?: Record<string, string>;
}

export interface StartSignInResult {
  /** Redirect the person here (302). */
  url: string;
  /**
   * Keep this until the callback, for example in an httpOnly, secure,
   * SameSite=Lax cookie with a 10 minute lifetime or in your session store.
   * It contains the PKCE verifier, so never expose it to page scripts.
   */
  pending: PendingSignIn;
}

export interface NemiServerAuth {
  /** The underlying OAuth client, for refresh, revoke, userInfo and verifyIdToken. */
  auth: NemiAuth;
  redirectUri: string;
  /** Build the authorization URL and the values the app must store until the callback. */
  startSignIn(options?: StartSignInOptions): Promise<StartSignInResult>;
  /**
   * Framework agnostic callback handler: pass the full request URL and the
   * stored values. Validates state and issuer, exchanges the code and
   * verifies the id_token.
   */
  handleCallback(requestUrl: string | URL, stored: PendingSignIn | string): Promise<SignInResult>;
  /** A NemiClient that refreshes on its own and reports new tokens to `onTokens`. */
  createClient(tokens: TokenSet, options?: Omit<NemiClientOptions, "tokens" | "auth">): NemiClient;
}

async function nodeCrypto(): Promise<CryptoLike | undefined> {
  const g = (globalThis as { crypto?: CryptoLike }).crypto;
  if (g && g.subtle && typeof g.getRandomValues === "function") return undefined;
  try {
    // Node 18 does not expose WebCrypto as a global without a flag.
    const mod = (await import("node:crypto")) as unknown as { webcrypto?: CryptoLike };
    return mod.webcrypto;
  } catch {
    return undefined;
  }
}

/** Serialize the pending sign-in for a cookie or session store. */
export function serializePending(pending: PendingSignIn): string {
  return JSON.stringify(pending);
}

/** Parse what `serializePending` produced. Throws on anything else. */
export function parsePending(value: string): PendingSignIn {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch (err) {
    throw new NemiError("The stored sign-in value is not valid JSON", { cause: err });
  }
  const p = parsed as Partial<PendingSignIn>;
  if (!p || typeof p.state !== "string" || typeof p.codeVerifier !== "string" || typeof p.redirectUri !== "string") {
    throw new NemiError("The stored sign-in value is incomplete");
  }
  const out: PendingSignIn = { state: p.state, codeVerifier: p.codeVerifier, redirectUri: p.redirectUri };
  if (typeof p.nonce === "string") out.nonce = p.nonce;
  return out;
}

/**
 * Helpers for confidential apps (a server that can keep a client secret):
 * Node 18+, Deno, Bun, Cloudflare Workers and other edge runtimes. Nothing is
 * stored for you: `startSignIn` returns the values to keep, `handleCallback`
 * takes them back.
 */
export function createNemiAuth(options: CreateNemiAuthOptions): NemiServerAuth {
  if (!options.clientSecret) throw new NemiError("createNemiAuth needs a clientSecret");
  if (!options.redirectUri) throw new NemiError("createNemiAuth needs a redirectUri");
  const { redirectUri, scopes: defaultScopes, ...authOptions } = options;
  let auth: NemiAuth | undefined;
  let authReady: Promise<NemiAuth> | undefined;

  const getAuth = (): Promise<NemiAuth> => {
    if (!authReady) {
      authReady = (async () => {
        const crypto = authOptions.crypto ?? (await nodeCrypto());
        auth = new NemiAuth(crypto ? { ...authOptions, crypto } : authOptions);
        return auth;
      })();
    }
    return authReady;
  };

  // Synchronous instance for callers that only need refresh, revoke and friends.
  // On Node 18 without a global crypto, those calls resolve crypto lazily via getAuth.
  const syncAuth = new NemiAuth(authOptions);

  return {
    get auth() {
      return auth ?? syncAuth;
    },
    redirectUri,
    async startSignIn(start: StartSignInOptions = {}) {
      const a = await getAuth();
      const request = await a.createAuthorizationUrl({
        scopes: start.scopes ?? defaultScopes ?? ["openid", "profile", "email"],
        redirectUri,
        prompt: start.prompt,
        extraParams: start.extraParams,
      });
      const pending: PendingSignIn = { state: request.state, codeVerifier: request.codeVerifier, redirectUri };
      if (request.nonce !== undefined) pending.nonce = request.nonce;
      return { url: request.url, pending };
    },
    async handleCallback(requestUrl, stored) {
      const a = await getAuth();
      const pending = typeof stored === "string" ? parsePending(stored) : stored;
      return a.handleCallback(String(requestUrl), pending);
    },
    createClient(tokens, clientOptions = {}) {
      return new NemiClient({ ...clientOptions, tokens, auth: auth ?? syncAuth });
    },
  };
}

export { NemiAuth, NemiClient };
export type { PendingSignIn, SignInResult, TokenSet };
