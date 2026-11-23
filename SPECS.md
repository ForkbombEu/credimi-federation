# Project Specifications

## Template status

This repository was created from the Credimi Extras template. The template
required the derived project to choose exactly one backend stack and record
the decision here before implementation. This document is that record.

## Selected backend and rationale

**Node.js with TypeScript.**

- The human brief for this repository selects Node.js, TypeScript (strict
  mode), Fastify and pnpm.
- The only maintained OpenID Federation 1.0 authority implementation that
  matches the brief's requirements is a TypeScript library
  (`@oidfed/authority`, see below). Using it avoids writing federation
  statement assembly and signing logic by hand.
- The first federation members live in `credimi-capture-wallet`, which is a
  Node.js/TypeScript (Credo.TS) application. Sharing the stack keeps the
  integration documentation and test tooling uniform.

There is one backend stack. Do not add Go code or a second server stack.

## Language and runtime versions

| Tool       | Version             | Where it is pinned                                  |
| ---------- | ------------------- | --------------------------------------------------- |
| Node.js    | `latest` (dev)      | `mise.toml` (`node = "latest"`, required by BARIO)  |
| Node.js    | `26.13.1` (runtime) | `Dockerfile` base image `node:26.13.1-alpine`       |
| Node.js    | `>=26`              | `package.json` `engines`                            |
| pnpm       | `12.21.0`           | `mise.toml` and `package.json` `packageManager`     |
| Task       | `latest`            | `mise.toml`                                         |
| TypeScript | `6.0.3`             | `package.json`; TS 7 is not yet supported by ESLint |

At the time of writing `mise` resolves `node = "latest"` to `26.13.1`, the
same version as the production image. The production image is the
authoritative runtime; local development follows `mise`.

## Module or package identity

- npm package name: `credimi-federation` (private, not published).
- ES modules only (`"type": "module"`), compiled by `tsc` to `dist/`.
- Executables: `dist/server.js` (HTTP service) and `dist/cli.js`
  (`credimi-federation` CLI).
- License: Apache-2.0.

## Frameworks and dependencies

Runtime dependencies (all pinned to exact versions in `package.json`):

| Package             | Version   | License    | Purpose                                                                        |
| ------------------- | --------- | ---------- | ------------------------------------------------------------------------------ |
| `@oidfed/authority` | `2.0.0`   | Apache-2.0 | `TrustAnchor`: Entity Configuration, Subordinate Statements, fetch/list        |
| `@oidfed/core`      | `2.0.0`   | Apache-2.0 | Federation key provider, entity-ID validation, metadata policy schemas         |
| `jose`              | `6.2.13`  | MIT        | Key generation, JWK thumbprints, key import (same version `@oidfed/core` pins) |
| `fastify`           | `5.12.8`  | MIT        | HTTP server                                                                    |
| `@fastify/static`   | `10.1.12` | MIT        | Static brand and application assets                                            |
| `zod`               | `4.6.7`   | MIT        | Configuration validation (same version `@oidfed/core` pins)                    |
| `yaml`              | `2.9.1`   | ISC        | Parse the authoritative OpenAPI YAML to derive the JSON form                   |

Development dependencies: `typescript`, `@types/node`, `vitest`, `eslint`,
`@eslint/js`, `typescript-eslint`, `globals`, `prettier`, `stylelint`,
`stylelint-value-no-unknown-custom-properties`, and `@openid-federation/core`
(`0.2.1`, Apache-2.0, OpenWallet Foundation Labs — used only by the
interoperability test as an independent trust-chain resolver).

API documentation is rendered in the browser by Stoplight Elements `9.0.29`,
loaded from `unpkg.com` at that exact version by the `/docs` page only.

### Library evaluation: `@oidfed/authority` and `@oidfed/core`

