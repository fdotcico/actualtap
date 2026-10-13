# ActualTap OIDC fork

This fork retains MattFaz/actualtap functionality but authenticates to Actual
Budget with `ACTUAL_SESSION_TOKEN` instead of `ACTUAL_PASSWORD`. The session token
belongs to Actual Budget; it is not a Cloudflare service token or tunnel token.
The initial update merges upstream v1.0.39 (Actual API 26.10.0).

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

## Existing Synology deployment

Inspection on 2026-10-13 found:

- Container `actualtap`, local image `actualtap-oidc:1.0.37`, healthy.
- Host port 3003 forwards to container port 3001; network `actual_default`.
- `ACTUAL_URL=http://actual_server:5006`; Actual Budget is already 26.10.0.
- ActualTap uses `ACTUAL_SESSION_TOKEN`, `ACTUAL_SYNC_ID`, `API_KEY`, and optional
  `ACTUAL_ENCRYPTION_PASSWORD`. It has no persistent volume.
- The stack is managed by Portainer (compose project `actual`).

After successful publication, edit **only the actualtap image** in the existing
Portainer stack to `docker.io/fdotcico/actualtap-oidc@sha256:<published-digest>`.
Keep its existing environment, port 3003, network, and restart/health settings.
The standalone compose example here is not a replacement for the full NAS stack.
Keep the old local image for rollback. First check health/version; then send one
deliberate test transaction and confirm it appears exactly once in Actual Budget.
Live integration tests create transactions and must use a disposable budget.

## Cloudflare and a second iPhone

The access path is:

`iPhone Shortcut -> Cloudflare Access -> cloudflared -> ActualTap -> Actual Budget`

- Cloudflare service-token credentials are sent as `CF-Access-Client-Id` and
  `CF-Access-Client-Secret` by the Shortcut. Access must have a matching Service
  Auth policy; the presence of a tunnel alone does not enforce authentication.
- The Shortcut's `API_KEY` variable must become the HTTP `X-API-Key` header.
  ActualTap validates it independently of Cloudflare.
- `ACTUAL_SESSION_TOKEN` stays on the server. The tunnel token also stays on the
  server; neither belongs in a Shortcut.

A second iPhone can use the same URL, API key and Cloudflare service token, provided
the Access policy allows the request. Prefer a distinct Cloudflare service token
for each phone so either can be revoked independently. ActualTap currently has a
single shared API key and a single configured budget; the request's `account`
selects the account within that budget, without per-phone account restrictions.

Install the Shortcut on the second iPhone, set its credentials locally, map card
names to the desired Actual accounts, and recreate the Apple Wallet transaction
automation there. Sharing a Shortcut does not transfer its personal automation.
Avoid automations on both phones for the same event: ActualTap generates a new
transaction ID for every request and currently does not deduplicate retries.

## Improvements to consider

- Keep Cloudflare Service Auth enabled for the transaction endpoint. Inspect the
  actual policy before assuming the tunnel protects it.
- Port 3003 currently listens on all NAS interfaces, so LAN clients can bypass
  Cloudflare (they still need the ActualTap API key). Check router forwarding and
  NAS firewall rules. Restrict the bind address or use a shared Docker network
  with cloudflared only after verifying the tunnel origin configuration.
- Avoid logging full transaction bodies if merchant/location privacy matters.
- Add idempotency before automatically retrying transaction submissions.
- Consider dual password/session-token support upstream to reduce fork upkeep.

The offline checks validate session-token configuration and forwarding, sync
errors, and location handling. They do not validate your Cloudflare policy, real
Actual session expiry, or a production budget migration.
