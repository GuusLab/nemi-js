import type { AuthorizationUrlOptions, NemiAuth, PendingSignIn, SignInResult } from "./auth";
import { NemiError, NemiOAuthError } from "./errors";
import { parseQuery } from "./runtime";

/** Minimal Storage interface, so tests and React Native can pass their own. */
export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export const PENDING_STORAGE_KEY = "nemi.oauth.pending";
const POPUP_MESSAGE_TYPE = "nemi:oauth-callback";

interface StoredPending extends PendingSignIn {
  /** Where to send the person after the callback. */
  returnTo?: string;
}

export interface SignInWithRedirectOptions extends Omit<AuthorizationUrlOptions, "redirectUri"> {
  /** Defaults to the current page without query or hash. */
  redirectUri?: string;
  /** Stored and returned from `handleRedirectCallback`, for example the page the person was on. */
  returnTo?: string;
  /** Defaults to `sessionStorage`. */
  storage?: StorageLike;
}

export interface HandleRedirectCallbackOptions {
  /** Defaults to `window.location.href`. */
  url?: string;
  storage?: StorageLike;
  /** Remove `code`, `state`, `iss` and error params from the address bar. Default true. */
  cleanUrl?: boolean;
}

export interface RedirectCallbackResult extends SignInResult {
  returnTo?: string;
}

function win(): Window {
  if (typeof window === "undefined") throw new NemiError("@guuslab/nemi/browser needs a browser window");
  return window;
}

function defaultStorage(storage?: StorageLike): StorageLike {
  return storage ?? win().sessionStorage;
}

function currentPageUrl(): string {
  const { origin, pathname } = win().location;
  return origin + pathname;
}

/** True when the URL looks like an OAuth callback (`code` or `error` plus `state`). */
export function isRedirectCallback(url: string = win().location.href): boolean {
  const q = parseQuery(url);
  return !!q.state && (!!q.code || !!q.error);
}

/**
 * Start sign-in by sending the whole page to Nemi. State, PKCE verifier and
 * nonce are kept in sessionStorage until `handleRedirectCallback`.
 */
export async function signInWithRedirect(auth: NemiAuth, options: SignInWithRedirectOptions): Promise<void> {
  const storage = defaultStorage(options.storage);
  const redirectUri = options.redirectUri ?? currentPageUrl();
  const request = await auth.createAuthorizationUrl({ ...options, redirectUri });
  const pending: StoredPending = {
    state: request.state,
    codeVerifier: request.codeVerifier,
    redirectUri,
  };
  if (request.nonce !== undefined) pending.nonce = request.nonce;
  if (options.returnTo !== undefined) pending.returnTo = options.returnTo;
  storage.setItem(PENDING_STORAGE_KEY, JSON.stringify(pending));
  win().location.assign(request.url);
}

const inFlight = new Map<string, Promise<RedirectCallbackResult>>();

/**
 * Finish a redirect sign-in: checks state and issuer, exchanges the code,
 * verifies the id_token and cleans the URL. Safe to call twice (for example
 * from a React StrictMode effect): the code is only exchanged once.
 */
export function handleRedirectCallback(
  auth: NemiAuth,
  options: HandleRedirectCallbackOptions = {},
): Promise<RedirectCallbackResult> {
  const url = options.url ?? win().location.href;
  const params = parseQuery(url);
  const key = params.code ?? params.error ?? "";
  const existing = inFlight.get(key);
  if (existing) return existing;

  const storage = defaultStorage(options.storage);
  const raw = storage.getItem(PENDING_STORAGE_KEY);
  // Remove synchronously, before any await: a code is single use and a
  // second exchange would revoke every token minted from it.
  storage.removeItem(PENDING_STORAGE_KEY);

  const run = (async (): Promise<RedirectCallbackResult> => {
    // Yield once so the promise is registered before anything else runs.
    await Promise.resolve();
    if (!raw) throw new NemiOAuthError("invalid_state", "No sign-in is in progress in this tab");
    let pending: StoredPending;
    try {
      pending = JSON.parse(raw) as StoredPending;
    } catch (err) {
      throw new NemiOAuthError("invalid_state", "The stored sign-in state is corrupt", { cause: err });
    }
    const result: RedirectCallbackResult = await auth.handleCallback(url, pending);
    if (pending.returnTo !== undefined) result.returnTo = pending.returnTo;
    return result;
  })();
  inFlight.set(key, run);
  // The URL is cleaned only after the exchange settles, so a second call in
  // the meantime still sees the code and gets the memoized promise.
  const clean = () => {
    if (options.cleanUrl !== false && typeof window !== "undefined") cleanCallbackUrl();
  };
  run.then(clean, clean);
  run.then(
    () => setTimeout(() => inFlight.delete(key), 60_000),
    () => setTimeout(() => inFlight.delete(key), 60_000),
  );
  return run;
}

