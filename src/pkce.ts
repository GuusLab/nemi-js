import { base64UrlEncode, type CryptoLike, randomString, resolveCrypto, sha256 } from "./runtime";

export interface PkcePair {
  /** 43 characters of base64url, kept secret until the code exchange. */
  codeVerifier: string;
  /** base64url(SHA-256(codeVerifier)), sent with the authorization request. */
  codeChallenge: string;
  codeChallengeMethod: "S256";
}

/** RFC 7636 S256 challenge for a verifier. */
export async function createCodeChallenge(codeVerifier: string, crypto?: CryptoLike): Promise<string> {
  return base64UrlEncode(await sha256(resolveCrypto(crypto), codeVerifier));
}

/** Generate a PKCE verifier (32 random bytes) and its S256 challenge. */
export async function createPkcePair(crypto?: CryptoLike): Promise<PkcePair> {
  const c = resolveCrypto(crypto);
  const codeVerifier = randomString(c, 32);
  const codeChallenge = await createCodeChallenge(codeVerifier, c);
  return { codeVerifier, codeChallenge, codeChallengeMethod: "S256" };
}
