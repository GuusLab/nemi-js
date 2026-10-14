import { beforeAll, describe, expect, it } from "vitest";
import { NemiAuth } from "../src/auth";
import { NemiOAuthError } from "../src/errors";
import { computeAtHash } from "../src/jwt";
import {
  CLIENT_ID,
  DISCOVERY,
  type SigningKey,
  generateSigningKey,
  idTokenClaims,
  json,
  mockFetch,
  nowSeconds,
  signJwt,
} from "./helpers";

let k1: SigningKey;
let k2: SigningKey;

beforeAll(async () => {
  k1 = await generateSigningKey("key-1");
  k2 = await generateSigningKey("key-2");
});

function setup(initialKeys: () => SigningKey[]) {
  let keys = initialKeys();
  const mock = mockFetch((c) => (c.url === DISCOVERY.jwks_uri ? json({ keys: keys.map((k) => k.publicJwk) }) : undefined));
  const auth = new NemiAuth({ clientId: CLIENT_ID, fetch: mock.fetch });
  return {
    auth,
    jwksCalls: () => mock.calls.filter((c) => c.url === DISCOVERY.jwks_uri).length,
    rotate: (next: SigningKey[]) => {
      keys = next;
    },
  };
}

async function expectInvalid(p: Promise<unknown>, message: RegExp) {
  const err = await p.catch((e: unknown) => e);
  expect(err).toBeInstanceOf(NemiOAuthError);
  expect((err as NemiOAuthError).error).toBe("invalid_id_token");
  expect((err as NemiOAuthError).errorDescription).toMatch(message);
}

describe("verifyIdToken", () => {
  it("accepts a valid ES256 token and caches the JWKS", async () => {
    const { auth, jwksCalls } = setup(() => [k1]);
    const token = await signJwt(k1, idTokenClaims({ nonce: "n-1" }));
    const claims = await auth.verifyIdToken(token, { nonce: "n-1" });
    expect(claims).toMatchObject({ sub: "pairwise-sub-123", email: "ada@example.com", nonce: "n-1" });
    await auth.verifyIdToken(token, { nonce: "n-1" });
    expect(jwksCalls()).toBe(1);
  });

  it("accepts an aud array that contains the client id", async () => {
    const { auth } = setup(() => [k1]);
    const token = await signJwt(k1, idTokenClaims({ aud: [CLIENT_ID] }));
    await expect(auth.verifyIdToken(token)).resolves.toMatchObject({ sub: "pairwise-sub-123" });
  });

  it("rejects a wrong audience", async () => {
    const { auth } = setup(() => [k1]);
    const token = await signJwt(k1, idTokenClaims({ aud: "nemi_app_somebodyelse" }));
    await expectInvalid(auth.verifyIdToken(token), /different client/);
  });

  it("rejects a wrong issuer", async () => {
    const { auth } = setup(() => [k1]);
    const token = await signJwt(k1, idTokenClaims({ iss: "https://nemilab.com" }));
    await expectInvalid(auth.verifyIdToken(token), /issuer/);
  });

  it("rejects an expired token (beyond the 60s leeway)", async () => {
    const { auth } = setup(() => [k1]);
    const token = await signJwt(k1, idTokenClaims({ iat: nowSeconds() - 1000, exp: nowSeconds() - 120 }));
    await expectInvalid(auth.verifyIdToken(token), /expired/);
  });

  it("allows small clock skew", async () => {
    const { auth } = setup(() => [k1]);
    const token = await signJwt(k1, idTokenClaims({ exp: nowSeconds() - 10 }));
    await expect(auth.verifyIdToken(token)).resolves.toBeTruthy();
  });

  it("rejects a wrong nonce", async () => {
    const { auth } = setup(() => [k1]);
    const token = await signJwt(k1, idTokenClaims({ nonce: "attacker" }));
    await expectInvalid(auth.verifyIdToken(token, { nonce: "expected" }), /nonce does not match/);
  });

  it("rejects a missing nonce when one was expected", async () => {
    const { auth } = setup(() => [k1]);
    const token = await signJwt(k1, idTokenClaims());
    await expectInvalid(auth.verifyIdToken(token, { nonce: "expected" }), /no nonce/);
  });

  it("refetches the JWKS on an unknown kid (key rotation)", async () => {
    const { auth, jwksCalls, rotate } = setup(() => [k1]);
    await auth.verifyIdToken(await signJwt(k1, idTokenClaims()));
    expect(jwksCalls()).toBe(1);
    rotate([k1, k2]);
    const claims = await auth.verifyIdToken(await signJwt(k2, idTokenClaims({ sub: "rotated" })));
    expect(claims.sub).toBe("rotated");
    expect(jwksCalls()).toBe(2);
  });

  it("fails when the kid is still unknown after a refetch", async () => {
    const { auth, jwksCalls } = setup(() => [k1]);
    const token = await signJwt(k2, idTokenClaims());
    await expectInvalid(auth.verifyIdToken(token), /No signing key/);
    expect(jwksCalls()).toBe(1);
  });

  it("rejects a signature from another key with the same kid", async () => {
    const { auth } = setup(() => [k1]);
    const forged = await signJwt(k2, idTokenClaims(), { kid: "key-1" });
    await expectInvalid(auth.verifyIdToken(forged), /signature/);
  });

  it("rejects a tampered payload", async () => {
    const { auth } = setup(() => [k1]);
    const token = await signJwt(k1, idTokenClaims());
    const [h, , s] = token.split(".");
    const other = (await signJwt(k1, idTokenClaims({ sub: "admin" }))).split(".")[1];
    await expectInvalid(auth.verifyIdToken(`${h}.${other}.${s}`), /signature/);
  });

  it("rejects alg none and other algorithms", async () => {
    const { auth } = setup(() => [k1]);
    const token = await signJwt(k1, idTokenClaims(), { alg: "HS256" });
    await expectInvalid(auth.verifyIdToken(token), /Unsupported alg/);
  });

  it("checks at_hash when the access token is given", async () => {
    const { auth } = setup(() => [k1]);
    const atHash = await computeAtHash(crypto, "nemi_oat_real");
    const token = await signJwt(k1, idTokenClaims({ at_hash: atHash }));
    await expect(auth.verifyIdToken(token, { accessToken: "nemi_oat_real" })).resolves.toBeTruthy();
    await expectInvalid(auth.verifyIdToken(token, { accessToken: "nemi_oat_swapped" }), /at_hash/);
  });
});
