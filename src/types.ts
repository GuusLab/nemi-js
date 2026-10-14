/** Every scope an app can ask for. See https://dev.nemilab.com/docs for what each grants. */
export type NemiScope =
  | "openid"
  | "profile"
  | "email"
  | "offline_access"
  | "files.read"
  | "files.write"
  | "gallery.read"
  | "gallery.write"
  | "docs.read"
  | "docs.write"
  | "sheets.read"
  | "sheets.write"
  | "forms.read"
  | "forms.write"
  | "canvas.read"
  | "canvas.write"
  | "calendar.read"
  | "calendar.write";

export const NEMI_SCOPES: readonly NemiScope[] = [
  "openid",
  "profile",
  "email",
  "offline_access",
  "files.read",
  "files.write",
  "gallery.read",
  "gallery.write",
  "docs.read",
  "docs.write",
  "sheets.read",
  "sheets.write",
  "forms.read",
  "forms.write",
  "canvas.read",
  "canvas.write",
  "calendar.read",
  "calendar.write",
];

/** Tokens from the token endpoint, in camelCase, plus an absolute `expiresAt`. */
export interface TokenSet {
  /** `nemi_oat_...`, valid for `expiresIn` seconds. */
  accessToken: string;
  tokenType: "Bearer" | (string & {});
  expiresIn?: number;
  /** Epoch milliseconds when the access token expires, computed on receipt. */
  expiresAt?: number;
  /** `nemi_ort_...`, only with `offline_access`. Rotates on every refresh: always store the newest one. */
  refreshToken?: string;
  /** Space separated scopes that were actually granted. */
  scope?: string;
  /** OIDC id_token, only with `openid`. Verify it with `NemiAuth.verifyIdToken`. */
  idToken?: string;
}

/** Claims of a verified Nemi id_token. */
export interface IdTokenClaims {
  iss: string;
  aud: string | string[];
  /** Pairwise subject: stable for one developer, different between developers. */
  sub: string;
  iat: number;
  exp: number;
  auth_time?: number;
  nonce?: string;
  at_hash?: string;
  name?: string;
  preferred_username?: string;
  picture?: string;
  email?: string;
  email_verified?: boolean;
  [claim: string]: unknown;
}

/** UserInfo response in camelCase. Fields depend on the granted scopes. */
export interface NemiUserInfo {
  sub: string;
  name?: string;
  preferredUsername?: string;
  picture?: string;
  email?: string;
  emailVerified?: boolean;
  [claim: string]: unknown;
}

/** The person signed in, from `/me`. `id` is the pairwise `sub`. */
export interface NemiUser {
  id: string;
  name?: string;
  username?: string;
  picture?: string;
  email?: string;
  emailVerified?: boolean;
}

export interface Workspace {
  id: string;
  name: string;
  role: string;
}

export interface Folder {
  id: string;
  name: string;
}

export interface NemiFile {
  id: string;
  name: string;
  size: number;
  type: string;
  workspaceId: string;
  folderId: string | null;
  createdAt: string;
}

export interface DownloadLink {
  /** Works for 15 minutes without a token. */
  url: string;
  expiresAt: string;
}

export interface UploadSession {
  uploadId: string;
  uploadUrl: string;
  method: "PUT";
  expiresAt: string;
}

export interface Photo {
  id: string;
  name: string;
  width: number;
  height: number;
  size: number;
  capturedAt: string | null;
  favorite: boolean;
  /** Expires after 15 minutes: fetch again rather than storing it. */
  thumbnailUrl: string;
  /** Full size, only on `gallery.photos.get`. Expires after 15 minutes. */
  url?: string;
}

export interface PhotoPage {
  photos: Photo[];
  nextCursor: string | null;
}

export interface Album {
  id: string;
  name: string;
  count: number;
}

export interface DocSummary {
  id: string;
  title: string;
  workspaceId?: string;
  updatedAt?: string;
  [field: string]: unknown;
}

export interface Doc {
  id: string;
  title: string;
  markdown: string;
  workspaceId: string;
  updatedAt: string;
}

export type CellValue = string | number | boolean | null;

export interface SheetSummary {
  id: string;
  title: string;
  [field: string]: unknown;
}

export interface Sheet {
  id: string;
  title: string;
  /** Keyed by A1 references, such as `{ A1: "Name", B2: 42 }`. */
  cells: Record<string, CellValue>;
}

export interface FormSummary {
  id: string;
  title: string;
  [field: string]: unknown;
}

export interface Form {
  id: string;
  title: string;
  fields?: unknown[];
  [field: string]: unknown;
}

export interface FormResponses {
  responses: Array<Record<string, unknown>>;
  [field: string]: unknown;
}

export interface CanvasSummary {
  id: string;
  title?: string;
  name?: string;
  [field: string]: unknown;
}

export interface Canvas {
  id: string;
  [field: string]: unknown;
}

export interface CalendarEvent {
  id: string;
  title: string;
  start: string;
  end: string;
  allDay?: boolean;
  location?: string | null;
  description?: string | null;
  [field: string]: unknown;
}

export interface CalendarEventInput {
  title: string;
  /** ISO 8601 UTC. */
  start: string;
  /** ISO 8601 UTC. */
  end: string;
  allDay?: boolean;
  location?: string;
  description?: string;
}
