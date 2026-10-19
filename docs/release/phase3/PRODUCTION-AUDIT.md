# Production infrastructure audit (read-only, 2026-10-19)

Everything below was **read only**. No production setting, credential, deployment or data was
changed. Each proposal names the exact change and waits for the founder's separate approval.

## 1. Frontend origins

| Origin | Evidence |
|---|---|
| `https://e-commerce.getlifeos.app` | Netlify production site `e-commerceos` custom domain; SSL forced; no domain aliases |
| `https://e-commerceos.netlify.app` | the site's default Netlify domain |

The published deploy is `6aae72662dde6d000853209f`, built from commit `f06227c`. It is unchanged
since the Phase 1 snapshot.

## 2. CORS: the live production API reflects any origin

Requests to the public `GET /health` endpoint with these `Origin` headers:

```
Origin: https://e-commerce.getlifeos.app  ->  access-control-allow-origin: https://e-commerce.getlifeos.app
Origin: https://attacker.netlify.app      ->  access-control-allow-origin: https://attacker.netlify.app
Origin: https://evil.example              ->  access-control-allow-origin: https://evil.example
```

Credentials are allowed, so any website can make credentialed calls to the production API from
a visitor's browser.

- **Fix (on this branch):** only `CORS_ORIGINS` applies. Production refuses to boot with `*`,
  http, localhost or shared-hosting wildcards.
- **Proposed value:** `CORS_ORIGINS=https://e-commerce.getlifeos.app,https://e-commerceos.netlify.app`.
- **Order:** set the variable with `--skip-deploys`, then deploy. A wrong value fails the health
  check, and the previous deployment keeps serving.

## 3. GitHub branch protection and required checks

| Item | Found |
|---|---|
| `main` protection | **none** (`Branch not protected`); no rulesets |
| `main` head | `f06227c` (production) |
| CI workflow | exists on the PR branches only; `main` gets it when PR #2 merges |
| Secret scanning / push protection | enabled / enabled; 0 open alerts |
| Dependabot security updates | disabled |

**Proposed** (after PR #2 is merged, so the checks exist on `main`): protect `main`.
- Require a pull request with one approving review, and dismiss stale approvals.
- Require these status checks to pass, against an up-to-date branch:
  - `Build, typecheck, e2e (SQLite)`
  - `e2e (PostgreSQL)`
  - `Environment isolation`
  - `Secret scan (full history)`
  - `GitGuardian Security Checks`
- Block force pushes and deletions, and include administrators.
- Separately, enable Dependabot security updates.

## 4. Deployment gating

| Service | Found | Proposal |
|---|---|---|
| Railway `ecommerceos-api` (production) | Deploys automatically on push to `main` with `checkSuites: false` (no "Wait for CI"). Health check `/health`, 60 s timeout; restart on failure | Enable **Wait for CI** on the trigger (`checkSuites: true`), so a deploy starts only after GitHub checks pass |
| Railway `Postgres` (production) | Image `postgres-ssl:18`, no deploy trigger | — |
| Netlify `e-commerceos` | Builds and **publishes automatically** on push to `main`. Deploy Previews off; branch deploys limited to `main` | Lock automatic publishing: publish a verified deploy by hand after CI and API smoke tests, or move publishing behind CI |

## 5. Backup and tested restore

**Current production:** no backups are configured. Railway native backups need a Pro workspace,
which this workspace is not.

**Tested procedure** (staging, run four times with the `pg-backup-job` service):
1. **Snapshot:** `pg_dump --format=custom`, then restore into a separate database
   (`pre_candidate_snapshot`). Row counts and table checksums must match. Latest run: 23 tables,
   876 rows, `COUNTS_MATCH`, `CHECKSUMS_MATCH`.
2. **Restore drill:** dump the snapshot and restore it into a fresh database (`restore_check`).
   Counts and checksums must match.
3. **Upgrade check:** compare live row counts with the snapshot after deploying. Result for each
   Phase 2 and 3 schema change: `NO_ROWS_LOST_IN_UPGRADE`.

**Proposals (each needs approval):**
- **(a)** Upgrade to Railway Pro and enable daily backups with 7-day retention.
- **(b)** A scheduled `pg_dump` job in the production project writing to an encrypted, off-site
  bucket: 7 daily and 4 weekly copies, with a monthly restore drill into a scratch database.

Either way, take a manual snapshot (step 1) before every production schema change.

## 6. Safe rollback

- **API.** Redeploy the previous successful Railway deployment.
  - Every schema change in Phases 1–3 is additive: new tables, new nullable columns or columns
    with defaults.
  - So the previous release runs unchanged on the new schema.
  - Never use `db push --accept-data-loss` in production.
- **Web.** In Netlify, "Publish deploy" on the previous deploy (today `6aae7266`). This is instant.
- **Data.** Restore a snapshot into a **new** database and point `DATABASE_URL` at it only with
  approval. Never restore over the live database.
- **Release order (proposed):**
  1. Snapshot.
  2. Set environment variables: `CORS_ORIGINS`, `CHECKPOINT_DISABLE=1`; leave
     `ECO_ACTIVATION_REQUIRED` and `ECO_EARLY_ADOPTER_ENABLED` unset.
  3. Deploy the API.
  4. Smoke-test: health, store continuity, checkout refusal.
  5. Publish the web.
  6. Smoke-test the web.
- **Roll back on:** a failed health check, any 5xx in the smoke tests, a failed sign-in for a
  known owner, or any CORS grant to an unlisted origin.

## 7. Secrets: GitGuardian findings and allowlist review

- **`.gitleaksignore`:** 9 reviewed fingerprints, each an exact `commit:file:rule:line`.
  - 1 from Phase 1, 4 from Phase 2, 4 from Phase 3.
  - All are synthetic fixtures in `tests/e2e`: test passwords, one test-only MFA key, one CI
    database password.
  - A new secret anywhere still fails the full-history scan.
- **GitGuardian dashboard incidents:** 38349786, 38349787, 38349788, 37913911 (eCommerceOS) and
  38349783, 38349784 (Portal) are the same fixtures. The founder marks them as "Test credential".
- **Real exposure:** the Portal's former hard-coded owner default. It is refused by hash at
  sign-in and at password change.

## 8. Public repository exposure

The repository is public (founder's decision, 2026-10-18), with GitHub secret scanning and push
protection enabled. Staging URLs and identifiers are kept out of the docs; the one exception is a
unit-test fixture origin. The staging API answers only synthetic data, and its internal routes
need staging-only tokens.

**Decision needed:** keep the repository public, or make it private before launch.
