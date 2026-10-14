import {
  type ButtonHTMLAttributes,
  type CSSProperties,
  type ReactNode,
  type SVGProps,
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { NemiAuth } from "./auth";
import {
  type StorageLike,
  handleRedirectCallback,
  isRedirectCallback,
  signInWithPopup,
  signInWithRedirect,
} from "./browser";
import { NemiClient } from "./client";
import { NEMI_MARK_PATHS, NEMI_MARK_VIEWBOX } from "./mark";
import type { IdTokenClaims, NemiScope, NemiUser, TokenSet } from "./types";

const SESSION_KEY = "nemi.session";

export interface NemiSignInOptions {
  scopes?: NemiScope[] | string[];
  prompt?: "consent" | "login" | "none" | (string & {});
  /** Returned after a redirect sign-in. Defaults to the current URL. */
  returnTo?: string;
}

export interface NemiContextValue {
  /** The signed in person, or null. */
  user: NemiUser | null;
  /** True while a callback or a stored session is being processed. */
  isLoading: boolean;
  isAuthenticated: boolean;
  /** The last sign-in error, if any. */
  error: Error | null;
  /** Current tokens. Refreshed tokens show up here too. */
  tokens: TokenSet | null;
  /** Start sign-in (redirect or popup, as configured on the provider). */
  signIn(options?: NemiSignInOptions): Promise<void>;
  /** Revoke the session at Nemi (best effort) and forget it locally. */
  signOut(): Promise<void>;
  /** An API client for the signed in person, or null when signed out. */
  client: NemiClient | null;
  auth: NemiAuth;
}

export interface NemiProviderProps {
  auth: NemiAuth;
  /** Default `["openid", "profile", "email"]`. Add `offline_access` for refresh tokens. */
  scopes?: NemiScope[] | string[];
  /** Registered redirect URI. Redirect mode defaults to the current page; popup mode requires it. */
  redirectUri?: string;
  /** `redirect` (default) or `popup`. */
  mode?: "redirect" | "popup";
  /**
   * Where the session (tokens and user) lives between reloads. `session`
   * (default) uses sessionStorage, `local` uses localStorage, `memory` keeps
   * nothing across reloads.
   */
  persist?: "session" | "local" | "memory";
  /** Called after a successful redirect callback, for example to navigate to `returnTo`. */
  onSignIn?(result: { user: NemiUser; returnTo?: string }): void;
  onError?(error: Error): void;
  children?: ReactNode;
}

const NemiContext = createContext<NemiContextValue | null>(null);

function userFromClaims(claims: IdTokenClaims): NemiUser {
  const user: NemiUser = { id: claims.sub };
  if (claims.name !== undefined) user.name = claims.name;
  if (claims.preferred_username !== undefined) user.username = claims.preferred_username;
  if (claims.picture !== undefined) user.picture = claims.picture;
  if (claims.email !== undefined) user.email = claims.email;
  if (claims.email_verified !== undefined) user.emailVerified = claims.email_verified;
  return user;
}

function pickStorage(persist: NemiProviderProps["persist"]): StorageLike | null {
  if (typeof window === "undefined" || persist === "memory") return null;
  try {
    return persist === "local" ? window.localStorage : window.sessionStorage;
  } catch {
    return null;
  }
}

interface StoredSession {
  tokens: TokenSet;
  user: NemiUser;
}

/**
 * Holds the Nemi session for a single page app. Handles the redirect
 * callback on mount, restores a stored session and exposes `useNemi()`.
 */
export function NemiProvider(props: NemiProviderProps): ReactNode {
  const { auth, mode = "redirect", persist = "session" } = props;
  const [tokens, setTokens] = useState<TokenSet | null>(null);
  const [user, setUser] = useState<NemiUser | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);
  const propsRef = useRef(props);
  propsRef.current = props;

  const save = useCallback(
    (session: StoredSession | null) => {
      const storage = pickStorage(persist);
      if (!storage) return;
      try {
        if (session) storage.setItem(SESSION_KEY, JSON.stringify(session));
        else storage.removeItem(SESSION_KEY);
      } catch {
        // storage can be full or blocked; the in-memory session still works
      }
    },
    [persist],
  );

  const adopt = useCallback(
    async (next: TokenSet, claims?: IdTokenClaims): Promise<NemiUser> => {
      let nextUser: NemiUser;
      if (claims) nextUser = userFromClaims(claims);
      else nextUser = await new NemiClient({ tokens: next, auth }).me();
      setTokens(next);
      setUser(nextUser);
      save({ tokens: next, user: nextUser });
      return nextUser;
    },
    [auth, save],
  );

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        if (typeof window !== "undefined" && isRedirectCallback()) {
          const result = await handleRedirectCallback(auth);
          if (cancelled) return;
          const signedIn = await adopt(result.tokens, result.claims);
          if (!cancelled) propsRef.current.onSignIn?.({ user: signedIn, returnTo: result.returnTo });
          return;
        }
        const storage = pickStorage(persist);
        const raw = storage?.getItem(SESSION_KEY);
        if (raw) {
          const stored = JSON.parse(raw) as StoredSession;
          const expired = stored.tokens.expiresAt !== undefined && stored.tokens.expiresAt < Date.now();
          if (!expired || stored.tokens.refreshToken) {
            setTokens(stored.tokens);
            setUser(stored.user);
          } else {
            storage?.removeItem(SESSION_KEY);
          }
        }
      } catch (err) {
        if (cancelled) return;
        const e = err instanceof Error ? err : new Error(String(err));
        setError(e);
        propsRef.current.onError?.(e);
      } finally {
        if (!cancelled) setIsLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [auth, persist, adopt]);

  const signIn = useCallback(
    async (options: NemiSignInOptions = {}) => {
      const p = propsRef.current;
      const scopes = options.scopes ?? p.scopes ?? ["openid", "profile", "email"];
      setError(null);
      if (mode === "popup") {
        if (!p.redirectUri) throw new Error("NemiProvider needs a redirectUri for popup sign-in");
        try {
          const result = await signInWithPopup(auth, { scopes, redirectUri: p.redirectUri, prompt: options.prompt });
          await adopt(result.tokens, result.claims);
        } catch (err) {
          const e = err instanceof Error ? err : new Error(String(err));
          setError(e);
          p.onError?.(e);
          throw e;
        }
        return;
      }
      await signInWithRedirect(auth, {
        scopes,
        redirectUri: p.redirectUri,
        prompt: options.prompt,
        returnTo: options.returnTo ?? (typeof window !== "undefined" ? window.location.href : undefined),
      });
    },
    [auth, mode, adopt],
  );

  const signOut = useCallback(async () => {
    const current = tokens;
    setTokens(null);
    setUser(null);
    save(null);
    if (current) {
      try {
        if (current.refreshToken) await auth.revoke(current.refreshToken, { tokenTypeHint: "refresh_token" });
        else await auth.revoke(current.accessToken, { tokenTypeHint: "access_token" });
      } catch {
        // best effort: the local session is gone either way
      }
    }
  }, [auth, tokens, save]);

  const userRef = useRef(user);
  userRef.current = user;

  const client = useMemo(() => {
    if (!tokens) return null;
    return new NemiClient({
      tokens,
      auth,
      onTokens: (next) => {
        setTokens(next);
        if (userRef.current) save({ tokens: next, user: userRef.current });
      },
    });
    // The client keeps refreshed tokens itself; recreating it on every
    // refresh would only drop in-flight state.
  }, [auth, tokens?.refreshToken ?? tokens?.accessToken]);

  const value = useMemo<NemiContextValue>(
    () => ({ user, isLoading, isAuthenticated: !!user && !!tokens, error, tokens, signIn, signOut, client, auth }),
    [user, isLoading, tokens, error, signIn, signOut, client, auth],
  );

  return <NemiContext.Provider value={value}>{props.children}</NemiContext.Provider>;
}

