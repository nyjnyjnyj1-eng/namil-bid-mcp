# Namil construction research extension

Added 2026-09-06 to https://github.com/alphago2580/naramarketmcp.
Base commit: 79fdfc2e9485261b006dd54426f1ba701a8f3dae.
The original project and this extension are distributed under Apache-2.0.
The original LICENSE and source files are retained.

The extension adds `namil/`, `tests_namil/`, three setup scripts,
`requirements-namil*.txt`, `Dockerfile.namil`, `.devcontainer/`, and Korean guidance.
README, .gitignore and .dockerignore have marked documentation/build changes.

The construction entry point is `python -m namil.server` and uses FastMCP 3.4.7.
The upstream `src.main`, original Dockerfile, Smithery setup, and requirements.txt
remain historical upstream code; they are NOT the supported execution/deployment
path for this extension and were not validated against its dependency set.

Features: six official API datasets; bounded page queries; HTTPS; sanitized
network failures; exact response-byte SQLite archive and SHA-256 verification;
full-field and raw snapshot retrieval; GitHub OAuth restricted to numeric owner
IDs; encrypted OAuth file storage; separate local/setup/production modes.

This is an initial implementation. Offline tests are included. Live API access,
user OAuth round-trip, container build and hosted ChatGPT connection require the
user's credentials/accounts and must be verified during setup. No recurring
job, automatic model training, attachment parsing or bidding automation is added.

Official API references checked:
- https://www.data.go.kr/data/15129394/openapi.do (construction notices/base amounts)
- https://www.data.go.kr/data/15129397/openapi.do (opening/ranks/preliminary/awards)
- The downloadable service reference documents clarify conditional parameters:
  notices/base/preliminary use inquiry mode 2 for notice number;
  opening/awards use mode 4; bidder ranks has no inquiry-mode parameter.

FastMCP security fixes inform the runtime selection:
- https://github.com/PrefectHQ/fastmcp/security/advisories/GHSA-rww4-4w9c-7733
- https://github.com/PrefectHQ/fastmcp/security/advisories/GHSA-5h2m-4q8j-pqpj

OAuth storage fix, 2026-09-06:
- Apply FileTree V1 key and collection sanitization so URL-based CIMD client IDs
  do not become nested paths and crash the authorization endpoint.
- Create the OAuth storage directory before inspecting filesystem name limits.
- Regression coverage exercises authorization and consent with URL client IDs,
  encrypted disk persistence after restart, and dynamic client registration.
- The sanitized storage names differ from the initial implementation. Start a
  fresh ChatGPT connection/login after deploying this fix; previous OAuth state
  is not migrated. API archives and the configured encryption key are unchanged.
- Reference: https://gofastmcp.com/servers/storage-backends#file-storage

Opening competitors collection, 2026-09-27:
- Add the `collect_opening_competitors` MCP tool. It pages through
  `bidder_ranks` (getOpengResultListInfoOpengCompt) for one notice, archiving
  every page with the existing SHA-256 snapshot store.
- Each call fetches at most `max_pages` pages (default 10, max 50);
  `next_page`/`start_page` resume a longer collection.
- `complete` is true only for a single call starting at page 1 that reached
  the last page with a stable total count, no duplicate rows across pages,
  no short pages and no errors. Pages saved before a mid-collection error are
  kept and reported with `stopped_reason`.
- The response reports row counts by notice order/classification/rebid
  number and distinct business numbers; full rows stay in the archive and are
  read with `read_saved_rows`.
- Offline tests: 30 passed. Live API behaviour for multi-page notices still
  needs verification with a real key.
