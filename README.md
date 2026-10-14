# @guuslab/nemi

The official JavaScript and TypeScript SDK for **Sign in with Nemi** and the **Nemi REST API**.

- OAuth 2.0 + OpenID Connect with PKCE (S256, always), id_token verification (ES256 via WebCrypto), refresh, revoke and UserInfo.
- A typed API client for files, gallery, docs, sheets, forms, canvas and calendar, with automatic token refresh and retries.
- Helpers for single page apps (`/browser`), servers and edge runtimes (`/server`) and React (`/react`).
- Zero runtime dependencies. Works in browsers, Node 18+, Deno, Bun, Cloudflare Workers and React Native. Only `fetch` and WebCrypto are used, and both can be injected.

Full documentation: **https://dev.nemilab.com/docs**

```bash
npm install @guuslab/nemi
```

You need an app from the developer portal at [dev.nemilab.com](https://dev.nemilab.com). It gives you a `client_id` (`nemi_app_...`) and, for confidential apps, a `client_secret` (`nemi_cs_...`). Register every redirect URI exactly as you use it.

## Quick start

### 1. Single page app (React)

```tsx
import { NemiAuth } from "@guuslab/nemi";
import { NemiProvider, SignInWithNemiButton, useNemi } from "@guuslab/nemi/react";

const auth = new NemiAuth({ clientId: "nemi_app_..." });

export function App() {
  return (
    <NemiProvider auth={auth} scopes={["openid", "profile", "email", "files.read", "offline_access"]}>
      <Home />
    </NemiProvider>
  );
}

function Home() {
  const { user, isLoading, client, signOut } = useNemi();
  if (isLoading) return null;
  if (!user) return <SignInWithNemiButton />;
  return (
    <>
      <p>Hi {user.name}</p>
      <button onClick={() => client!.workspaces.list().then(console.log)}>My workspaces</button>
      <button onClick={signOut}>Sign out</button>
    </>
  );
}
```

`NemiProvider` handles the redirect callback on the page you return to, verifies the id_token, keeps the session in `sessionStorage` (configurable with `persist`) and gives you a `client` that refreshes its own tokens. Pass `mode="popup"` plus a `redirectUri` to sign in inside a popup instead.

Without React, use the browser helpers directly:

```ts
import { NemiAuth } from "@guuslab/nemi";
import { handleRedirectCallback, isRedirectCallback, signInWithRedirect } from "@guuslab/nemi/browser";

const auth = new NemiAuth({ clientId: "nemi_app_..." });

if (isRedirectCallback()) {
  const { tokens, claims } = await handleRedirectCallback(auth); // checks state, exchanges, verifies, cleans the URL
} else {
  document.querySelector("#sign-in")!.addEventListener("click", () =>
    signInWithRedirect(auth, { scopes: ["openid", "profile"], redirectUri: "https://app.example/callback" }),
  );
}
```

Popup flow: call `signInWithPopup(auth, { scopes, redirectUri })` straight from a click handler, and make the page at `redirectUri` a minimal page that only calls `completePopupSignIn()` (do not mount `NemiProvider` there).

### 2. Next.js App Router (confidential app)

```ts
// lib/nemi.ts
import { createNemiAuth } from "@guuslab/nemi/server";

export const nemi = createNemiAuth({
  clientId: process.env.NEMI_CLIENT_ID!,
  clientSecret: process.env.NEMI_CLIENT_SECRET!,
  redirectUri: "https://app.example/api/auth/nemi/callback",
  scopes: ["openid", "profile", "email", "files.read", "offline_access"],
});
```

```ts
// app/api/auth/nemi/route.ts
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { serializePending } from "@guuslab/nemi/server";
import { nemi } from "@/lib/nemi";

export async function GET() {
  const { url, pending } = await nemi.startSignIn();
  (await cookies()).set("nemi_pending", serializePending(pending), {
    httpOnly: true,
    secure: true,
    sameSite: "lax",
    path: "/api/auth/nemi",
    maxAge: 600,
  });
  redirect(url);
}
```

```ts
// app/api/auth/nemi/callback/route.ts
import { cookies } from "next/headers";
import { NextResponse, type NextRequest } from "next/server";
import { NemiOAuthError } from "@guuslab/nemi";
import { nemi } from "@/lib/nemi";

export async function GET(req: NextRequest) {
  const jar = await cookies();
  const stored = jar.get("nemi_pending")?.value;
  jar.set("nemi_pending", "", { path: "/api/auth/nemi", maxAge: 0 });
  if (!stored) return NextResponse.redirect(new URL("/login?error=expired", req.url));
  try {
    const { tokens, claims } = await nemi.handleCallback(req.url, stored);
    // Store tokens server side (database or encrypted session), keyed by claims.sub.
    await saveSession(claims!.sub, tokens);
    return NextResponse.redirect(new URL("/", req.url));
  } catch (err) {
    const code = err instanceof NemiOAuthError ? err.error : "server_error";
    return NextResponse.redirect(new URL(`/login?error=${code}`, req.url));
  }
}
```

Later, in a route or server action:

```ts
const client = nemi.createClient(await loadTokens(userId), {
  onTokens: (tokens) => saveSession(userId, tokens), // refresh tokens rotate: always store the newest
});
const { files } = await client.files.search("invoice", { workspaceId });
```

`handleCallback(requestUrl, stored)` is framework agnostic: it takes any URL string plus the stored values, so the same code works in Express, Hono, Remix, SvelteKit, Deno or a Worker.

### 3. Node script

```ts
import { readFile } from "node:fs/promises";
import { NemiClient } from "@guuslab/nemi";

const nemi = new NemiClient(process.env.NEMI_ACCESS_TOKEN!);

const me = await nemi.me();
const { workspaces } = await nemi.workspaces.list();

for await (const photo of nemi.gallery.photos.iterate({ workspaceId: workspaces[0]!.id, favorites: true })) {
  console.log(photo.name, photo.capturedAt);
}

const file = await nemi.files.upload(await readFile("report.pdf"), {
  workspaceId: workspaces[0]!.id,
  name: "report.pdf",
  type: "application/pdf",
});
```

On Node 18, WebCrypto is not a global: pass `crypto: (await import("node:crypto")).webcrypto` to `NemiAuth`, or use `@guuslab/nemi/server`, which does it for you. Node 19 and later need nothing.

## Scopes

Ask for the fewest scopes you need. The app must also declare each scope in the portal, otherwise the request fails with `invalid_scope`.

| Scope | Grants |
| --- | --- |
| `openid` | An `id_token`. `sub` is pairwise: stable for one developer, different between developers. |
| `profile` | Name, username, avatar URL. |
| `email` | Email address and whether it is verified. |
| `offline_access` | A refresh token. Without it, only an access token (1 hour). |
| `files.read` | List workspaces, folders and files; read metadata; short-lived download links. |
| `files.write` | Upload, create folders, rename, move, delete. |
| `gallery.read` | List photos and albums; short-lived image links. |
| `gallery.write` | Upload photos, create albums, add photos to albums, favourite. |
| `docs.read` / `docs.write` | Docs as Markdown. |
| `sheets.read` / `sheets.write` | Sheets as cells. |
| `forms.read` / `forms.write` | Forms, their questions and their responses. |
| `canvas.read` / `canvas.write` | Canvas boards. |
| `calendar.read` / `calendar.write` | Calendars made in Nemi only, never synced Google or Outlook events. |

Every scope is bounded by the person's own role in each workspace. Vault files are never reachable.

## API reference

### `NemiAuth` (`@guuslab/nemi`)

```ts
new NemiAuth({ clientId, clientSecret?, issuer?, apiBaseUrl?, fetch?, crypto?, clockToleranceSeconds? })
```

| Method | Notes |
| --- | --- |
| `createAuthorizationUrl({ scopes, redirectUri, state?, nonce?, prompt? })` | Async. Returns `{ url, state, codeVerifier, nonce }`. Store everything but `url` until the callback. |
| `exchangeCode({ code, codeVerifier, redirectUri })` | Returns a `TokenSet` (`accessToken`, `refreshToken`, `idToken`, `expiresAt`, ...). |
| `refresh(refreshToken)` | Refresh tokens rotate: store the new one, never reuse the old one. |
| `revoke(token)` | Revoking a refresh token ends the session. |
| `userInfo(accessToken)` | Claims filtered by scope, in camelCase. |
| `verifyIdToken(idToken, { nonce?, accessToken?, maxAgeSeconds? })` | Verifies the ES256 signature against the JWKS, plus `iss`, `aud`, `exp`, `iat`, `nonce` and `at_hash`. The JWKS is cached and refetched when a token names an unknown `kid`. |
| `handleCallback(callbackUrl, pending)` | Checks state and `iss`, exchanges the code and verifies the id_token in one call. |

Endpoints are read lazily from `https://nemilab.com/oauth/.well-known/openid-configuration`.

### `NemiClient` (`@guuslab/nemi`)

```ts
new NemiClient("nemi_oat_...");
new NemiClient({ getAccessToken: async () => token });
new NemiClient({ tokens, auth, onTokens }); // refreshes before expiry and on 401
```

| Namespace | Methods |
| --- | --- |
| account | `me()`, `workspaces.list()` |
| `files` | `list({ workspaceId, folderId?, limit? })`, `search(q, { workspaceId?, limit? })`, `get(id)`, `download(id)`, `upload(data, { workspaceId, folderId?, name, type? })`, `update(id, { name?, folderId? })`, `delete(id)` |
| `folders` | `create({ workspaceId, name, parentId? })` |
| `gallery.photos` | `list({ workspaceId?, albumId?, favorites?, cursor?, limit? })`, `iterate(params)`, `get(id)`, `upload(data, { workspaceId, name?, type? })`, `update(id, { favorite })` |
| `gallery.albums` | `list({ workspaceId? })`, `create({ workspaceId, name })`, `addPhotos(albumId, photoIds)` |
| `docs` | `list`, `get`, `create({ workspaceId?, title, markdown? })`, `update(id, { title?, markdown? })`, `delete` |
| `sheets` | `list`, `get`, `create({ workspaceId?, title })`, `setCells(id, { A1: "Total", B1: 42 })`, `delete` |
| `forms` | `list`, `get`, `responses(id)`, `create({ workspaceId?, title, fields? })`, `delete` |
| `canvas` | `list`, `get` |
| `calendar.events` | `list({ start, end })`, `create({ title, start, end, allDay?, location?, description? })`, `update(id, changes)`, `delete(id)` |

Everything is camelCase in TypeScript and snake_case on the wire; the SDK converts both ways (cell references such as `A1` are left alone). `files.upload` accepts a `Blob`, `File`, `ArrayBuffer`, `Uint8Array` or `ReadableStream` and runs the three steps for you: create the upload, PUT the bytes, complete it. Max 50 MB. Download and image URLs expire after 15 minutes: fetch them again rather than storing them.

For anything not wrapped yet, use `client.request(method, path, { query, body })`.

### `@guuslab/nemi/browser`

`signInWithRedirect(auth, opts)`, `handleRedirectCallback(auth)`, `isRedirectCallback()`, `signInWithPopup(auth, opts)`, `completePopupSignIn()`, `cleanCallbackUrl()`. State, verifier and nonce live in `sessionStorage` only until the callback. `handleRedirectCallback` exchanges a code at most once, so React StrictMode cannot burn it.

### `@guuslab/nemi/server`

`createNemiAuth({ clientId, clientSecret, redirectUri, scopes? })` returns `{ auth, startSignIn(), handleCallback(requestUrl, stored), createClient(tokens, opts) }`, plus `serializePending` and `parsePending`. Nothing is stored for you; you choose a cookie or a session store.

### `@guuslab/nemi/react`

`NemiProvider`, `useNemi()` (`user`, `isLoading`, `isAuthenticated`, `error`, `tokens`, `signIn`, `signOut`, `client`), `SignInWithNemiButton` (`variant="dark" | "light"`, `size="sm" | "md" | "lg"`, `label`, `fullWidth`) and `NemiMark`. React 18 or later is an optional peer dependency.

## Error handling

Every error the SDK throws extends `NemiError`.

| Class | When | Useful fields |
| --- | --- | --- |
| `NemiApiError` | A REST call returned an error | `status`, `code` (`invalid_token`, `insufficient_scope`, `forbidden`, `not_found`, `conflict`, `too_large`, ...), `requiredScope` |
| `NemiRateLimitError` | 429 after the automatic retries | `retryAfter` (seconds) |
| `NemiOAuthError` | Token endpoint errors, denied consent, state or issuer mismatch, invalid id_token | `error`, `errorDescription` |
| `NemiNetworkError` | No response at all | `cause` |

```ts
import { NemiApiError, NemiOAuthError, NemiRateLimitError } from "@guuslab/nemi";

try {
  await client.files.list({ workspaceId });
} catch (err) {
  if (err instanceof NemiRateLimitError) retryLater(err.retryAfter);
  else if (err instanceof NemiApiError && err.code === "insufficient_scope") askForScope(err.requiredScope);
  else if (err instanceof NemiOAuthError && err.error === "invalid_grant") signInAgain();
  else throw err;
}
```

Retries: a 429 is retried up to 2 times, waiting for `Retry-After`. Network errors are retried up to 2 times for GET requests only. A 401 with a refreshable token set triggers one refresh (shared between concurrent calls) and one retry.

## Security notes

- PKCE S256 is used for every flow, public or confidential.
- Never ship a `client_secret` to a browser or a mobile app. Public apps use `NemiAuth` without one.
- Refresh tokens rotate. Presenting an old one revokes the whole session, so always persist the token set passed to `onTokens`.
- Authorization codes are single use and live 60 seconds.

## License

MIT, see [LICENSE](./LICENSE).