Evaluated at version `2.0.0` (published November 2026, Apache-2.0,
source <https://github.com/Dahkenangnon/oidfed>).

- Targets the final OpenID Federation 1.0 specification.
- `TrustAnchor` exposes a fetch-compatible `handleRequest(Request)` that serves
  the Entity Configuration, fetch and list endpoints on the paths advertised in
  `metadata.federation_entity`, and returns 404 for every endpoint that is not
  advertised (resolve, historical keys, extended listing, trust marks).
- Verified behaviour (probe against the installed version): `typ` is
  `entity-statement+jwt`, `kid` is present, responses use
  `application/entity-statement+jwt`, unknown `sub` returns `404 not_found`,
  a `sub` equal to the issuer returns `400 invalid_request`, trust-mark list
  filters return `400 unsupported_parameter`, all as §8 of the specification
  requires or recommends.
- Signing goes through `jose`; no custom cryptography.
- Gap handled locally: a non-GET request returns
  `{"error":"method_not_allowed"}` without `error_description`, which is not
  the §8.9 error shape. Fastify routes only `GET`/`HEAD` to the library and
  answers other methods itself with a §8.9-shaped `405`.

Decision: adopt both packages. The `MemoryStorageAdapter` is used as an
in-process index built from the declarative subordinate file. The service
never writes to it after construction: on start, and after every change made
in the admin area, a new `TrustAnchor` with a fresh adapter is built from the
validated registry and replaces the previous one. Its "development-only"
label (which refers to persistence) therefore does not apply.

## Application architecture

```text
credimi-federation (one Node.js process)
  Fastify
    ├── federation routes  ──► @oidfed/authority TrustAnchor.handleRequest
    │     /.well-known/openid-federation   Entity Configuration (self-signed)
    │     /federation_fetch?sub=…          Subordinate Statement
    │     /federation_list                 Subordinate listing
    ├── /healthz                           liveness/readiness (JSON)
    ├── /openapi.yaml, /openapi.json       OpenAPI 3.1 (YAML is authoritative)
    ├── /docs                              Stoplight Elements
    ├── /, /inspect                        read-only server-rendered UI
    ├── /admin/*                           authenticated admin area (only when
    │                                      FEDERATION_ADMIN_PASSWORD is set)
    └── /assets/*, /favicon.svg            brand and application assets
```

- **Identity.** The Entity Identifier comes only from `FEDERATION_ENTITY_ID`.
  Every advertised URL is derived from it. Requests are forwarded to the
  library with a URL rebuilt from the configured identifier and the request
  path; the `Host` and `X-Forwarded-*` headers are never read.
- **Keys.** The Trust Anchor's private federation signing key is a single
  ES256 JWK created once by `credimi-federation init`. It is read either from
  the file named by `FEDERATION_SIGNING_KEY_PATH` or from the
  `FEDERATION_SIGNING_KEY` secret variable holding the same JSON; exactly one
  must be set, so a stale second source can never silently choose the
  identity. Startup validates it (P-256, `alg` ES256, `kid` equals its RFC 7638
  thumbprint, private/public halves match, and for a file, not group/world
  accessible) and refuses to start otherwise. Startup never creates or replaces
  keys. The variable form exists for platforms such as Coolify where a failing
  first start leaves no container in which to run `init`.
- **Membership.** A subordinate entry holds its Entity Identifier, pinned
  public federation JWKS, entity types, enabled flag and optional
  `metadata_policy`/`constraints`. Entries come from two sources:
  - The **GitHub registry**: the directory named by `FEDERATION_REGISTRY_DIR`
    (`registry/` in this repository, copied into the image). One JSON file per
    subordinate, holding one entry, named after its Entity Identifier: remove
    `https://` and a trailing `/`, replace every run of characters other than
    `A–Z`, `a–z`, `0–9`, `.` and `-` with `_`, append `.json`. It changes only
    through pull requests and is read-only at runtime.
  - The **local registry**: the JSON file named by
    `FEDERATION_SUBORDINATES_PATH`, edited by hand or in the admin area.

  Each source is validated at startup on its own; any error aborts startup.
  The served registry is every GitHub entry plus every local entry whose
  Entity Identifier (ignoring a trailing `/`) is not in the GitHub registry:
  **GitHub wins**. An overridden local entry stays in the local file, is
  marked as overridden in the admin area, is not served, and is logged as a
  warning at startup. Enabled served entries are registered with the
  `TrustAnchor`; disabled ones are shown in the UI but are not served by
  fetch or list. A missing local file means an empty local registry when the
  admin area is enabled or `FEDERATION_REGISTRY_DIR` is set.

- **Pull request checks.** `.github/workflows/registry.yml` runs on
  `pull_request` for changes under `registry/`, with a read-only token and no
  secrets. It builds the validator from the **base branch** and reads
  `config/trust-anchor.json` (the Trust Anchor's Entity Identifier and public
  JWKS, so no private key is needed in CI) from the base branch too; only the
  registry files come from the pull request, so a pull request cannot weaken
  the checks it is judged by. It runs `credimi-federation validate` on the
  whole GitHub registry, using the same validation as startup plus the
  file-name rule, then the live key check (below) on every member file the
  pull request adds or modifies whose entry is enabled; every check must pass.
  Disabled entries are not live-checked because they are not served, so no
  entry becomes served through a pull request without passing every check.
  `task ci` runs the offline validation on every push and pull request. In
  every workflow the live check retries a request that failed or got a 5xx
  answer once, so one network hiccup does not fail a member.
- **Weekly health check.** `.github/workflows/registry-health.yml` runs every
  Monday at 06:17 UTC and on demand. It live-checks every enabled member of
  the GitHub registry on the default branch. On failure it opens one issue
  labelled `registry-health`, or updates the open one and comments on it,
  with the report; when every check passes again it closes that issue. It
  is the only workflow with a write permission (`issues: write`). It never
  disables or removes a member: that is a trust decision made by pull
  request. GitHub suspends scheduled workflows in public repositories after
  60 days without activity; re-enable it in the Actions tab.
- **Administration (demo and testing).** When `FEDERATION_ADMIN_PASSWORD` is
  set, `/admin` lets one operator add, edit, enable, disable and delete
  entries of the local registry. Every change goes through the same
  validation as startup; it is written to the local registry file atomically
  (temporary file in the same directory, `fsync`, `rename`), one change at a
  time, and only then does a new `TrustAnchor` replace the running one. No
  restart is needed. A change that fails validation or cannot be written
  leaves the file and the served statements untouched. GitHub entries are
  shown read-only with a link to their file; the admin area refuses to add an
  entry, or rename one, to an Entity Identifier the GitHub registry holds.
  Overridden local entries can still be disabled or deleted. Every change is
  logged with the action and the Entity Identifier.
- **Admin authentication.** One shared password from the
  `FEDERATION_ADMIN_PASSWORD` secret (at least 16 characters), compared in
  constant time. A successful login creates a random session held in memory
  for 8 hours and sent as a `__Host-` cookie (`Secure`, `HttpOnly`,
  `SameSite=Strict`); sessions end on logout or restart. Every state-changing
  request carries a per-session CSRF token. After 10 failed logins in one
  minute, further attempts are refused until the minute ends. The admin area
  is not linked from the public pages.
- **Key pinning stays out of band.** Neither the admin area nor CI copies keys
  from a subordinate's Entity Configuration. In the admin area the operator
  pastes the public JWKS received over a trusted channel. In a pull request
  the keys come from the pull request's author, who is not a trusted channel:
  the live key check proves that whoever controls the Entity Identifier's
  host publishes an Entity Configuration signed with the proposed key, not who
  they are. Merging is the trust decision, made by a maintainer. The live key
  check (admin "Check live keys" page and `validate --live`) fetches the
  subordinate's Entity Configuration and checks that it is reachable,
  self-issued, signed by a pinned key, publishing exactly the pinned keys,
  naming this Trust Anchor in `authority_hints`, and unexpired.
- **No impersonation.** The service never holds subordinate private keys and
  never publishes Entity Configurations for other entities. It only signs
  Subordinate Statements about pinned public keys.
- **No database.** All state is the key file, the GitHub registry directory
  and the local registry file. Admin sessions are in memory only.

## CLI, web, and API interfaces

CLI (`credimi-federation`, also `node dist/cli.js`):

| Command    | Behaviour                                                                                                                                          |
| ---------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `init`     | Generate the ES256 federation key at `FEDERATION_SIGNING_KEY_PATH`; refuse to overwrite.                                                           |
| `check`    | Validate the key and both registries exactly as startup does, then exit.                                                                           |
| `jwks`     | Print the Trust Anchor's public JWKS (for out-of-band distribution).                                                                               |
| `validate` | `validate <registry-dir> <trust-anchor.json> [--live <member-file>...]`: validate a GitHub registry without any key; optionally live-check members |

`check` and `jwks` accept either key source. `validate` reads no environment
variable and needs no private key.

Public HTTP (all `GET`, no authentication, no write operations):

| Path                             | Response                                         |
| -------------------------------- | ------------------------------------------------ |
| `/.well-known/openid-federation` | `application/entity-statement+jwt`               |
| `/federation_fetch?sub=…`        | `application/entity-statement+jwt` or §8.9 error |
| `/federation_list`               | `application/json` array or §8.9 error           |
| `/healthz`                       | `application/json` `{"status":"ok"}`             |
| `/openapi.yaml`, `/openapi.json` | OpenAPI 3.1                                      |
| `/docs`                          | HTML, Stoplight Elements                         |
| `/`                              | HTML homepage                                    |
| `/inspect`, `/inspect?sub=…`     | HTML decoded view of a signed statement          |

Admin HTTP (registered only when `FEDERATION_ADMIN_PASSWORD` is set; HTML
forms posting `application/x-www-form-urlencoded`; everything except the
login page requires a session, and every `POST` except login requires the
CSRF token). These pages are not part of the OpenAPI description, which
covers the public API only.

| Method and path                     | Behaviour                                              |
| ----------------------------------- | ------------------------------------------------------ |
| `GET`, `POST` `/admin/login`        | Login form; checks the password, starts a session      |
| `POST` `/admin/logout`              | Ends the session                                       |
| `GET` `/admin`                      | Registry overview with actions                         |
| `GET`, `POST` `/admin/new`          | Add a subordinate                                      |
| `GET`, `POST` `/admin/edit?sub=…`   | Edit a subordinate                                     |
| `POST` `/admin/status`              | Enable or disable a subordinate                        |
| `GET`, `POST` `/admin/delete?sub=…` | Confirm and delete a subordinate                       |
| `GET` `/admin/check?sub=…`          | Compare pinned keys with the live Entity Configuration |

## Configuration

Environment variables (validated at startup; invalid values abort):

| Variable                       | Required | Default                          | Meaning                                                    |
| ------------------------------ | -------- | -------------------------------- | ---------------------------------------------------------- |
| `FEDERATION_ENTITY_ID`         | yes      | —                                | `https` origin of the Trust Anchor, no path/query/fragment |
| `FEDERATION_SIGNING_KEY_PATH`  | one of 2 | —                                | Private ES256 JWK file                                     |
| `FEDERATION_SIGNING_KEY`       | one of 2 | —                                | Private ES256 JWK JSON, supplied as a secret               |
| `FEDERATION_SUBORDINATES_PATH` | yes      | —                                | Local registry JSON file                                   |
| `FEDERATION_REGISTRY_DIR`      | no       | — (no GitHub registry)           | GitHub registry directory, one file per subordinate        |
| `PORT`                         | no       | `3000`                           | TCP port; the service binds `0.0.0.0`                      |
| `FEDERATION_NAME`              | no       | `OpenID Federation Trust Anchor` | Display name on the website                                |
| `FEDERATION_ADMIN_PASSWORD`    | no       | — (admin area off)               | Secret, ≥ 16 characters; enables `/admin`                  |

The Docker image sets `FEDERATION_SUBORDINATES_PATH=/data/subordinates.json`
and `FEDERATION_REGISTRY_DIR=/app/registry`. It sets no key variable, because
setting both key sources is refused. `.env.example` documents a complete local
configuration.

## Build, format, lint, and test commands

All commands run through Task; `mise install` provides Node.js, pnpm and Task.

| Command             | What it runs                                                                                                                     |
| ------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `task install`      | `pnpm install --frozen-lockfile`                                                                                                 |
| `task format`       | `prettier --write .`                                                                                                             |
| `task format:check` | `prettier --check .`                                                                                                             |
| `task lint`         | ESLint (strict type-checked), stylelint undefined-custom-property check, `tsc --noEmit`, Prettier check, then `task lint:design` |
| `task lint:design`  | `npx --yes @google/design.md lint DESIGN.md`                                                                                     |
| `task test`         | `vitest run`                                                                                                                     |
| `task build`        | `tsc -p tsconfig.build.json`                                                                                                     |
| `task run`          | build, then `node --env-file-if-exists=.env dist/server.js`                                                                      |
| `task init`         | build, then `dist/cli.js init`                                                                                                   |
| `task check`        | build, then `dist/cli.js check`                                                                                                  |
| `task validate`     | build, then `dist/cli.js validate registry config/trust-anchor.json` (offline)                                                   |
| `task ci`           | format check, lint, test, build, validate                                                                                        |
| `task docker:build` | `docker build -t credimi-federation:local .`                                                                                     |

GitHub Actions workflows, using the latest major version of every action
(`actions/checkout@v7`, `jdx/mise-action@v5`, checked on 23 November 2026):

| Workflow              | Trigger                            | Runs                                                                   |
| --------------------- | ---------------------------------- | ---------------------------------------------------------------------- |
| `ci.yml`              | push to `main`, every pull request | `task ci`; Docker image build                                          |
| `registry.yml`        | pull requests touching `registry/` | base-branch `validate` plus `--live` on added/modified enabled members |
| `registry-health.yml` | Mondays 06:17 UTC, manual          | `--live` on every member; opens/updates/closes the health issue        |

## Production and Docker execution

- Multi-stage `Dockerfile` on `node:26.13.1-alpine`; the runtime stage holds
  only `dist/`, production `node_modules`, `public/`, `openapi/` and
  `registry/`.
- Runs as the image's non-root `node` user (uid 1000).
- `/data` is a declared volume owned by `node`; when the file key source is
  used it holds `keys/federation.jwk` (mode `0600` in a `0700` directory) and
  `subordinates.json`.
- The container never generates keys. Either provision a file once with
  `docker run --rm -e FEDERATION_SIGNING_KEY_PATH=/data/keys/federation.jwk
-v <volume>:/data <image> node dist/cli.js init`, or generate the key
  elsewhere and pass it as the `FEDERATION_SIGNING_KEY` secret (the Coolify
  setup in the README, which needs no volume). Starting without a key fails
  with a clear error; so does starting without a local registry file, unless
  the admin area is enabled or `FEDERATION_REGISTRY_DIR` is set.
- With the admin area enabled, the registry must live in a writable directory
  on a persistent volume (for example `/data/subordinates.json`). A
  single-file bind mount such as a Coolify File Mount cannot be replaced by
  `rename` and is rewritten by Coolify on deploy, so it is not supported for
  an admin-managed registry; a save to it fails with an error naming the fix.
- `HEALTHCHECK` calls `GET /healthz` on `$PORT`.
- Behind Coolify (or any TLS-terminating proxy) only the proxy's public
  hostname must match `FEDERATION_ENTITY_ID`; the internal hostname and port
  never appear in responses.

## Important directories

| Path        | Contents                                                                |
| ----------- | ----------------------------------------------------------------------- |
| `src/`      | TypeScript sources                                                      |
| `tests/`    | Vitest suites                                                           |
| `openapi/`  | `openapi.yaml`, the authoritative API description                       |
| `public/`   | Runtime static assets: `brand/` (copy of `brand/`), `app.css`, `app.js` |
| `brand/`    | Canonical Credimi design assets (do not edit logos)                     |
| `config/`   | Example local registry (no real keys) and `trust-anchor.json`           |
| `registry/` | GitHub registry: one JSON file per subordinate, added by pull request   |
| `docs/`     | Template notes and the federation integration guide                     |

Runtime asset locations: `public/brand/style.css`, `public/brand/fonts/`,
`public/brand/logos/` are byte-identical copies of `brand/`; tests enforce the
logo SHA-256 pins from `DESIGN.md` §1 and byte equality of every copied file.
`public/app.css` loads after `public/brand/style.css`.

## Generated files

- `dist/` — compiled output, ignored by Git.
- `pnpm-lock.yaml` — committed lockfile.
- `pnpm-workspace.yaml` — written by pnpm to exempt freshly published pinned
  packages from its minimum-release-age check; committed.

## Repository-specific constraints

- Never commit private keys, `.env`, or `/data`. `*.jwk` is ignored.
- Never generate or replace the federation key during normal startup.
- Never derive URLs from request headers.
- Never add an unauthenticated write or registration endpoint. The admin area
  is the only runtime write path; it is off unless `FEDERATION_ADMIN_PASSWORD`
  is set. The GitHub registry changes only through merged pull requests.
- The admin area is a demo and testing convenience. A production deployment
  should rely on the GitHub registry only and leave the admin area off.
- Never pin a subordinate key taken from its Entity Configuration; keys are
  pasted by the operator after an out-of-band exchange, or proposed in a pull
  request that passes the live key check and is merged by a maintainer.
- `registry/` and `config/trust-anchor.json` are deployment data for the
  Credimi federation, not protocol logic; code never reads them by a
  hardcoded path, only through `FEDERATION_REGISTRY_DIR` and CLI arguments.
- Every GitHub Actions `uses:` reference names the latest major version of
  the action at the time of the change.
- Never hold or publish subordinate private keys.
- Protocol logic must not hardcode `federation.credimi.io` or any Credimi
  entity identifier; those appear only in examples and documentation.
- OpenID4VCI/OpenID4VP flows belong in `credimi-capture-wallet`, not here.