/** Remove OAuth parameters from the address bar without a reload. */
export function cleanCallbackUrl(): void {
  const w = win();
  const url = new URL(w.location.href);
  for (const p of ["code", "state", "iss", "error", "error_description", "error_uri", "session_state"]) {
    url.searchParams.delete(p);
  }
  w.history.replaceState(w.history.state, "", url.pathname + url.search + url.hash);
}

export interface SignInWithPopupOptions extends Omit<AuthorizationUrlOptions, "redirectUri"> {
  /** A page on your origin that calls `completePopupSignIn()`. Must be a registered redirect URI. */
  redirectUri: string;
  /** Popup width in pixels. Default 480. */
  width?: number;
  /** Popup height in pixels. Default 720. */
  height?: number;
  /** Give up after this many milliseconds. Default 5 minutes. */
  timeoutMs?: number;
}

/**
 * Sign in inside a popup. Call it straight from a click handler: the window
 * is opened before any await so popup blockers allow it.
 */
export function signInWithPopup(auth: NemiAuth, options: SignInWithPopupOptions): Promise<SignInResult> {
  const w = win();
  const width = options.width ?? 480;
  const height = options.height ?? 720;
  const left = Math.max(0, (w.screenX ?? 0) + ((w.outerWidth ?? width) - width) / 2);
  const top = Math.max(0, (w.screenY ?? 0) + ((w.outerHeight ?? height) - height) / 2);
  const popup = w.open("", "nemi-sign-in", `popup=yes,width=${width},height=${height},left=${left},top=${top}`);
  if (!popup) {
    return Promise.reject(new NemiOAuthError("popup_blocked", "The browser blocked the sign-in popup"));
  }

  return new Promise<SignInResult>((resolve, reject) => {
    let pending: PendingSignIn | undefined;
    let done = false;
    const finish = (fn: () => void) => {
      if (done) return;
      done = true;
      w.removeEventListener("message", onMessage);
      clearInterval(closedTimer);
      clearTimeout(timeout);
      try {
        if (!popup.closed) popup.close();
      } catch {
        // cross origin access can throw while Nemi is shown
      }
      fn();
    };

    const onMessage = (event: MessageEvent) => {
      if (event.origin !== w.location.origin || event.source !== popup) return;
      const data = event.data as { type?: string; url?: string } | null;
      if (!data || data.type !== POPUP_MESSAGE_TYPE || typeof data.url !== "string") return;
      const callbackUrl = data.url;
      if (!pending) return;
      const p = pending;
      done = true;
      w.removeEventListener("message", onMessage);
      clearInterval(closedTimer);
      clearTimeout(timeout);
      auth.handleCallback(callbackUrl, p).then(resolve, reject);
    };

    const closedTimer = setInterval(() => {
      if (popup.closed) finish(() => reject(new NemiOAuthError("popup_closed", "The sign-in popup was closed")));
    }, 500);
    const timeout = setTimeout(
      () => finish(() => reject(new NemiOAuthError("popup_closed", "Sign-in timed out"))),
      options.timeoutMs ?? 5 * 60_000,
    );
    w.addEventListener("message", onMessage);

    auth
      .createAuthorizationUrl(options)
      .then((request) => {
        pending = { state: request.state, codeVerifier: request.codeVerifier, redirectUri: options.redirectUri };
        if (request.nonce !== undefined) pending.nonce = request.nonce;
        if (!done) popup.location.href = request.url;
      })
      .catch((err: unknown) => finish(() => reject(err)));
  });
}

/**
 * Call this on the popup's callback page. It hands the callback URL to the
 * window that opened the popup (same origin only) and closes the popup.
 * Returns false when the page was not opened as a popup.
 */
export function completePopupSignIn(): boolean {
  const w = win();
  const opener = w.opener as Window | null;
  if (!opener || opener === w) return false;
  opener.postMessage({ type: POPUP_MESSAGE_TYPE, url: w.location.href }, w.location.origin);
  w.close();
  return true;
}