/** Access the Nemi session. Must be used inside `<NemiProvider>`. */
export function useNemi(): NemiContextValue {
  const ctx = useContext(NemiContext);
  if (!ctx) throw new Error("useNemi() must be used inside <NemiProvider>");
  return ctx;
}

/** The Nemi mark as an inline SVG that follows `currentColor`. */
export function NemiMark(props: SVGProps<SVGSVGElement>): ReactNode {
  return (
    <svg viewBox={NEMI_MARK_VIEWBOX} fill="currentColor" aria-hidden="true" focusable="false" {...props}>
      {NEMI_MARK_PATHS.map((d, i) => (
        <path key={i} d={d} />
      ))}
    </svg>
  );
}

export type SignInWithNemiButtonSize = "sm" | "md" | "lg";
export type SignInWithNemiButtonVariant = "dark" | "light";

export interface SignInWithNemiButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, "children"> {
  /** `dark` (default): black pill, white text. `light`: white pill, black text, for dark backgrounds. */
  variant?: SignInWithNemiButtonVariant;
  size?: SignInWithNemiButtonSize;
  /** Default "Sign in with Nemi". "Continue with Nemi" and "Sign up with Nemi" also fit the guidelines. */
  label?: string;
  fullWidth?: boolean;
  /** Passed to `signIn` when the button is used inside a NemiProvider without an onClick. */
  signInOptions?: NemiSignInOptions;
}

