# Changelog

All notable changes to this package are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[Semantic Versioning](https://semver.org/).

## [0.1.0] - 2026-10-14

### Added

- `NemiAuth`: OAuth 2.0 and OpenID Connect client with PKCE S256, lazy discovery,
  code exchange, refresh, revoke, UserInfo and ES256 id_token verification with
  a cached JWKS that is refetched on an unknown `kid`.
- `NemiClient`: typed REST API v1 client for account, workspaces, files, folders,
  gallery, docs, sheets, forms, canvas and calendar, with camelCase and
  snake_case conversion, automatic refresh, 429 and network retries, the
  three step file upload and cursor iteration for photos.
- Typed errors: `NemiError`, `NemiApiError`, `NemiRateLimitError`,
  `NemiOAuthError`, `NemiNetworkError`.
- `@guuslab/nemi/browser`: redirect and popup sign-in helpers.
- `@guuslab/nemi/server`: helpers for confidential apps on Node and edge runtimes.
- `@guuslab/nemi/react`: `NemiProvider`, `useNemi()` and `SignInWithNemiButton`.
