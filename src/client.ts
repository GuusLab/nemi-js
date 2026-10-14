import type { NemiAuth } from "./auth";
import { DEFAULT_API_BASE_URL } from "./auth";
import { toSnake } from "./case";
import { NemiApiError, NemiError, NemiRateLimitError } from "./errors";
import { apiErrorFromResponse, networkError, parseRetryAfter, parseSuccess } from "./http";
import { appendQuery, defaultSleep, type FetchLike, resolveFetch, trimTrailingSlash } from "./runtime";
import type {
  Album,
  CalendarEvent,
  CalendarEventInput,
  Canvas,
  CanvasSummary,
  CellValue,
  Doc,
  DocSummary,
  DownloadLink,
  Folder,
  Form,
  FormResponses,
  FormSummary,
  NemiFile,
  NemiUser,
  Photo,
  PhotoPage,
  Sheet,
  SheetSummary,
  TokenSet,
  UploadSession,
  Workspace,
} from "./types";

/** Anything that can hand out a valid access token, such as your own session store. */
export interface TokenProvider {
  getAccessToken(): Promise<string>;
}

export interface NemiClientOptions {
  /** A fixed access token (`nemi_oat_...`). */
  accessToken?: string;
  /** Your own source of access tokens. Takes precedence over `accessToken` and `tokens`. */
  tokenProvider?: TokenProvider;
  /** A full token set. With `auth` and a refresh token, the client refreshes on its own. */
  tokens?: TokenSet;
  /** Needed for automatic refresh. */
  auth?: NemiAuth;
  /** Called with every new token set after a refresh. Persist it: refresh tokens rotate. */
  onTokens?: (tokens: TokenSet) => void | Promise<void>;
  /** Defaults to `auth.apiBaseUrl`, then `https://nemilab.com/api/v1`. */
  apiBaseUrl?: string;
  fetch?: FetchLike;
  /** Retries on 429 and on network errors for GET requests. Default 2. */
  maxRetries?: number;
  /** Give up instead of waiting when Retry-After asks for longer than this. Default 60. */
  maxRetryAfterSeconds?: number;
  /** Refresh this many seconds before the access token expires. Default 60. */
  refreshLeewaySeconds?: number;
  /** @internal Injected in tests. */
  sleep?: (ms: number) => Promise<void>;
}

type Query = Record<string, string | number | boolean | null | undefined>;

export interface RequestOptions {
  query?: Query;
  /** JSON body, converted to snake_case. */
  body?: unknown;
  /** A FormData body, sent as is. */
  formData?: FormData;
  signal?: AbortSignal;
}

/** Bytes the upload helpers accept. */
export type UploadData = Blob | ArrayBuffer | ArrayBufferView | ReadableStream<Uint8Array>;

export interface FileUploadOptions {
  workspaceId: string;
  folderId?: string;
  name: string;
  /** MIME type. Defaults to the Blob's type when there is one. */
  type?: string;
  signal?: AbortSignal;
}

export interface PhotoListParams {
  workspaceId?: string;
  albumId?: string;
  favorites?: boolean;
  cursor?: string;
  /** Max 100. */
  limit?: number;
}

const IDEMPOTENT = new Set(["GET", "HEAD"]);
const MAX_UPLOAD_BYTES = 50 * 1024 * 1024;

function enc(id: string): string {
  return encodeURIComponent(id);
}

