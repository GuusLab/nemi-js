import { afterEach, describe, expect, it, vi } from "vitest";
import { NemiAuth } from "../src/auth";
import { createCodeChallenge } from "../src/pkce";
import { utf8Decode, utf8Encode } from "../src/runtime";
import { createNemiAuth } from "../src/server";
import { CLIENT_ID, CLIENT_SECRET, DISCOVERY, REDIRECT_URI, generateSigningKey, idTokenClaims, mockFetch, signJwt } from "./helpers";

afterEach(() => vi.unstubAllGlobals());

describe("runtimes without TextEncoder and TextDecoder (React Native)", () => {
  it("encodes and decodes UTF-8 with the fallback", () => {
    const sample = "Nemi: café, ß, 中文, 😀";
    const native = new TextEncoder().encode(sample);
    vi.stubGlobal("TextEncoder", undefined);
    vi.stubGlobal("TextDecoder", undefined);
    const bytes = utf8Encode(sample);
    expect(Array.from(bytes)).toEqual(Array.from(native));
    expect(utf8Decode(bytes)).toBe(sample);
  });

  it("still does PKCE and id_token verification", async () => {
    const key = await generateSigningKey("rn");
    const token = await signJwt(key, idTokenClaims({ name: "Zoë" }));
    vi.stubGlobal("TextEncoder", undefined);
    vi.stubGlobal("TextDecoder", undefined);
    expect(await createCodeChallenge("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk")).toBe("E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM");
    // Node's own Response needs TextDecoder, so a bare object stands in for it here.
    const fake = (body: unknown) => ({ ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) });
    const fetch = async (url: string) => fake(url === DISCOVERY.jwks_uri ? { keys: [key.publicJwk] } : DISCOVERY) as unknown as Response;
    const auth = new NemiAuth({ clientId: CLIENT_ID, fetch });
    await expect(auth.verifyIdToken(token)).resolves.toMatchObject({ name: "Zoë" });
  });
});

describe("Node 18 (no global crypto)", () => {
  it("core asks for an injected crypto", async () => {
    vi.stubGlobal("crypto", undefined);
    const auth = new NemiAuth({ clientId: CLIENT_ID, fetch: mockFetch().fetch });
    await expect(auth.createAuthorizationUrl({ scopes: ["openid"], redirectUri: REDIRECT_URI })).rejects.toThrow(/WebCrypto/);
  });

  it("the server helpers fall back to node:crypto", async () => {
    vi.stubGlobal("crypto", undefined);
    const nemi = createNemiAuth({ clientId: CLIENT_ID, clientSecret: CLIENT_SECRET, redirectUri: REDIRECT_URI, fetch: mockFetch().fetch });
    const { url, pending } = await nemi.startSignIn();
    expect(url).toContain("code_challenge_method=S256");
    expect(pending.codeVerifier).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });
});
