# Architecture decisions

## Client runtimes

The web and desktop applications share one React/Vite client. Tauri 2 packages the static Vite build for macOS, Windows, and Linux and provides an explicit native command boundary.

Mobile should use Expo/React Native when it is started. A data-dense grid does not translate directly to a phone; mobile should focus on saved views, answers, alerts, and lightweight record inspection. Domain types and networking are shared, while screens are native to the form factor.

## Database access

Web and mobile call the query gateway through authenticated HTTPS requests. The gateway owns encrypted credentials, network access, query limits, audit logs, and result truncation.

Desktop can operate in two modes:

1. Workspace mode uses the hosted gateway and shared connections.
2. Local mode uses Tauri commands and native database drivers without sending credentials to Orbit infrastructure.

Both modes implement the same transport contract so the UI remains runtime-agnostic.

## Safety defaults

- Connections are read-only unless explicitly elevated.
- Every AI-generated operation compiles to an inspectable query.
- Query time, row count, and byte limits are enforced server-side.
- Credentials never enter application logs or frontend persistence.
- Production connections are visibly labeled and protected.

## Initial database support

- PostgreSQL
- MySQL
- MongoDB

SQL and document databases expose a normalized metadata model while preserving native concepts such as schemas, tables, collections, JSON documents, and database-specific queries.

## Explore vertical slice

`@orbit/contracts` owns Zod schemas for both inputs and outputs. The gateway parses incoming requests and parses adapter responses before returning them. `@orbit/database` owns the adapter registry and provider implementations; provider drivers do not leak into routes or the client.

The connection repository separates public metadata from opaque secret references. The file-backed implementation encrypts connection URIs with AES-256-GCM, writes owner-only files atomically, and requires an externally supplied encryption key in production. The development key is persisted locally so connections survive restarts. `ConnectionStore` isolates this implementation so a distributed deployment can replace it with workspace persistence and a KMS-backed vault.

Connection creation is transactional at the application boundary: Orbit encrypts the credential, creates an adapter, tests connectivity, and removes both metadata and secret material if the test fails. Adapter instances are evicted and closed before edits or deletion. Manual schema refresh updates `lastSchemaRefresh`; test results update health and latency without exposing driver errors or credentials to the client.

PostgreSQL and MySQL browsing quotes identifiers and binds filter values. MongoDB builds operators from a fixed enum. Cursor payloads are opaque offsets today; the adapter contract permits replacing these with keyset/provider cursors without changing the client. Pools are capped at five connections per configured database. Every operation receives a timeout and request cancellation signal; explore responses are capped at 200 rows and checked against the configured serialized-byte limit.

The gateway records request ID, connection ID, object name, duration, and row/object count. It never records connection URIs, query parameters, or result values. A future audit repository can persist these metadata events.

## Ask execution boundary

Ask has two independent operations. `POST /api/ask/draft` introspects bounded schema context and asks the configured provider for a strict structured query plan; it never executes that plan. `POST /api/ask/execute` accepts the visible, possibly edited query, validates the language against the connection, repeats the SQL or MongoDB safety checks, resolves source objects against live introspection, and then invokes the read-only adapter with the normal time, row, and byte limits.

SQL rejects mutations, DDL, administrative statements, and multiple statements. MongoDB accepts only a fixed aggregation-stage allowlist and recursively rejects `$out`, `$merge`, `$function`, `$accumulator`, and `$where`. These checks complement—not replace—database-level read-only permissions.

Only schema metadata and the natural-language question are sent for query generation. Evidence rows remain inside Orbit; the concise response is currently derived locally to avoid silently transmitting result data to an AI provider. Provider progress is represented as operational status, never fabricated internal reasoning.

## Saved views and sharing

Saved views persist a validated source definition rather than result snapshots. Explore views retain their object, filter, and sort descriptors; Ask views retain their reviewed read-only query, language, assumptions, sources, and visualization. Each view also owns a twelve-column dashboard layout and manual refresh configuration. Refresh re-enters the same adapter limits and query-safety checks used by Explore and Ask.

Status transitions are persisted as `stale → refreshing → fresh` or `failed`; a missing connection produces `unavailable_connection`. The repository interface currently has atomic single-node file persistence and is ready to move behind workspace-scoped database storage. Scheduled refresh is represented by the refresh model but is not enabled.

Sharing creates a 256-bit random bearer token and persists only its SHA-256 hash. Public responses contain a sanitized title/component/visualization projection and freshly bounded results. They never contain connection identifiers, source definitions, filters, queries, assumptions, or dashboard layout. Regenerating or revoking a link invalidates the previous token.

## Delivery status

The Explore, connection-management, Ask, and Views slices are complete and usable with PostgreSQL, MySQL, and MongoDB connections. Workspace authentication, multi-user authorization, relationship browsing, virtualized grids, scheduled refresh, and mobile are subsequent slices.