async function toBytesOrBlob(data: UploadData): Promise<{ body: Blob | Uint8Array; size: number; type?: string }> {
  if (typeof Blob !== "undefined" && data instanceof Blob) {
    return { body: data, size: data.size, type: data.type || undefined };
  }
  if (data instanceof ArrayBuffer) return { body: new Uint8Array(data), size: data.byteLength };
  if (ArrayBuffer.isView(data)) {
    const view = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    return { body: view, size: view.byteLength };
  }
  if (data && typeof (data as ReadableStream).getReader === "function") {
    // Streams are buffered: step 1 needs the size, and Node's fetch needs
    // `duplex: "half"` for stream bodies. Uploads are capped at 50 MB anyway.
    const reader = (data as ReadableStream<Uint8Array>).getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) {
        chunks.push(value);
        size += value.byteLength;
        if (size > MAX_UPLOAD_BYTES) {
          await reader.cancel();
          throw new NemiApiError("Files are limited to 50 MB", { status: 413, code: "too_large" });
        }
      }
    }
    const out = new Uint8Array(size);
    let offset = 0;
    for (const c of chunks) {
      out.set(c, offset);
      offset += c.byteLength;
    }
    return { body: out, size };
  }
  throw new NemiError("Unsupported upload data: pass a Blob, File, ArrayBuffer, Uint8Array or ReadableStream");
}

/**
 * Typed client for the Nemi REST API v1. camelCase in, camelCase out: keys
 * are converted to snake_case on the wire and back.
 *
 * ```ts
 * const nemi = new NemiClient({ tokens, auth, onTokens: save });
 * const { workspaces } = await nemi.workspaces.list();
 * ```
 */
export class NemiClient {
  readonly apiBaseUrl: string;
  readonly #fetch: FetchLike;
  readonly #provider?: TokenProvider;
  readonly #auth?: NemiAuth;
  readonly #onTokens?: (tokens: TokenSet) => void | Promise<void>;
  readonly #maxRetries: number;
  readonly #maxRetryAfter: number;
  readonly #leewayMs: number;
  readonly #sleep: (ms: number) => Promise<void>;
  #tokens?: TokenSet;
  #refreshing?: Promise<TokenSet>;

  constructor(auth: string | TokenProvider | NemiClientOptions) {
    const options: NemiClientOptions =
      typeof auth === "string"
        ? { accessToken: auth }
        : "getAccessToken" in auth && typeof auth.getAccessToken === "function"
          ? { tokenProvider: auth }
          : (auth as NemiClientOptions);
    if (options.tokenProvider) this.#provider = options.tokenProvider;
    if (options.tokens) this.#tokens = { ...options.tokens };
    else if (options.accessToken) this.#tokens = { accessToken: options.accessToken, tokenType: "Bearer" };
    if (!this.#provider && !this.#tokens) {
      throw new NemiError("NemiClient needs an accessToken, a tokenProvider or tokens");
    }
    if (options.auth) this.#auth = options.auth;
    if (options.onTokens) this.#onTokens = options.onTokens;
    this.apiBaseUrl = trimTrailingSlash(options.apiBaseUrl ?? options.auth?.apiBaseUrl ?? DEFAULT_API_BASE_URL);
    this.#fetch = resolveFetch(options.fetch ?? options.auth?.fetch);
    this.#maxRetries = options.maxRetries ?? 2;
    this.#maxRetryAfter = options.maxRetryAfterSeconds ?? 60;
    this.#leewayMs = (options.refreshLeewaySeconds ?? 60) * 1000;
    this.#sleep = options.sleep ?? defaultSleep;
  }

  /** The current token set, including any refreshed tokens. Undefined with a tokenProvider. */
  get tokens(): TokenSet | undefined {
    return this.#tokens ? { ...this.#tokens } : undefined;
  }

