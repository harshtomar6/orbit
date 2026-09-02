# Orbit

An AI-native database workspace for exploring raw data, asking questions, and saving reusable views.

## Architecture

- `apps/client` — React + Vite client used by the web app and Tauri desktop shell.
- `apps/gateway` — HTTPS query gateway used by web and mobile clients.
- `packages/contracts` — shared request, response, and database metadata types.
- `packages/database` — adapter interfaces for PostgreSQL, MySQL, and MongoDB.
- `packages/theme` — shared design tokens.
- `apps/client/src-tauri` — Tauri 2 desktop wrapper and native command boundary.

The browser never receives database credentials and never opens a native database socket. It calls the gateway over HTTPS. Desktop defaults to a native Rust transport and can switch to the gateway from the top bar.

In local mode, Tauri connects directly with SQLx pools for PostgreSQL/MySQL and the official MongoDB Rust driver. Credentials are stored in the operating-system credential vault (Keychain on macOS, Credential Manager on Windows, Secret Service on Linux); only non-secret connection metadata is written to Orbit's app-data directory. Explore is available locally. Ask, Views, and sharing remain gateway-backed and are disabled while local mode is selected.

## Getting started

```sh
pnpm install
pnpm dev
```

The client runs at `http://localhost:5173` and the gateway at `http://localhost:8787`.

With no connection configuration, the gateway exposes one visibly labeled, in-memory demo connection. It contains no credentials and is intended only for local evaluation.

## Configuring connections

Open the connection switcher and choose **Add or manage connections**. New connections are tested before they are committed. Public metadata and encrypted credential records are stored separately under `ORBIT_DATA_DIR` (default: `.orbit-data` in the gateway working directory); credentials are never returned by the API.

Development creates a local encryption key with owner-only file permissions. Production requires an explicit 32-byte base64 key:

```sh
export ORBIT_ENCRYPTION_KEY="$(openssl rand -base64 32)"
export ORBIT_API_TOKEN='replace-with-a-long-random-token'
export ORBIT_DATA_DIR='/var/lib/orbit'
pnpm dev
```

The file vault uses AES-256-GCM with a unique IV for every secret. Use a persistent volume and an externally managed encryption key in a single-node deployment; a distributed deployment should replace the vault implementation with KMS-backed secret storage. Create database users with read-only grants—Orbit's application checks are defense in depth, not a substitute for database permissions. `ORBIT_API_TOKEN` and `ORBIT_ENCRYPTION_KEY` are mandatory when `NODE_ENV=production`.

Gateway limits default to 10 seconds, 200 rows per request, and a 2 MB serialized response. Override time and response size with `QUERY_TIMEOUT_MS` and `MAX_RESPONSE_BYTES`.

## Configuring Ask

Ask uses OpenRouter's OpenAI-compatible Chat Completions API with strict Structured Outputs to generate a typed query plan. Configure the key only on the gateway:

```sh
export OPENROUTER_API_KEY='sk-or-v1-...'
export OPENROUTER_MODEL='openai/gpt-5.4' # optional; this is the current default
export OPENROUTER_SITE_URL='https://orbit.example.com' # optional attribution header
pnpm dev
```

For local development, these values can instead be placed in `apps/gateway/.env`; the gateway loads that file automatically on startup. Restart the gateway after changing it.

