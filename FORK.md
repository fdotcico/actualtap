# ActualTap OIDC fork

This fork retains MattFaz/actualtap functionality but supports both `ACTUAL_SESSION_TOKEN` and `ACTUAL_PASSWORD` for Actual Budget.
If both are set, the session token takes precedence. The session token
belongs to Actual Budget; it is not a Cloudflare service token or tunnel token.
Upstream version remains v1.0.39 (Actual API 26.10.0); fork feature version is
1.1.0 and is reported separately in `/health`.

## GitHub and Docker Hub setup

1. Merge the integration branch into `fdotcico/actualtap:main` using a **merge
   commit**, preserving the upstream ancestry and the session-token commit.
2. Create the Docker Hub repository `fdotcico/actualtap-oidc`. Create a Docker Hub
   access token with write access and save it in GitHub Actions as the repository
   secret `DOCKERHUB_TOKEN`. Never commit it or put it in the NAS compose file.
3. Enable GitHub Actions for the fork. Under Actions settings, allow GitHub
   Actions to create pull requests. Organization policies may restrict this.
4. A push to main or a manual run of `Publish ActualTap OIDC to Docker Hub` on
   main tests and builds linux/amd64 (DS220+) and linux/arm64 images, then publishes:
   - `fdotcico/actualtap-oidc:latest`
   - `fdotcico/actualtap-oidc:sha-<full-git-commit>`
   - `fdotcico/actualtap-oidc:1.0.39-<full-git-commit>` (version follows package.json)

Upstream release tags such as `v1.0.39` refer to upstream source and do not contain
the fork patch. The publisher therefore builds main, not those upstream tags.
For repeatable deployment and rollback, use the image digest produced by the
build, or a commit-specific tag, rather than `latest`.

## Keeping up with upstream

`Propose upstream updates` runs each Monday at 06:23 UTC and can be started
manually. It merges `MattFaz/actualtap:main`, runs offline tests and an amd64
Docker build, then opens or updates an `automation/sync-upstream` pull request.
It stops on conflicts or failed checks; it never replaces the fork with upstream.
Review and merge with a merge commit, not squash/rebase, so the next run recognizes
previous upstream merges. Publication follows a human merge into main.

GitHub does not normally start another workflow for a PR created with
`GITHUB_TOKEN`, so the sync workflow runs its own validation before opening the PR.
If branch protection requires the separate PR check, arrange an approved GitHub
App token or manually push the update from a user account. No automatic NAS
redeployment is configured here. Scheduled workflows in inactive public forks
can be disabled by GitHub and need re-enabling.

The inherited upstream Dependabot auto-merge/release jobs are restricted to the
upstream repository. This fork receives those dependency changes through the
upstream sync instead.

## Persistent delivery and idempotency

Mount a dedicated local volume at `/data` (`DATA_DIR`); the Docker image defaults
to that path. It holds `outbox.sqlite` and the Actual API cache in `actual/`.
Without a mounted volume, container replacement loses this state. Use one
container per data directory. Startup locks the SQLite database and rejects a
volume belonging to a different Actual URL/budget. Back up this directory along
with your budget; stop the container for a plain filesystem copy including WAL
files, or use SQLite's backup API. Do not put the live database on NFS/SMB.

Each accepted request is committed to SQLite with full synchronization before
it is delivered. A serialized worker syncs remote state, checks the transaction
ID (including deleted records), adds only missing records, then syncs again.
Transient errors leave requests pending and retry with exponential backoff from
5 seconds up to 5 minutes. Requests are not discarded after a retry limit.
An Actual server outage or expired session requires service/authentication
recovery; queued data remains on disk. Initial startup still requires Actual to
be reachable and the configured budget to open.

| Response | Meaning | Client behavior |
| --- | --- | --- |
| `200`, `status: synced` | Delivered, or an already completed operation | Do not submit another operation |
| `202`, `status: queued` | Durably accepted; delivery will retry | Treat as accepted; optionally poll `Location` |
| `409` | Same operation key with a different payload | Correct the client; do not silently generate another key |
| `400` / `403` | Invalid request or forbidden account/client | Correct configuration or input |
| `503` | Acceptance could not be confirmed (storage/capacity) | Retry with the same operation key |

Send `Idempotency-Key: <UUID>` or body `eventId` (8-128 letters, digits, `_`, `-`).
If both are present they must match. Keys are scoped to the configured device ID.
Reusing a key with the same normalized payload returns the existing transaction;
with a changed payload it returns 409. Equal purchases with different keys remain
separate. Calls without a key remain compatible but cannot deduplicate independent
client resubmissions. A timed-out HTTP request is safe to retry only with its
original key and payload. Retry after a date rollover keeps the original date.

`GET /transactions/<id>` returns status and attempts for the authenticated device.
`GET /status` returns its pending/synced counts and oldest pending timestamp.
Both require `X-API-Key`. `/health` is liveness, not a guarantee of zero backlog.
Monitor `/status` and the generic delivery warnings to detect expired credentials.

