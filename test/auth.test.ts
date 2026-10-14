import { describe, expect, it } from "vitest";
import { NemiAuth } from "../src/auth";
import { NemiNetworkError, NemiOAuthError } from "../src/errors";
import { createCodeChallenge } from "../src/pkce";
import { parseQuery } from "../src/runtime";
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

const tokenResponse = {
  access_token: "nemi_oat_access",
  token_type: "Bearer",
  expires_in: 3600,
  refresh_token: "nemi_ort_refresh",
  scope: "openid profile email files.read offline_access",
};

describe("NemiAuth.createAuthorizationUrl", () => {
  it("builds the authorize URL from discovery with PKCE S256, state and nonce", async () => {
    const { fetch, calls } = mockFetch();
    const auth = new NemiAuth({ clientId: CLIENT_ID, fetch });
    const req = await auth.createAuthorizationUrl({
      scopes: ["openid", "profile", "files.read", "offline_access"],
      redirectUri: REDIRECT_URI,
      prompt: "consent",
    });
    expect(req.url.startsWith("https://nemilab.com/oauth/authorize?")).toBe(true);
    const q = parseQuery(req.url);
    expect(q).toMatchObject({
      response_type: "code",
      client_id: CLIENT_ID,
      redirect_uri: REDIRECT_URI,
      scope: "openid profile files.read offline_access",
      state: req.state,
      nonce: req.nonce,
      code_challenge_method: "S256",
      prompt: "consent",
    });
    expect(q.code_challenge).toBe(await createCodeChallenge(req.codeVerifier));
    expect(req.state).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(req.nonce).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(calls.map((c) => c.url)).toEqual([`${ISSUER}/.well-known/openid-configuration`]);
  });

  it("fetches discovery once and only adds a nonce when openid is asked", async () => {
    const { fetch, calls } = mockFetch();
    const auth = new NemiAuth({ clientId: CLIENT_ID, fetch });
    const a = await auth.createAuthorizationUrl({ scopes: "files.read", redirectUri: REDIRECT_URI });
    await auth.createAuthorizationUrl({ scopes: ["files.read"], redirectUri: REDIRECT_URI, state: "fixed" });
    expect(a.nonce).toBeUndefined();
    expect(parseQuery(a.url).nonce).toBeUndefined();
    expect(parseQuery(a.url).prompt).toBeUndefined();
    expect(calls).toHaveLength(1);
  });

  it("refuses a discovery document for another issuer", async () => {
    const { fetch } = mockFetch((c) => (c.url.endsWith("openid-configuration") ? json({ ...DISCOVERY, issuer: "https://evil.test" }) : undefined));
    const auth = new NemiAuth({ clientId: CLIENT_ID, fetch });
    await expect(auth.createAuthorizationUrl({ scopes: ["openid"], redirectUri: REDIRECT_URI })).rejects.toMatchObject({
      error: "invalid_issuer",
    });
  });

  it("retries discovery after a failure", async () => {
    let fail = true;
    const { fetch } = mockFetch((c) => {
      if (c.url.endsWith("openid-configuration") && fail) {
        fail = false;
        throw new TypeError("offline");
      }
      return undefined;
    });
    const auth = new NemiAuth({ clientId: CLIENT_ID, fetch });
    await expect(auth.discover()).rejects.toBeInstanceOf(NemiNetworkError);
    await expect(auth.discover()).resolves.toMatchObject({ token_endpoint: DISCOVERY.token_endpoint });
  });
});