The browser never receives the API key. Orbit sends the selected database's object and column metadata plus the user's question to OpenRouter; it does not send database credentials. For MongoDB, the gateway builds a bounded schema profile from up to `MONGO_SCHEMA_SAMPLE_SIZE` sampled documents, including nested dotted paths, observed types, field presence, and safe low-cardinality enum candidates. It stores only this derived profile (never raw documents) in `ORBIT_DATA_DIR/schema-profiles.json`, reuses it for `MONGO_SCHEMA_PROFILE_TTL_MS`, and invalidates it when the connection or schema is refreshed. `ASK_SCHEMA_FIELD_LIMIT` bounds how many fields enter one model request. After an approved query runs, up to 50 bounded evidence rows are sent for the narrative summary. Generated queries are returned as unexecuted drafts. Users can inspect or edit them, and execution always requires a separate action that repeats server-side read-only validation. See the [OpenRouter OpenAI SDK documentation](https://openrouter.ai/docs/guides/community/openai-sdk).

For another OpenAI-compatible provider, set `ORBIT_LLM_API_KEY`, `ORBIT_LLM_BASE_URL`, and `ORBIT_LLM_MODEL`; these override the OpenRouter defaults.

## Implemented vertical slice

- Connection discovery and switching with environment, access, health, latency, and database metadata.
- Add, edit, test, refresh, and remove workflows with encrypted server-side credential storage and rollback on failed connection tests.
- PostgreSQL, MySQL, and MongoDB pooled adapters with native schema/object introspection.
- Parameterized filters, allowlisted sort identifiers, opaque server cursors, cancellation, timeouts, row limits, and response-size checks.
- Raw browsing with explicit loading/empty/error/timeout/permission states, column visibility, loaded-page search, CSV/JSON export, URL state, keyboard row selection, and JSON/document inspection.
- Structured request IDs and metadata-only audit events.
- Ask query drafting through strict provider output, mandatory inspect-before-run UX, editable/rerunnable queries, assumptions, sources, evidence rows, execution timing, and responsive table/bar/line/donut results with validated axes, tooltips, legends, and safe table fallback.
- Persistent Views saved from Explore or Ask with grid layout, real data-driven table/metric/line/bar/donut components, manual refresh, stale/refreshing/failed/unavailable states, rename, duplicate, delete, and revocable sharing.

Multi-user workspace persistence, session-based authentication, scheduled refresh, and mobile workflows are deliberately shown as incomplete rather than backed by fake production APIs.

Shared-view links use 256-bit random tokens. Orbit persists only a SHA-256 token hash and returns a sanitized public view plus freshly executed result rows; connection references, queries, filters, assumptions, and layouts are not included in public responses. Revoking a link immediately invalidates it.

To run the desktop shell, install the Tauri prerequisites (including Rust) and run:

```sh
pnpm desktop:dev
```

Use the `desktop · local ↔` control in the top bar to switch between local and gateway connections. Local queries are generated by the native command boundary with parameterized values, allowlisted identifiers, a 10-second timeout, a 200-row maximum, and a 2 MB response cap. Orbit also configures every SQL pool session as read-only; still use a database account with read-only grants as the primary security boundary.

## Desktop releases

Pushing a semantic-version tag starts the `Desktop release` GitHub Actions workflow. It verifies that the root, client, Tauri, and Cargo versions match the tag, runs the TypeScript and Rust checks, and builds installers for macOS Apple Silicon, macOS Intel, Windows x64, and Linux x64. Each build is retained as a workflow artifact and uploaded to a draft GitHub Release. The release is published only after every platform succeeds.

For example, after changing every version to `0.2.0`:

```sh
git tag v0.2.0
git push origin v0.2.0
```

The resulting installers are available from the repository's **Releases** page. macOS releases require a `Developer ID Application` certificate and Apple notarization credentials. The workflow refuses to publish an ad-hoc signed macOS build.

After exporting the certificate and private key from Keychain Access as a password-protected `.p12`, configure the repository secrets interactively:

```sh
./scripts/configure-apple-signing.sh /absolute/path/to/developer-id-application.p12
```

The script uploads `APPLE_CERTIFICATE`, `APPLE_CERTIFICATE_PASSWORD`, `APPLE_KEYCHAIN_PASSWORD`, `APPLE_ID`, `APPLE_PASSWORD`, and `APPLE_TEAM_ID` through the authenticated GitHub CLI without printing their values. `APPLE_PASSWORD` must be an app-specific password. During each macOS build, the workflow imports the certificate into an ephemeral keychain, signs with the discovered Developer ID identity, asks Apple to notarize the bundle, verifies Gatekeeper acceptance and the stapled ticket, then deletes the temporary keychain.

Windows builds are currently unsigned and may show a SmartScreen warning. Production Windows distribution should configure a Windows code-signing certificate separately.

## Mobile

Add `apps/mobile` with Expo when the mobile workflows are defined. Share `@orbit/contracts`, the API client, authentication, and theme tokens. Build mobile-specific screens rather than shrinking the desktop grid.
