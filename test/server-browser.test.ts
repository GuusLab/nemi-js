import { afterEach, describe, expect, it, vi } from "vitest";
import { NemiAuth } from "../src/auth";
import { PENDING_STORAGE_KEY, completePopupSignIn, handleRedirectCallback, isRedirectCallback, signInWithRedirect } from "../src/browser";
import { NemiOAuthError } from "../src/errors";
import { parseQuery } from "../src/runtime";
import { createNemiAuth, parsePending, serializePending } from "../src/server";
import {
  CLIENT_ID,
  CLIENT_SECRET,
  DISCOVERY,
  ISSUER,
  REDIRECT_URI,
  formBody,
  generateSigningKey,
  idTokenClaims,
  json,
  mockFetch,
  signJwt,
} from "./helpers";

async function oauthServer() {
  const key = await generateSigningKey("srv");
  let nonce: string | undefined;
  const mock = mockFetch(async (c) => {
    if (c.url === DISCOVERY.token_endpoint) {
      const id_token = await signJwt(key, idTokenClaims(nonce ? { nonce } : {}));
      return json({ access_token: "nemi_oat_x", token_type: "Bearer", expires_in: 3600, id_token });
    }
    if (c.url === DISCOVERY.jwks_uri) return json({ keys: [key.publicJwk] });
    return undefined;
  });
  return { ...mock, setNonce: (n?: string) => (nonce = n) };
}

describe("@guuslab/nemi/server", () => {
  it("starts sign-in and handles the callback from serialized values", async () => {
    const server = await oauthServer();
    const nemi = createNemiAuth({ clientId: CLIENT_ID, clientSecret: CLIENT_SECRET, redirectUri: REDIRECT_URI, fetch: server.fetch });
    const { url, pending } = await nemi.startSignIn({ scopes: ["openid", "profile", "files.read"] });
    expect(parseQuery(url)).toMatchObject({ redirect_uri: REDIRECT_URI, state: pending.state, code_challenge_method: "S256" });
    expect(pending.redirectUri).toBe(REDIRECT_URI);
    server.setNonce(pending.nonce);

    const stored = serializePending(pending);
    const result = await nemi.handleCallback(
      new URL(`${REDIRECT_URI}?code=c&state=${pending.state}&iss=${encodeURIComponent(ISSUER)}`),
      stored,
    );
    expect(result.claims?.sub).toBe("pairwise-sub-123");
    const tokenCall = server.calls.find((c) => c.url === DISCOVERY.token_endpoint)!;
    expect(formBody(tokenCall)).toMatchObject({ client_secret: CLIENT_SECRET, code_verifier: pending.codeVerifier });
  });

  it("rejects a forged state", async () => {
    const server = await oauthServer();
    const nemi = createNemiAuth({ clientId: CLIENT_ID, clientSecret: CLIENT_SECRET, redirectUri: REDIRECT_URI, fetch: server.fetch });
    const { pending } = await nemi.startSignIn();
    await expect(nemi.handleCallback(`${REDIRECT_URI}?code=c&state=forged`, pending)).rejects.toMatchObject({ error: "invalid_state" });
    expect(server.calls.some((c) => c.url === DISCOVERY.token_endpoint)).toBe(false);
  });

  it("validates stored values", () => {
    expect(() => parsePending("{}")).toThrow();
    expect(() => parsePending("nope")).toThrow();
    expect(() => createNemiAuth({ clientId: CLIENT_ID, clientSecret: "", redirectUri: REDIRECT_URI })).toThrow();
  });
});

class MemoryStorage {
  map = new Map<string, string>();
  getItem(k: string) {
    return this.map.get(k) ?? null;
  }
  setItem(k: string, v: string) {
    this.map.set(k, v);
  }
  removeItem(k: string) {
    this.map.delete(k);
  }
}

function fakeWindow(href: string) {
  const w = {
    location: {
      href,
      get origin() {
        return new URL(w.location.href).origin;
      },
      get pathname() {
        return new URL(w.location.href).pathname;
      },
      assign: vi.fn((u: string) => void (w.location.href = u)),
    },
    history: {
      state: null,
      replaceState: vi.fn((_s: unknown, _t: string, u: string) => void (w.location.href = new URL(u, w.location.href).href)),
    },
    sessionStorage: new MemoryStorage(),
    opener: null as unknown,
    close: vi.fn(),
  };
  vi.stubGlobal("window", w);
  return w;
}

describe("@guuslab/nemi/browser", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("redirects, then handles the callback once even when called twice", async () => {
    const server = await oauthServer();
    const auth = new NemiAuth({ clientId: CLIENT_ID, fetch: server.fetch });
    const w = fakeWindow("https://app.example/login?x=1");

    await signInWithRedirect(auth, { scopes: ["openid", "profile"], returnTo: "/dashboard" });
    const sentTo = w.location.assign.mock.calls[0]![0];
    const q = parseQuery(sentTo);
    expect(q.redirect_uri).toBe("https://app.example/login");
    const pending = JSON.parse(w.sessionStorage.getItem(PENDING_STORAGE_KEY)!);
    expect(pending).toMatchObject({ state: q.state, nonce: q.nonce, redirectUri: "https://app.example/login" });
    server.setNonce(q.nonce);

    w.location.href = `https://app.example/login?code=abc&state=${q.state}&iss=${encodeURIComponent(ISSUER)}#top`;
    expect(isRedirectCallback()).toBe(true);
    const [a, b] = await Promise.all([handleRedirectCallback(auth), handleRedirectCallback(auth)]);
    expect(a).toBe(b);
    expect(a.returnTo).toBe("/dashboard");
    expect(a.claims?.email).toBe("ada@example.com");
    expect(server.calls.filter((c) => c.url === DISCOVERY.token_endpoint)).toHaveLength(1);
    expect(w.sessionStorage.getItem(PENDING_STORAGE_KEY)).toBeNull();
    expect(w.location.href).toBe("https://app.example/login#top");
  });

  it("fails without a stored sign-in", async () => {
    const auth = new NemiAuth({ clientId: CLIENT_ID, fetch: mockFetch().fetch });
    fakeWindow("https://app.example/cb?code=zzz&state=s");
    await expect(handleRedirectCallback(auth)).rejects.toBeInstanceOf(NemiOAuthError);
  });

  it("completePopupSignIn posts the URL to the opener on the same origin", () => {
    const w = fakeWindow("https://app.example/popup-callback?code=c&state=s");
    expect(completePopupSignIn()).toBe(false);
    const postMessage = vi.fn();
    w.opener = { postMessage };
    expect(completePopupSignIn()).toBe(true);
    expect(postMessage).toHaveBeenCalledWith(
      { type: "nemi:oauth-callback", url: "https://app.example/popup-callback?code=c&state=s" },
      "https://app.example",
    );
    expect(w.close).toHaveBeenCalled();
  });
});