Completed payloads are removed after seven days. Hashed operation keys,
fingerprints and transaction IDs remain as deduplication tombstones; an old replay
then returns only its ID, status and replay indicator. Pending payloads are always
retained. Application logs contain IDs/status, not amounts, merchants, notes,
coordinates or credentials. The data directory itself contains financial data.

Configuration: `QUEUE_MAX_PENDING` (default 10000), `QUEUE_RETRY_MS` (5000,
minimum 1000), `COMPLETED_PAYLOAD_DAYS` (7). Keep persistent state when upgrading or
rolling back. Idempotency is not a distributed exactly-once guarantee across
independent deployments/volumes or manual deletion of the outbox.

## Per-device credentials

Existing `API_KEY` remains supported under device ID `legacy`. Additional keys
are configured with `API_KEYS` (a JSON array) or `API_KEYS_FILE` (path to a JSON
file), but not both. Generate at least 32 random characters for each device key:

```json
[
  { "id": "iphone-1", "key": "REPLACE_WITH_A_RANDOM_DEVICE_KEY_32_CHARS_OR_MORE", "accounts": ["Checking"] },
  { "id": "iphone-2", "key": "REPLACE_WITH_ANOTHER_RANDOM_DEVICE_KEY_32_CHARS_OR_MORE", "accounts": ["Savings"] }
]
```

Omitting `accounts` grants access to all accounts in the configured budget;
`accounts: []` denies all transaction submissions. Names are case-insensitive.
Keep device IDs stable when rotating keys to preserve deduplication history.
Restart after changing credentials. Remove the legacy key only after migrating
all old Shortcuts. Already accepted transactions continue delivery after a key
is revoked. Status/transaction reads are isolated by device ID.

## Cloudflare, LAN access and a second iPhone

The access path is:

`iPhone Shortcut -> Cloudflare Access -> cloudflared -> ActualTap -> Actual Budget`

- The Shortcut sends `CF-Access-Client-Id` and `CF-Access-Client-Secret`. Access
  needs a corresponding Service Auth policy; a tunnel alone is not authentication.
- Its `API_KEY` variable becomes the HTTP `X-API-Key` header.
- `ACTUAL_SESSION_TOKEN` and the tunnel token stay on the NAS, never on a phone.
- A distinct Cloudflare service token per phone supports independent revocation.
  This fork does not create or administer Cloudflare tokens.

Optional `ALLOWED_CLIENT_IPS` accepts comma-separated **TCP peer IP addresses**.
It ignores forwarded headers and blocks unlisted peers before authentication,
including `/health`. Keep loopback addresses permitted for the container health
check. Measure the actual cloudflared source first: Docker NAT may present a
bridge gateway rather than the cloudflared container address. This restriction
blocks LAN clients but still trusts any traffic NATed through that same gateway;
it is not a cryptographic replacement for Cloudflare Access or your API keys.
Recheck after changing Docker networks. Do not blindly copy IPs from another NAS.

On each iPhone:

1. Install the Shortcut and set URL, Cloudflare headers and its own ActualTap key.
2. Add **Generate UUID** once per wallet event, before the HTTP request/retry loop.
   Store it in `EventID` and send `Idempotency-Key: EventID` on every attempt.
3. Keep the same UUID and body for transport retries. A new purchase needs a new
   UUID. A full rerun that generates a fresh UUID cannot be recognized as a retry;
   to retry later, retain the original operation data/UUID on the phone.
4. Treat both 200 and 202 as accepted. Poll the response `Location` when needed;
   never create a fresh operation just because delivery is still queued.
5. Map card names to permitted Actual accounts, then create the personal Apple
   Wallet transaction automation on that phone. Sharing a Shortcut does not copy
   personal automations. Avoid two automations submitting the same wallet event.

## Synology deployment and rollback

The existing Portainer stack is `actual`; update only its `actualtap` service.
Use the commit-specific image or registry digest from a successful build. Keep
port 3003 -> 3001, `ACTUAL_URL=http://actual_server:5006`, budget and credentials.
Mount `/volume1/docker/actualtap:/data`, set `DATA_DIR=/data`, and allow 90 seconds
for graceful shutdown. Portainer supplies some secrets externally to Compose;
do not run the file directly without reproducing its environment.

Stage the image with a separate container and no published ports, verify it can
open the real budget, then stop the staging container before starting production
with that same data volume. Never run two instances with the same volume.
Use read-only health/status checks on production; transaction tests use only a
disposable budget. Keep the previous Compose file and local image for rollback.
If rolling back to the old non-queue image, first drain the queue or preserve it
for later recovery; old code cannot process queued records.

## Validation

`npm test` runs offline tests, including an isolated real Actual SQLite budget,
concurrent replays, crash/WAL recovery, lost acknowledgements, deleted records,
credential forwarding, device scopes, privacy and IP restrictions. No production
credentials are needed. `npm run test:integration` is opt-in: set
`ACTUALTAP_TEST_BUDGET=disposable`, a dedicated `DATA_DIR`, and credentials for a
**disposable** Actual budget. It creates transactions.
