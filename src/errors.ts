/**
 * Base class for every error this SDK throws on purpose. Catch this to handle
 * anything Nemi related in one place, then narrow with `instanceof`.
 */
export class NemiError extends Error {
  override name = "NemiError";

  constructor(message: string, options?: { cause?: unknown }) {
    super(message);
    if (options && "cause" in options) {
      (this as { cause?: unknown }).cause = options.cause;
    }
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/** API error codes from the REST API contract. Unknown codes are passed through. */
export type NemiApiErrorCode =
  | "invalid_request"
  | "invalid_token"
  | "insufficient_scope"
  | "forbidden"
  | "not_found"
  | "conflict"
  | "too_large"
  | "rate_limited"
  | "server_error"
  | (string & {});

/** A REST API call (`/api/v1/...`) failed with an error response. */
export class NemiApiError extends NemiError {
  override name = "NemiApiError";
  /** HTTP status code. */
  readonly status: number;
  /** Machine readable code, such as `insufficient_scope` or `not_found`. */
  readonly code: NemiApiErrorCode;
  /** The scope the call needs, set when `code` is `insufficient_scope`. */
  readonly requiredScope?: string;
  /** Raw response headers, useful for `X-RateLimit-Remaining`. */
  readonly headers?: Headers;

  constructor(
    message: string,
    init: { status: number; code: NemiApiErrorCode; requiredScope?: string; headers?: Headers; cause?: unknown },
  ) {
    super(message, { cause: init.cause });
    this.status = init.status;
    this.code = init.code;
    if (init.requiredScope !== undefined) this.requiredScope = init.requiredScope;
    if (init.headers !== undefined) this.headers = init.headers;
  }
}

/** The API answered 429 and the SDK ran out of retries. */
export class NemiRateLimitError extends NemiApiError {
  override name = "NemiRateLimitError";
  /** Seconds to wait before trying again, from the `Retry-After` header. */
  readonly retryAfter?: number;

  constructor(message: string, init: { retryAfter?: number; headers?: Headers }) {
    super(message, { status: 429, code: "rate_limited", headers: init.headers });
    if (init.retryAfter !== undefined) this.retryAfter = init.retryAfter;
  }
}

/** OAuth error codes from RFC 6749 plus the ones the SDK raises itself. */
export type NemiOAuthErrorCode =
  | "invalid_request"
  | "invalid_client"
  | "invalid_grant"
  | "unauthorized_client"
  | "unsupported_grant_type"
  | "invalid_scope"
  | "access_denied"
  | "server_error"
  | "temporarily_unavailable"
  | "invalid_state"
  | "invalid_issuer"
  | "invalid_id_token"
  | "popup_closed"
  | "popup_blocked"
  | (string & {});

/**
 * An OAuth step failed: the token endpoint refused a grant, the person denied
 * consent, the callback did not match the stored state, or an id_token did
 * not verify.
 */
export class NemiOAuthError extends NemiError {
  override name = "NemiOAuthError";
  /** OAuth error code, such as `invalid_grant` or `access_denied`. */
  readonly error: NemiOAuthErrorCode;
  /** Human readable detail from the server or the SDK. */
  readonly errorDescription?: string;
  /** HTTP status when the error came from an HTTP response. */
  readonly status?: number;

  constructor(error: NemiOAuthErrorCode, errorDescription?: string, init?: { status?: number; cause?: unknown }) {
    super(errorDescription ? `${error}: ${errorDescription}` : error, { cause: init?.cause });
    this.error = error;
    if (errorDescription !== undefined) this.errorDescription = errorDescription;
    if (init?.status !== undefined) this.status = init.status;
  }
}

/** A request never got an HTTP response (DNS, TLS, offline, aborted). */
export class NemiNetworkError extends NemiError {
  override name = "NemiNetworkError";
}
