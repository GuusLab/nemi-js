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
  method: "PUT" | (string & {});
  /** Send exactly these headers with the PUT, and no bearer token. Keys are kept as the server sent them. */
  headers: Record<string, string>;
  /** Largest accepted body in bytes. */
  maxSize: number;
  expiresAt: string;
}

/** A folder as answered by `POST /folders`. */
export interface CreatedFolder {
  id: string;
  name: string;
  workspaceId: string;
  parentId: string | null;
}

export interface Photo {
  id: string;
  workspaceId: string;
  name: string;
  width: number;
  height: number;
  size: number;
  capturedAt: string | null;
  favorite: boolean;
  /** Dominant colour, for placeholders. */
  color: string | null;
  /** Expires after 15 minutes: fetch again rather than storing it. */
  thumbnailUrl: string;
}

/** A single photo from `gallery.photos.get` (and `update`): adds the full size URL and its albums. */
export interface PhotoDetail extends Photo {
  /** Full size, expires after 15 minutes. */
  url: string;
  albums: Array<{ id: string; name: string }>;
}

export interface PhotoPage {
  photos: Photo[];
  nextCursor: string | null;
}

export interface Album {
  id: string;
  name: string;
  count: number;
  coverUrl: string | null;
}

export interface AddPhotosResult {
  albumId: string;
  added: number;
  skipped: number;
}

export interface DocSummary {
  id: string;
  title: string;
  preview: string;
  workspaceId: string;
  updatedAt: string;
}

export interface Doc extends DocSummary {
  markdown: string;
}

export type CellValue = string | number | boolean | null;

export interface SheetSummary {
  id: string;
  title: string;
  workspaceId: string;
  updatedAt: string;
}

/** A sheet's first tab. */
export interface Sheet extends SheetSummary {
  rows: number;
  cols: number;
  /** Keyed by A1 references, such as `{ A1: "Name", B2: 42 }`. */
  cells: Record<string, CellValue>;
}

export interface SetCellsResult {
  id: string;
  updated: number;
}

export interface FormSummary {
  id: string;
  title: string;
  published: boolean;
  workspaceId: string;
  updatedAt: string;
}

/** A form with its questions. The exact fields are documented at https://dev.nemilab.com/docs. */
export interface Form {
  id: string;
  title: string;
  [field: string]: unknown;
}

export interface FormResponses {
  formId: string;
  total: number;
  responses: Array<Record<string, unknown>>;
}

export interface CanvasSummary {
  id: string;
  title: string;
  workspaceId: string;
  updatedAt: string;
}

/** A board with its shapes and text (and strokes when asked for). */
export interface Canvas {
  id: string;
  [field: string]: unknown;
}

export interface Calendar {
  id: string;
  name: string;
  color: string | null;
  timezone: string | null;
  primary: boolean;
}

export interface CalendarEvent {
  id: string;
  calendarId: string;
  title: string;
  start: string;
  end: string;
  allDay: boolean;
  location: string | null;
  description: string | null;
  timezone: string | null;
  rrule: string | null;
}

export interface CalendarEventInput {
  /** Defaults to the person's primary Nemi calendar. */
  calendarId?: string;
  title: string;
  /** ISO 8601. */
  start: string;
  /** ISO 8601. */
  end: string;
  allDay?: boolean;
  location?: string;
  description?: string;
  /** IANA time zone, such as `Europe/Amsterdam`. */
  timezone?: string;
  /** RFC 5545 recurrence rule, such as `FREQ=WEEKLY;BYDAY=MO`. */
  rrule?: string;
}