const SIZES: Record<SignInWithNemiButtonSize, { height: number; padding: string; fontSize: number; mark: number; gap: number }> = {
  sm: { height: 32, padding: "0 14px", fontSize: 13, mark: 11, gap: 8 },
  md: { height: 40, padding: "0 18px", fontSize: 15, mark: 13, gap: 10 },
  lg: { height: 48, padding: "0 24px", fontSize: 17, mark: 16, gap: 12 },
};

/**
 * The official Sign in with Nemi button: a black (or white) pill with the
 * Nemi mark. Inside a NemiProvider it starts sign-in on click; anywhere else,
 * pass your own `onClick`.
 */
export function SignInWithNemiButton(props: SignInWithNemiButtonProps): ReactNode {
  const {
    variant = "dark",
    size = "md",
    label = "Sign in with Nemi",
    fullWidth = false,
    signInOptions,
    style,
    onClick,
    disabled,
    type,
    ...rest
  } = props;
  const ctx = useContext(NemiContext);
  const s = SIZES[size];
  const dark = variant === "dark";
  const isDisabled = disabled ?? ctx?.isLoading ?? false;

  const base: CSSProperties = {
    display: fullWidth ? "flex" : "inline-flex",
    width: fullWidth ? "100%" : undefined,
    alignItems: "center",
    justifyContent: "center",
    gap: s.gap,
    height: s.height,
    padding: s.padding,
    borderRadius: 9999,
    border: dark ? "1px solid #000000" : "1px solid #d4d4d8",
    background: dark ? "#000000" : "#ffffff",
    color: dark ? "#ffffff" : "#000000",
    fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif",
    fontSize: s.fontSize,
    fontWeight: 600,
    lineHeight: 1,
    letterSpacing: 0,
    whiteSpace: "nowrap",
    cursor: isDisabled ? "not-allowed" : "pointer",
    opacity: isDisabled ? 0.6 : 1,
    boxSizing: "border-box",
    textDecoration: "none",
    WebkitTapHighlightColor: "transparent",
  };

  return (
    <button
      type={type ?? "button"}
      data-nemi-button=""
      data-variant={variant}
      data-size={size}
      disabled={isDisabled}
      style={{ ...base, ...style }}
      onClick={(event) => {
        onClick?.(event);
        if (event.defaultPrevented || onClick || !ctx) return;
        ctx.signIn(signInOptions).catch(() => undefined);
      }}
      {...rest}
    >
      <NemiMark style={{ height: s.mark, width: "auto", flex: "none", display: "block" }} />
      <span>{label}</span>
    </button>
  );
}

export type { NemiUser, TokenSet };