  #canRefresh(): boolean {
    return !this.#provider && !!this.#auth && !!this.#tokens?.refreshToken;
  }

  /** Refresh now, single flight: concurrent callers share one request, because refresh tokens rotate. */
  refreshTokens(): Promise<TokenSet> {
    if (!this.#canRefresh()) {
      return Promise.reject(new NemiError("This client cannot refresh: it needs `auth` and a refresh token"));
    }
    if (!this.#refreshing) {
      const current = this.#tokens as TokenSet;
      this.#refreshing = (async () => {
        const next = await (this.#auth as NemiAuth).refresh(current.refreshToken as string);
        const merged: TokenSet = { ...next };
        // Keep the refresh token if the server did not send a new one.
        if (!merged.refreshToken && current.refreshToken) merged.refreshToken = current.refreshToken;
        this.#tokens = merged;
        if (this.#onTokens) await this.#onTokens({ ...merged });
        return merged;
      })().finally(() => {
        this.#refreshing = undefined;
      });
    }
    return this.#refreshing;
  }

  async #accessToken(): Promise<string> {
    if (this.#provider) return this.#provider.getAccessToken();
    if (this.#refreshing) return (await this.#refreshing).accessToken;
    const t = this.#tokens as TokenSet;
    if (t.expiresAt !== undefined && Date.now() >= t.expiresAt - this.#leewayMs && this.#canRefresh()) {
      return (await this.refreshTokens()).accessToken;
    }
    return t.accessToken;
  }

  /**
   * Low level request against the API base. Paths start with `/`. Query and
   * JSON body keys are converted to snake_case, the response to camelCase.
   */
  async request<T = unknown>(method: string, path: string, options: RequestOptions = {}): Promise<T> {
    const upper = method.toUpperCase();
    const query = options.query ? toSnake<Query>(options.query) : undefined;
    const url = appendQuery(this.apiBaseUrl + path, query ?? {});
    let rateLimitRetries = 0;
    let networkRetries = 0;
    let refreshed = false;

    for (;;) {
      const token = await this.#accessToken();
      const headers: Record<string, string> = { Authorization: `Bearer ${token}`, Accept: "application/json" };
      let body: BodyInit | undefined;
      if (options.formData) {
        body = options.formData;
      } else if (options.body !== undefined) {
        headers["Content-Type"] = "application/json";
        body = JSON.stringify(toSnake(options.body));
      }

      let res: Response;
      try {
        res = await this.#fetch(url, { method: upper, headers, body, signal: options.signal });
      } catch (err) {
        if (options.signal?.aborted) throw err;
        if (IDEMPOTENT.has(upper) && networkRetries < this.#maxRetries) {
          networkRetries++;
          await this.#sleep(250 * 2 ** (networkRetries - 1));
          continue;
        }
        throw networkError(err);
      }

      if (res.status === 429) {
        const retryAfter = parseRetryAfter(res.headers.get("Retry-After"));
        const waitSeconds = retryAfter ?? 1;
        if (rateLimitRetries < this.#maxRetries && waitSeconds <= this.#maxRetryAfter) {
          rateLimitRetries++;
          await res.body?.cancel().catch(() => undefined);
          await this.#sleep(waitSeconds * 1000);
          continue;
        }
        const err = await apiErrorFromResponse(res);
        if (err instanceof NemiRateLimitError) throw err;
        throw new NemiRateLimitError(err.message, { retryAfter, headers: res.headers });
      }

      if (res.status === 401 && !refreshed && this.#canRefresh()) {
        refreshed = true;
        await res.body?.cancel().catch(() => undefined);
        // Another call may already have rotated the token; only refresh if not.
        if (this.#tokens?.accessToken === token) await this.refreshTokens();
        continue;
      }

      if (!res.ok) throw await apiErrorFromResponse(res);
      return parseSuccess<T>(res);
    }
  }

  /** The person who signed in. Works with any scope. */
  me(): Promise<NemiUser> {
    return this.request("GET", "/me");
  }

  readonly workspaces = {
    /** Workspaces the person belongs to, with their role. Needs any `*.read` scope. */
    list: (): Promise<{ workspaces: Workspace[] }> => this.request("GET", "/workspaces"),
  };

  readonly files = {
    /** Folders and files in a folder, or the top level when `folderId` is omitted. */
    list: (params: { workspaceId: string; folderId?: string; limit?: number }): Promise<{ folders: Folder[]; files: NemiFile[] }> =>
      this.request("GET", "/files", { query: params }),
    search: (q: string, params: { workspaceId?: string; limit?: number } = {}): Promise<{ files: NemiFile[] }> =>
      this.request("GET", "/files/search", { query: { q, ...params } }),
    get: (id: string): Promise<NemiFile> => this.request("GET", `/files/${enc(id)}`),
    /** A short lived download link (15 minutes, no token needed). */
    download: (id: string): Promise<DownloadLink> => this.request("GET", `/files/${enc(id)}/download`),
    /**
     * Upload a file in three steps: create an upload, PUT the bytes to the
     * returned URL, then complete it. Max 50 MB.
     */
    upload: async (data: UploadData, options: FileUploadOptions): Promise<NemiFile> => {
      const { body, size, type: blobType } = await toBytesOrBlob(data);
      if (size > MAX_UPLOAD_BYTES) throw new NemiApiError("Files are limited to 50 MB", { status: 413, code: "too_large" });
      const type = options.type ?? blobType;
      const session = await this.request<UploadSession>("POST", "/files/uploads", {
        body: { workspaceId: options.workspaceId, folderId: options.folderId, name: options.name, type, size },
        signal: options.signal,
      });
      let put: Response;
      try {
        put = await this.#fetch(session.uploadUrl, {
          method: session.method ?? "PUT",
          headers: type ? { "Content-Type": type } : {},
          body: body as BodyInit,
          signal: options.signal,
        });
      } catch (err) {
        throw networkError(err);
      }
      if (!put.ok) {
        await put.body?.cancel().catch(() => undefined);
        throw new NemiApiError(`Uploading the bytes failed with HTTP ${put.status}`, {
          status: put.status,
          code: put.status === 413 ? "too_large" : "upload_failed",
          headers: put.headers,
        });
      }
      await put.body?.cancel().catch(() => undefined);
      return this.request<NemiFile>("POST", `/files/uploads/${enc(session.uploadId)}/complete`, { signal: options.signal });
    },
    /** Rename or move. */
    update: (id: string, changes: { name?: string; folderId?: string | null }): Promise<NemiFile> =>
      this.request("PATCH", `/files/${enc(id)}`, { body: changes }),
    /** Moves to trash where the plan has one. */
    delete: (id: string): Promise<void> => this.request("DELETE", `/files/${enc(id)}`),
  };

  readonly folders = {
    create: (params: { workspaceId: string; name: string; parentId?: string }): Promise<Folder> =>
      this.request("POST", "/folders", { body: params }),
  };

  readonly gallery = {
    photos: {
      /** One page of photos, newest first. */
      list: (params: PhotoListParams = {}): Promise<PhotoPage> => this.request("GET", "/gallery/photos", { query: { ...params } }),
      /** Every photo, following `nextCursor` until the end. */
      iterate: (params: Omit<PhotoListParams, "cursor"> = {}): AsyncIterableIterator<Photo> => this.#iteratePhotos(params),
      /** A photo with its full size `url` (15 minutes). */
      get: (id: string): Promise<Photo> => this.request("GET", `/gallery/photos/${enc(id)}`),
      /** JPEG, PNG, HEIC, WebP or AVIF, up to 50 MB. Nemi re-encodes it. */
      upload: async (data: Blob | ArrayBuffer | ArrayBufferView, options: { workspaceId: string; name?: string; type?: string; signal?: AbortSignal }): Promise<Photo> => {
        const { body, size } = await toBytesOrBlob(data);
        if (size > MAX_UPLOAD_BYTES) {
          throw new NemiApiError("Photos are limited to 50 MB", { status: 413, code: "too_large" });
        }
        const blob =
          body instanceof Uint8Array ? new Blob([body as BlobPart], { type: options.type ?? "application/octet-stream" }) : body;
        // The API reads `workspace_id` and `file`. Content-Type (with the boundary) is set by fetch.
        const form = new FormData();
        form.append("workspace_id", options.workspaceId);
        form.append("file", blob, options.name ?? (data as { name?: string }).name ?? "photo");
        return this.request("POST", "/gallery/photos", { formData: form, signal: options.signal });
      },
      update: (id: string, changes: { favorite: boolean }): Promise<Photo> =>
        this.request("PATCH", `/gallery/photos/${enc(id)}`, { body: changes }),
    },
    albums: {
      list: (params: { workspaceId?: string } = {}): Promise<{ albums: Album[] }> => this.request("GET", "/gallery/albums", { query: params }),
      create: (params: { workspaceId: string; name: string }): Promise<Album> => this.request("POST", "/gallery/albums", { body: params }),
      addPhotos: (albumId: string, photoIds: string[]): Promise<unknown> =>
        this.request("POST", `/gallery/albums/${enc(albumId)}/photos`, { body: { photoIds } }),
    },
  };

  readonly docs = {
    list: (params: { workspaceId?: string } = {}): Promise<{ docs: DocSummary[] }> => this.request("GET", "/docs", { query: params }),
    get: (id: string): Promise<Doc> => this.request("GET", `/docs/${enc(id)}`),
    create: (params: { workspaceId?: string; title: string; markdown?: string }): Promise<Doc> => this.request("POST", "/docs", { body: params }),
    update: (id: string, changes: { title?: string; markdown?: string }): Promise<Doc> =>
      this.request("PATCH", `/docs/${enc(id)}`, { body: changes }),
    delete: (id: string): Promise<void> => this.request("DELETE", `/docs/${enc(id)}`),
  };

  readonly sheets = {
    list: (params: { workspaceId?: string } = {}): Promise<{ sheets: SheetSummary[] }> => this.request("GET", "/sheets", { query: params }),
    get: (id: string): Promise<Sheet> => this.request("GET", `/sheets/${enc(id)}`),
    create: (params: { workspaceId?: string; title: string }): Promise<Sheet> => this.request("POST", "/sheets", { body: params }),
    /** Set cells by A1 reference: `setCells(id, { A1: "Total", B1: 42 })`. */
    setCells: (id: string, cells: Record<string, CellValue>): Promise<Sheet> =>
      this.request("PATCH", `/sheets/${enc(id)}/cells`, { body: { cells } }),
    delete: (id: string): Promise<void> => this.request("DELETE", `/sheets/${enc(id)}`),
  };

  readonly forms = {
    list: (params: { workspaceId?: string } = {}): Promise<{ forms: FormSummary[] }> => this.request("GET", "/forms", { query: params }),
    get: (id: string): Promise<Form> => this.request("GET", `/forms/${enc(id)}`),
    responses: (id: string): Promise<FormResponses> => this.request("GET", `/forms/${enc(id)}/responses`),
    create: (params: { workspaceId?: string; title: string; fields?: unknown[] }): Promise<Form> => this.request("POST", "/forms", { body: params }),
    delete: (id: string): Promise<void> => this.request("DELETE", `/forms/${enc(id)}`),
  };

  readonly canvas = {
    list: (params: { workspaceId?: string } = {}): Promise<{ canvases: CanvasSummary[] }> => this.request("GET", "/canvas", { query: params }),
    get: (id: string): Promise<Canvas> => this.request("GET", `/canvas/${enc(id)}`),
  };

  readonly calendar = {
    events: {
      /** Events from calendars made in Nemi, between `start` and `end` (ISO 8601). */
      list: (params: { start: string; end: string }): Promise<{ events: CalendarEvent[] }> =>
        this.request("GET", "/calendar/events", { query: params }),
      create: (event: CalendarEventInput): Promise<CalendarEvent> => this.request("POST", "/calendar/events", { body: event }),
      update: (id: string, changes: Partial<CalendarEventInput>): Promise<CalendarEvent> =>
        this.request("PATCH", `/calendar/events/${enc(id)}`, { body: changes }),
      delete: (id: string): Promise<void> => this.request("DELETE", `/calendar/events/${enc(id)}`),
    },
  };

  async *#iteratePhotos(params: Omit<PhotoListParams, "cursor">): AsyncIterableIterator<Photo> {
    let cursor: string | undefined;
    for (;;) {
      const page = await this.gallery.photos.list({ ...params, cursor });
      for (const photo of page.photos) yield photo;
      if (!page.nextCursor) return;
      cursor = page.nextCursor;
    }
  }
}
