import { describe, expect, it } from "vitest";
import { createCodeChallenge, createPkcePair } from "../src/pkce";
import { base64UrlDecode, base64UrlEncode, encodeQuery, parseQuery } from "../src/runtime";

describe("PKCE", () => {
  it("matches the RFC 7636 appendix B test vector", async () => {
    const challenge = await createCodeChallenge("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk");
    expect(challenge).toBe("E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM");
  });

  it("generates a 43 character base64url verifier with a matching S256 challenge", async () => {
    const pair = await createPkcePair();
    expect(pair.codeVerifier).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(pair.codeChallengeMethod).toBe("S256");
    expect(pair.codeChallenge).toBe(await createCodeChallenge(pair.codeVerifier));
  });

  it("generates a fresh verifier every time", async () => {
    const a = await createPkcePair();
    const b = await createPkcePair();
    expect(a.codeVerifier).not.toBe(b.codeVerifier);
  });

  it("accepts an injected crypto implementation", async () => {
    let used = false;
    const fake = {
      getRandomValues<T extends ArrayBufferView>(arr: T): T {
        used = true;
        return crypto.getRandomValues(arr);
      },
      subtle: crypto.subtle,
    };
    await createPkcePair(fake);
    expect(used).toBe(true);
  });
});

describe("base64url and query helpers", () => {
  it("round trips every length", () => {
    for (let n = 0; n < 40; n++) {
      const bytes = crypto.getRandomValues(new Uint8Array(n));
      const encoded = base64UrlEncode(bytes);
      expect(encoded).not.toMatch(/[+/=]/);
      expect(Array.from(base64UrlDecode(encoded))).toEqual(Array.from(bytes));
      expect(encoded).toBe(Buffer.from(bytes).toString("base64url"));
    }
  });

  it("encodes and parses queries", () => {
    const q = encodeQuery({ scope: "openid files.read", skip: undefined, n: 3, redirect_uri: "https://a.b/c?d=e" });
    expect(q).toBe("scope=openid%20files.read&n=3&redirect_uri=https%3A%2F%2Fa.b%2Fc%3Fd%3De");
    expect(parseQuery(`https://x.test/cb?${q}#frag`)).toEqual({
      scope: "openid files.read",
      n: "3",
      redirect_uri: "https://a.b/c?d=e",
    });
  });
});
