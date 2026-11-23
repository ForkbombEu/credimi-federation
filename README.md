# credimi-federation

An OpenID Federation 1.0 Trust Anchor for Credimi development and
interoperability testing.

**Credimi** is the trustworthy compliance checker for decentralized identity
solutions, built and operated by Forkbomb BV (Amsterdam) under the NGI
TRUSTCHAIN programme. This repository is a Credimi Extra.

Issuers, verifiers and wallet providers that want to prove federation
membership need a Trust Anchor that publishes signed statements about them.
This service is that Trust Anchor for a small, self-hosted federation, starting
with the issuers and verifier of
[credimi-capture-wallet](https://github.com/ForkbombEu/credimi-capture-wallet).
It stays generic, so any issuer, verifier, wallet provider or federation entity
can be registered.

> This is a **test federation operated by Credimi**. It is not an officially
> recognized EUDI Wallet or IT-Wallet Trust Anchor, is not listed in any trusted
> list, and membership confers no accreditation or certification.

What it does:

- Publishes its self-signed **Entity Configuration** at
  `/.well-known/openid-federation`.
- Signs **Subordinate Statements** about registered entities at
  `/federation_fetch`, pinning each subordinate's approved public keys.
- Lists its subordinates at `/federation_list`.
- Shows its configuration on a read-only public website and documents its API
  with OpenAPI 3.1 and Stoplight Elements.
- Takes new members by **pull request**: each member is one JSON file in
  [`registry/`](registry/), and a GitHub Actions workflow validates it and
  checks the member's live Entity Configuration before a maintainer merges.
- Optionally, for demo and testing deployments, offers a password-protected
  **admin area** at `/admin` to add, edit, enable, disable and delete
  local subordinates without editing files or restarting.

```text
credimi-federation
  └── Trust Anchor (FEDERATION_ENTITY_ID, own ES256 key)
        ├── Credential Issuer A   (own Entity ID, Entity Configuration and keys)
        ├── Credential Issuer B
        ├── Credential Verifier
        └── other future entities
```

The Trust Anchor never holds a subordinate's private key and never publishes
statements on a subordinate's behalf. Each subordinate keeps its own Entity
Identifier, Entity Configuration and federation keys.

## Technical specs

- **Node.js + TypeScript** (strict), **Fastify**, **pnpm**; Docker image on
  `node:26.13.1-alpine`.
- [`@oidfed/authority`](https://github.com/Dahkenangnon/oidfed) and
  `@oidfed/core` 2.0.0 build and sign every Entity Statement (OpenID
  Federation 1.0 final). No federation logic or cryptography is hand-written.
- `jose` generates the ES256 key and computes its RFC 7638 thumbprint `kid`.
- No database: membership is the GitHub registry directory (one validated
  JSON file per member, changed by pull request) plus a local registry file
  (edited by hand or through the optional admin area); identity is one key
  file.
- Server-rendered HTML with the Credimi brand assets; no frontend framework.
- Tests: Vitest. The end-to-end test builds a Trust Chain from a locally
  generated subordinate and verifies it with `@openid-federation/core`
  (OpenWallet Foundation Labs, independent of the signing library), with a
  direct `jose` implementation of the §10.2 checks, and with `@oidfed/core`.

Versions, dependencies and architecture decisions: [SPECS.md](SPECS.md).
Standards, versions and maturity: [STANDARDS.md](STANDARDS.md).

## How to run

Prerequisites: [mise](https://mise.jdx.dev/) (installs Node.js, pnpm, Task).

```sh
mise install
task install

cp .env.example .env
# For local development, point the paths at ./data and ./registry:
#   FEDERATION_SIGNING_KEY_PATH=./data/keys/federation.jwk
#   FEDERATION_SUBORDINATES_PATH=./data/subordinates.json
#   FEDERATION_REGISTRY_DIR=./registry

task init                                    # once: create the federation key
task check                                   # validate key + both registries
task run                                     # http://localhost:3000
```

`./data/` is git-ignored. Restarting with the same files keeps the same
federation identity; the service never creates or replaces the key itself.

Development checks: `task format`, `task lint`, `task test`, `task build`,
`task validate` (the GitHub registry, offline), or all of them with `task ci`.

### Environment variables

| Variable                       | Required   | Default                           | Meaning                                                     |
| ------------------------------ | ---------- | --------------------------------- | ----------------------------------------------------------- |
| `FEDERATION_ENTITY_ID`         | yes        | —                                 | Public `https` origin, e.g. `https://federation.credimi.io` |
| `FEDERATION_SIGNING_KEY_PATH`  | one of two | —                                 | File holding the private ES256 JWK, mode `0600`             |
| `FEDERATION_SIGNING_KEY`       | one of two | —                                 | The private ES256 JWK itself (JSON), as a secret            |
| `FEDERATION_SUBORDINATES_PATH` | yes        | `/data/subordinates.json` (image) | Local registry (hand-edited or admin-managed)               |
| `FEDERATION_REGISTRY_DIR`      | no         | `/app/registry` (image)           | GitHub registry directory; empty value turns it off         |
| `PORT`                         | no         | `3000`                            | Listening port                                              |
| `FEDERATION_NAME`              | no         | `OpenID Federation Trust Anchor`  | Website title                                               |
| `FEDERATION_ADMIN_PASSWORD`    | no         | — (admin area off)                | Secret of at least 16 characters; enables `/admin`          |

Set exactly one of `FEDERATION_SIGNING_KEY_PATH` and `FEDERATION_SIGNING_KEY`;
the service refuses to start with both or neither. The variable form passes the
same key checks as the file, except the file-permission check.

The Entity Identifier comes only from `FEDERATION_ENTITY_ID`. The service never
reads `Host` or `X-Forwarded-*`, so it can sit behind any TLS-terminating proxy;
the internal hostname and port never appear in responses. The identifier must
be an origin without a path.

## Docker and Coolify

```sh
docker build -t credimi-federation .
docker volume create credimi-federation-data

# Once: provision the key (the container never does this on its own)
docker run --rm -e FEDERATION_SIGNING_KEY_PATH=/data/keys/federation.jwk \
  -v credimi-federation-data:/data credimi-federation node dist/cli.js init
docker run --rm -v credimi-federation-data:/data credimi-federation \
  sh -c 'echo "{\"subordinates\": []}" > /data/subordinates.json'

docker run -d --name credimi-federation -p 3000:3000 \
  -e FEDERATION_ENTITY_ID=https://federation.credimi.io \
  -e FEDERATION_SIGNING_KEY_PATH=/data/keys/federation.jwk \
  -v credimi-federation-data:/data credimi-federation
```

The image runs as the non-root `node` user (uid 1000), declares `/data` as a
volume, and has a `HEALTHCHECK` on `/healthz`. It refuses to start, with a
message naming what is missing, if the key or registry is absent (a missing
registry is allowed when the admin area is enabled), and refuses a key file
readable by group or others.

### Coolify

A failing first start is rolled back by Coolify, so there is no container
terminal in which to run `init`. Provision the key on your own machine and give
it to Coolify as a secret instead:

1. Locally: `FEDERATION_SIGNING_KEY_PATH=./data/keys/federation.jwk task init`.
   Keep `data/keys/federation.jwk` in encrypted storage; it is your backup.
2. Print it on one line: `tr -d ' \n' < data/keys/federation.jwk`.
3. In Coolify, create an application from this repository with the Dockerfile
   build pack, expose port `3000`, and point `federation.credimi.io` at it with
   HTTPS.
4. Environment variables: `FEDERATION_ENTITY_ID=https://federation.credimi.io`,
   `FEDERATION_SIGNING_KEY=<the one-line JSON>` marked as a secret, and
   optionally `FEDERATION_NAME`. Do not set `FEDERATION_SIGNING_KEY_PATH`. The
   image already sets `FEDERATION_REGISTRY_DIR=/app/registry` (the GitHub
   registry baked into the image) and
   `FEDERATION_SUBORDINATES_PATH=/data/subordinates.json` (a missing local
   registry file is an empty local registry).
5. Turn on automatic deployment for pushes to `main`, so that every merged
   registry pull request is live after the next build.
6. Optional, for entries you do not want in Git: set
   `FEDERATION_SUBORDINATES_PATH=/config/subordinates.json` and add a **File
   Mount** there with the content `{"subordinates": []}`. It holds only public
   keys, so editing it in Coolify is fine; redeploy after each change.
7. Deploy, then check that the `kid` on the homepage matches the one `task init`
   printed and the one in `config/trust-anchor.json`.

The private key is then stored, encrypted, in Coolify's database and is visible
to Coolify administrators. No volume is needed in this setup.

#### Coolify with the admin area (demo and testing)

To manage local members from the browser instead of the File Mount, change
steps 4 and 6:

- Environment variables: also set `FEDERATION_ADMIN_PASSWORD` as a secret
  (generate one with `openssl rand -base64 24`), and set
  `FEDERATION_SUBORDINATES_PATH=/data/subordinates.json`.
- Storage: instead of the File Mount, add a **Volume Mount** at `/data`. The
  registry file is created there on the first save. A File Mount cannot be
  used: the service replaces the file atomically on every change, which a
  single-file mount does not allow, and Coolify would rewrite it on the next
  deploy anyway.

Then sign in at `https://federation.credimi.io/admin/login`. For a production
federation, leave the admin area off and rely on the GitHub registry.

## Key management

- **Initialization**: `credimi-federation init` writes an ES256 P-256 JWK with
  `kid` = RFC 7638 thumbprint, mode `0600`, in a `0700` directory. It refuses to
  overwrite an existing file.
- **Startup validation**: curve, algorithm, `kid` thumbprint, matching key pair
  and file permissions are checked on every start; any failure stops the
  service.
- **Backup**: copy `federation.jwk` to encrypted offline storage right after
  `init` (for Docker: `docker run --rm -v credimi-federation-data:/data
credimi-federation cat /data/keys/federation.jwk > backup.jwk`, then encrypt
  it and delete the plaintext). With `FEDERATION_SIGNING_KEY`, the file you
  generated locally is the backup. Never commit it; `*.jwk` and `data/` are
  git-ignored.
- **Restore**: put the file back at `FEDERATION_SIGNING_KEY_PATH`, owned by the
  service user with mode `0600`, or paste its one-line form into
  `FEDERATION_SIGNING_KEY`, and start. The `kid` printed by `task check` must
  match the one you distributed.
- **Rotation** (OpenID Federation 1.0 §11.2, not automated yet): publish the new
  public key alongside the current one in the Entity Configuration, keep
  signing with the old key until every relying party has re-fetched the Entity
  Configuration and updated its trust anchor configuration, switch signing to
  the new key, and remove the old key after a further overlap period. The
  library's key provider supports these stages; wiring them to configuration
  is a future enhancement. Also update the public keys in
  `config/trust-anchor.json`, which CI validates the GitHub registry against.

### Distributing the Trust Anchor's public keys

Relying parties must configure the Trust Anchor's Entity Identifier and public
keys out of band; fetching them from the Entity Configuration alone proves
nothing. Export them with:

```sh
node dist/cli.js jwks > credimi-federation.jwks.json
```

and publish the JWK Set (or at least each `kid`) through a channel the relying
party already trusts, such as a signed release, the repository README, or
direct exchange. The website lists the current key IDs so they can be compared.

## Registering a subordinate

There is no public registration endpoint. A subordinate is registered in one
of two places, and each entry pins its **public** federation keys:

- **GitHub registry** (`registry/`, the usual way): the subordinate's operator
  opens a pull request adding one file named after the Entity Identifier, as
  [registry/README.md](registry/README.md) explains. The **Registry**
  workflow builds the validator from the base branch, validates the whole
  directory, and fetches the live Entity Configuration of every enabled entry
  the pull request adds or changes. Every check must pass. Merging is the
  trust decision: the checks prove that whoever controls the host publishes
  those keys, not who they are. The merged file ships in the next image.
  Every Monday the **Registry health** workflow live-checks every member
  again; failures open (or update) one issue labelled `registry-health`,
  which closes itself once everything passes. Failing members stay served
  until a pull request disables or removes them.
- **Local registry** (`FEDERATION_SUBORDINATES_PATH`): the operator adds an
  entry with keys obtained over a trusted channel, by editing the file and
  restarting or in the admin area (see [Quick GUI guide](#admin-area)). See
  [config/subordinates.example.json](config/subordinates.example.json).

**GitHub wins**: if both registries hold the same Entity Identifier (ignoring
a trailing `/`), the GitHub entry is served, and the local one is kept but
marked as overridden, not served, and logged as a warning at startup.

| Member            | Required | Meaning                                                                                 |
| ----------------- | -------- | --------------------------------------------------------------------------------------- |
| `entity_id`       | yes      | The subordinate's Entity Identifier (`https`, no query or fragment)                     |
| `enabled`         | yes      | `false` keeps the entry visible but out of fetch and list                               |
| `jwks`            | yes      | `{"keys": [...]}` public EC (P-256/384/521) or RSA (≥ 2048-bit) keys, each with a `kid` |
| `entity_types`    | no       | Entity Type Identifiers, used for listing and display                                   |
| `metadata_policy` | no       | OpenID Federation 1.0 §6.1 policy, standard operators only                              |
| `constraints`     | no       | `max_path_length`, `naming_constraints`, `allowed_entity_types` (§6.2)                  |

Both registries are validated on start and by `task check`; duplicates,
private key members, the Trust Anchor's own key, unknown members and invalid
policies are rejected and the service does not start. The GitHub registry is
also checked by `task validate` and in CI, against the Trust Anchor's public
identity in [config/trust-anchor.json](config/trust-anchor.json), so no
private key is needed there. Restart after editing the local file by hand;
the admin area applies the same validation to every change and refuses to
save an invalid one.

## Quick GUI guide

### Homepage

`/` shows the federation name and Entity Identifier, a notice that this is a
Credimi-operated test federation, the Trust Anchor status (signing key loaded,
Entity Configuration issue and expiry time, enabled subordinates), the
advertised federation endpoints, the public signing key IDs, and every
registered subordinate with its entity types, status and key IDs.

### Inspecting and downloading statements

- **Download Entity Configuration** saves the signed JWT;
  **Inspect Entity Configuration** (`/inspect`) shows its decoded JOSE header
  and claims next to the compact JWT.
- In the subordinate table, **Inspect** (`/inspect?sub=…`) and **Download**
  do the same for each enabled subordinate's Subordinate Statement. Disabled
  entries have no published statement.

### API documentation

**API docs** (`/docs`) renders the OpenAPI description with Stoplight Elements
(pinned `9.0.29`); "Send API Request" calls this deployment directly.
**OpenAPI** links the raw document.

The public website is read-only: no authentication, no forms, no
administrative actions, and no link to the admin area.

### Admin area

Present only when `FEDERATION_ADMIN_PASSWORD` is set; meant for demo and
testing deployments.

- **Sign in** at `/admin/login` with the admin password. The session lasts
  8 hours or until **Sign out** in the admin bar or a restart. After 10 wrong
  passwords in a minute, sign-in is refused until the minute is over.
- **Registry** (`/admin`) lists every subordinate of both registries with its
  source, entity types, status and key IDs. Local entries have the actions
  **Edit**, **Check live keys**, **Enable**/**Disable** and **Delete**.
  GitHub entries link to their file and offer only **Check live keys**; they
  change by pull request. A local entry overridden by GitHub is marked
  "Overridden by GitHub, not served".
- The admin area refuses to add a local entry, or rename one, to an Entity
  Identifier the GitHub registry holds.
- **Add subordinate** asks for the Entity Identifier, entity types (separated
  by spaces or commas), the public keys exactly as the subordinate's operator
  sent them (a JWK Set, an array of JWKs or one JWK), and optionally a metadata
  policy and constraints as JSON. New entries start disabled unless you tick
  **Enabled**. If anything is invalid, nothing is saved and the form lists the
  problems.
- **Check live keys** fetches the subordinate's Entity Configuration and
  reports whether it is reachable, self-issued, signed with a pinned key,
  publishing the same keys that are pinned, naming this Trust Anchor in
  `authority_hints`, and unexpired. It never changes the registry. Run it
  before enabling an entry.
- **Delete** asks for confirmation first. To stop vouching for an entity but
  keep its entry, disable it instead.

Every saved change is live immediately — fetch, list and the homepage serve
the new registry without a restart — and is logged with the action and the
Entity Identifier.

## CLI examples

| Command    | Example                                                                              | Effect                                                               |
| ---------- | ------------------------------------------------------------------------------------ | -------------------------------------------------------------------- |
| `init`     | `node dist/cli.js init`                                                              | Create the federation signing key once                               |
| `check`    | `node dist/cli.js check`                                                             | Validate configuration, key and both registries, then exit           |
| `jwks`     | `node dist/cli.js jwks > ta.jwks.json`                                               | Export the public JWK Set for distribution                           |
| `validate` | `node dist/cli.js validate registry config/trust-anchor.json --live registry/x.json` | Validate the GitHub registry without keys; live-check listed members |
| `help`     | `node dist/cli.js help`                                                              | Show usage                                                           |

## API examples

| Endpoint                             | Example                                                                                 |
| ------------------------------------ | --------------------------------------------------------------------------------------- |
| `GET /.well-known/openid-federation` | `curl -s http://localhost:3000/.well-known/openid-federation`                           |
| `GET /federation_fetch?sub=…`        | `curl -s 'http://localhost:3000/federation_fetch?sub=https%3A%2F%2Fissuer.example.org'` |
| `GET /federation_list`               | `curl -s 'http://localhost:3000/federation_list?entity_type=openid_credential_issuer'`  |
| `GET /healthz`                       | `curl -s http://localhost:3000/healthz`                                                 |
| `GET /openapi.yaml`                  | `curl -s http://localhost:3000/openapi.yaml`                                            |
| `GET /openapi.json`                  | `curl -s http://localhost:3000/openapi.json`                                            |

Decode a statement's claims locally:

```sh
curl -s http://localhost:3000/.well-known/openid-federation | cut -d. -f2 | base64 -d 2>/dev/null; echo
```

Errors follow OpenID Federation 1.0 §8.9, for example
`404 {"error":"not_found","error_description":"Entity not found"}` for an
unknown `sub`.

## Integrating issuers and verifiers

Each issuer or verifier keeps its own identity and needs: its own federation
signing keys; its own signed Entity Configuration at
`<entity_id>/.well-known/openid-federation`; `authority_hints` set to this
Trust Anchor's Entity Identifier; its public federation keys registered here,
normally by pull request to [`registry/`](registry/README.md); protocol metadata (`openid_credential_issuer`,
`openid_credential_verifier`, …) in its Entity Configuration; and wallets or
relying parties configured with this Trust Anchor's identifier and public keys.

The step-by-step guide, including how to verify that a subordinate and the
Trust Anchor work together, is [docs/INTEGRATION.md](docs/INTEGRATION.md).

## Future enhancements

Not implemented in this MVP: the Resolve endpoint, Trust Mark issuance and
status, Historical Keys, automated key rotation, dynamic or explicit
registration, Intermediate Entities, and paths in the Entity Identifier.

## Governance

Read [AGENTS.md](AGENTS.md) and [directives/](directives/) before
contributing. Design rules are in [DESIGN.md](DESIGN.md); the canonical brand
assets are in [brand/](brand/) and their runtime copies in `public/brand/`.