describe("token endpoint", () => {
  it("exchanges a code as a public client", async () => {
    const { fetch, calls } = mockFetch((c) => (c.url === DISCOVERY.token_endpoint ? json(tokenResponse) : undefined));
    const auth = new NemiAuth({ clientId: CLIENT_ID, fetch });
    const before = Date.now();
    const tokens = await auth.exchangeCode({ code: "the-code", codeVerifier: "the-verifier", redirectUri: REDIRECT_URI });
    expect(tokens).toMatchObject({
      accessToken: "nemi_oat_access",
      tokenType: "Bearer",
      expiresIn: 3600,
      refreshToken: "nemi_ort_refresh",
      scope: tokenResponse.scope,
    });
    expect(tokens.expiresAt).toBeGreaterThanOrEqual(before + 3600_000);
    const call = calls.find((c) => c.url === DISCOVERY.token_endpoint)!;
    expect(call.method).toBe("POST");
    expect(call.headers["content-type"]).toBe("application/x-www-form-urlencoded");
    expect(formBody(call)).toEqual({
      grant_type: "authorization_code",
      code: "the-code",
      redirect_uri: REDIRECT_URI,
      code_verifier: "the-verifier",
      client_id: CLIENT_ID,
    });
  });

  it("sends the client secret for confidential apps and refreshes", async () => {
    const { fetch, calls } = mockFetch((c) =>
      c.url === DISCOVERY.token_endpoint ? json({ ...tokenResponse, access_token: "nemi_oat_new", refresh_token: "nemi_ort_new" }) : undefined,
    );
    const auth = new NemiAuth({ clientId: CLIENT_ID, clientSecret: CLIENT_SECRET, fetch });
    const tokens = await auth.refresh("nemi_ort_old");
    expect(tokens.accessToken).toBe("nemi_oat_new");
    expect(tokens.refreshToken).toBe("nemi_ort_new");
    expect(formBody(calls.at(-1)!)).toEqual({
      grant_type: "refresh_token",
      refresh_token: "nemi_ort_old",
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
    });
  });

  it("maps RFC 6749 errors to NemiOAuthError", async () => {
    const { fetch } = mockFetch((c) =>
      c.url === DISCOVERY.token_endpoint ? json({ error: "invalid_grant", error_description: "Code expired" }, 400) : undefined,
    );
    const auth = new NemiAuth({ clientId: CLIENT_ID, fetch });
    const err = await auth.refresh("nemi_ort_x").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(NemiOAuthError);
    expect(err).toMatchObject({ error: "invalid_grant", errorDescription: "Code expired", status: 400 });
  });

  it("maps a non JSON failure to server_error", async () => {
    const { fetch } = mockFetch((c) => (c.url === DISCOVERY.token_endpoint ? new Response("<html>bad gateway</html>", { status: 502 }) : undefined));
    const auth = new NemiAuth({ clientId: CLIENT_ID, fetch });
    await expect(auth.refresh("x")).rejects.toMatchObject({ error: "server_error", status: 502 });
  });

  it("revokes a token with client auth", async () => {
    const { fetch, calls } = mockFetch((c) => (c.url === DISCOVERY.revocation_endpoint ? new Response(null, { status: 200 }) : undefined));
    const auth = new NemiAuth({ clientId: CLIENT_ID, clientSecret: CLIENT_SECRET, fetch });
    await auth.revoke("nemi_ort_abc", { tokenTypeHint: "refresh_token" });
    expect(formBody(calls.at(-1)!)).toEqual({
      token: "nemi_ort_abc",
      token_type_hint: "refresh_token",
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
    });
  });

  it("calls UserInfo with the bearer token and returns camelCase", async () => {
    const { fetch, calls } = mockFetch((c) =>
      c.url === DISCOVERY.userinfo_endpoint
        ? json({ sub: "s1", name: "Ada", preferred_username: "ada", email: "a@x.test", email_verified: true })
        : undefined,
    );
    const auth = new NemiAuth({ clientId: CLIENT_ID, fetch });
    const info = await auth.userInfo("nemi_oat_tok");
    expect(info).toEqual({ sub: "s1", name: "Ada", preferredUsername: "ada", email: "a@x.test", emailVerified: true });
    expect(calls.at(-1)!.headers.authorization).toBe("Bearer nemi_oat_tok");
  });
});

describe("callbacks", () => {
  const auth = new NemiAuth({ clientId: CLIENT_ID, fetch: mockFetch().fetch });

  it("returns the code when state and iss match", () => {
    const url = `${REDIRECT_URI}?code=abc&state=s1&iss=${encodeURIComponent(ISSUER)}`;
    expect(auth.parseCallback(url, "s1")).toBe("abc");
  });

  it("rejects a state mismatch", () => {
    expect(() => auth.parseCallback(`${REDIRECT_URI}?code=abc&state=other`, "s1")).toThrowError(
      expect.objectContaining({ error: "invalid_state" }),
    );
  });

  it("rejects a foreign issuer (RFC 9207)", () => {
    expect(() => auth.parseCallback(`${REDIRECT_URI}?code=abc&state=s1&iss=https%3A%2F%2Fevil.test`, "s1")).toThrowError(
      expect.objectContaining({ error: "invalid_issuer" }),
    );
  });

  it("surfaces access_denied", () => {
    expect(() => auth.parseCallback(`${REDIRECT_URI}?error=access_denied&state=s1`, "s1")).toThrowError(
      expect.objectContaining({ error: "access_denied" }),
    );
  });

  it("handles a full callback: exchange plus id_token verification", async () => {
    const key = await generateSigningKey("k1");
    let idToken = "";
    const { fetch } = mockFetch((c) => {
      if (c.url === DISCOVERY.token_endpoint) return json({ ...tokenResponse, id_token: idToken });
      if (c.url === DISCOVERY.jwks_uri) return json({ keys: [key.publicJwk] });
      return undefined;
    });
    const a = new NemiAuth({ clientId: CLIENT_ID, fetch });
    idToken = await signJwt(key, idTokenClaims({ nonce: "n1" }));
    const result = await a.handleCallback(`${REDIRECT_URI}?code=c1&state=s1&iss=${encodeURIComponent(ISSUER)}`, {
      state: "s1",
      codeVerifier: "v1",
      nonce: "n1",
      redirectUri: REDIRECT_URI,
    });
    expect(result.tokens.accessToken).toBe("nemi_oat_access");
    expect(result.claims?.sub).toBe("pairwise-sub-123");
  });
});
