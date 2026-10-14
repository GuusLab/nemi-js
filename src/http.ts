import { toCamel } from "./case";
import { NemiApiError, NemiNetworkError, NemiRateLimitError } from "./errors";

/** Parse `Retry-After` as delta seconds or an HTTP date. Returns seconds, or undefined. */
export function parseRetryAfter(value: string | null, now: number = Date.now()): number | undefined {
  if (value === null || value.trim() === "") return undefined;
  const trimmed = value.trim();
  if (/^\d+(\.\d+)?$/.test(trimmed)) return Number(trimmed);
  const date = Date.parse(trimmed);
  if (Number.isNaN(date)) return undefined;
  return Math.max(0, Math.ceil((date - now) / 1000));
}

/** Turn a non-2xx REST API response into the matching typed error. */
export async function apiErrorFromResponse(res: Response): Promise<NemiApiError> {
  let text = "";
  try {
    text = await res.text();
  } catch {
    // ignore unreadable bodies
  }
  let code: string | undefined;
  let message: string | undefined;
  let requiredScope: string | undefined;
  try {
    const parsed = JSON.parse(text) as { error?: { code?: unknown; message?: unknown; required_scope?: unknown } | string };
    const err = parsed.error;
    if (err && typeof err === "object") {
      if (typeof err.code === "string") code = err.code;
      if (typeof err.message === "string") message = err.message;
      if (typeof err.required_scope === "string") requiredScope = err.required_scope;
    } else if (typeof err === "string") {
      code = err;
    }
  } catch {
    // not JSON, for example an HTML page from a proxy
  }
  if (res.status === 429) {
    const retryAfter = parseRetryAfter(res.headers.get("Retry-After"));
    return new NemiRateLimitError(message ?? "Rate limited by the Nemi API", { retryAfter, headers: res.headers });
  }
  return new NemiApiError(message ?? `Nemi API request failed with HTTP ${res.status}`, {
    status: res.status,
    code: code ?? defaultCodeForStatus(res.status),
    requiredScope,
    headers: res.headers,
  });
}

function defaultCodeForStatus(status: number): string {
  switch (status) {
    case 400:
      return "invalid_request";
    case 401:
      return "invalid_token";
    case 403:
      return "forbidden";
    case 404:
      return "not_found";
    case 409:
      return "conflict";
    case 413:
      return "too_large";
    case 429:
      return "rate_limited";
    default:
      return status >= 500 ? "server_error" : "invalid_request";
  }
}

/** Parse a successful response body. Empty bodies and 204 become undefined. */
export async function parseSuccess<T>(res: Response): Promise<T> {
  if (res.status === 204 || res.status === 205) return undefined as T;
  const text = await res.text();
  if (!text) return undefined as T;
  try {
    return toCamel<T>(JSON.parse(text));
  } catch (err) {
    throw new NemiApiError("The Nemi API returned a body that is not JSON", {
      status: res.status,
      code: "server_error",
      headers: res.headers,
      cause: err,
    });
  }
}

export function networkError(err: unknown): NemiNetworkError {
  if (err instanceof NemiNetworkError) return err;
  const detail = err instanceof Error ? `: ${err.message}` : "";
  return new NemiNetworkError(`Could not reach the Nemi API${detail}`, { cause: err });
}
