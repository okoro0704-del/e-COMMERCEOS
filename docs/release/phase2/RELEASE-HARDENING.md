# Release hardening: fixes and resolutions awaiting approval

Nothing in this file has been applied to production. Code fixes live on `dev/phase2-commercial`.
Production settings are written as exact proposals for the founder to approve one by one.

## 1. Wildcard production CORS: fixed in code (`7d46947`, `8b8c7ab`)

Before:
- The API granted credentialed CORS to any `*.netlify.app` site (anyone can publish there), any
  `*.getlifeos.app` and `*.lifeos.app` subdomain, and localhost, whatever `CORS_ORIGINS` said.
- It also honoured `*` in production.

After:
- Only `CORS_ORIGINS` applies. Entries are exact origins, or `https://*.<domain>` for per-store
  subdomains of a domain Digiconomy controls.
- In production, `*`, `http:`, localhost and wildcards on shared hosting suffixes
  (`netlify.app`, `vercel.app`, `up.railway.app`, …) **refuse to boot**.
- A second defect turned up in the staging browser test and is fixed. The API allowed only
  GET, HEAD and POST cross-origin, so browsers blocked every PATCH, PUT and DELETE. That broke
  cart quantity changes and removal, catalogue edits, marketplace seller status and DigiPedia
  saves. Production is affected today, because the web and API run on different origins.

**Proposed production value** (approve before deploying this branch):

```
CORS_ORIGINS=https://e-commerce.getlifeos.app,https://e-commerceos.netlify.app
```

Add `https://*.getlifeos.app` only if per-store subdomains are actually served by the production
web site. Today the site has one custom domain and no aliases. Portal calls are server-to-server
and need no CORS.

**Deploy order:**
1. Set the variable with `--skip-deploys`.
2. Deploy.

If the value is wrong, the new deployment fails its health check and Railway keeps the previous
deployment serving.

## 2. Netlify production configuration

Current state (read-only checks, 2026-10-18 and 2026-10-19):
- Deploy Previews are off (`skip_prs: true`).
- The production deploy `6aae72662dde6d000853209f` is unchanged.
- `netlify.toml` pins Deploy Previews and branch deploys to `https://ecommerceos-api.preview.invalid`.

Proposals:
1. Keep Deploy Previews off.
2. Set **Branch deploys: none** in the UI, if not already.
3. Scope the UI variable `VITE_API_URL` to the **Production** context only.
4. Align `NODE_VERSION` (20 in `netlify.toml`) with the API's Node 22 in a later change.

## 3. Production deployment without a CI gate

CI (`.github/workflows/ci.yml`, PR #2 and #3) runs five jobs on every pull request:
- SQLite e2e,
- PostgreSQL e2e,
- environment isolation,
- full-history gitleaks,
- actions pinned by SHA.

Proposals (settings changes; each needs approval):
1. GitHub branch protection on `main`: require the five CI checks and one review, and block
   force-push.
2. Railway `ecommerceos-api` GitHub trigger: enable **Wait for CI**.
3. Railway reads `railway.toml` start commands only for Git deploys. Keep the service-level start
   and build commands set explicitly. Config-as-code is deprecated by Railway on 2026-12-01.

## 4. Production backup and recovery

- Railway native backups need a Pro workspace; this workspace is not Pro.
- Staging evidence for the alternative: a `pg_dump`/`pg_restore` job in the staging project.
  - It snapshotted the database (18 tables, 113 rows) and restored it into a fresh database with
    matching counts and checksums.
  - After the Phase 2 upgrade it confirmed `NO_ROWS_LOST_IN_UPGRADE`.

Options (each needs approval):
- **(a)** Upgrade to Railway Pro and enable daily backups with 7-day retention.
- **(b)** A scheduled `pg_dump` job in the production project writing to an encrypted, off-site
  bucket, keeping 7 daily and 4 weekly copies, with a monthly restore drill into a scratch
  database.

Either way, take a manual snapshot before every production schema change.

## 5. GitGuardian incidents

| Incident | Where | Finding |
|---|---|---|
| 38349787 | e-COMMERCEOS PR #1 (`3c9e258`), test files | Synthetic test password used across e2e files |
| 38349788 | `tests/e2e/merchant-auth.test.ts` | Synthetic "leaked" password used to test the deny list |
| 38349786 | `tests/e2e/online-marketplace.test.ts` | Synthetic operator password |
| 37913911 | `.github/workflows/ci.yml` (PR #2) | Password of CI's throwaway local PostgreSQL |
| 38349783, 38349784 | LifeOS-Portal PR #4 tests | Synthetic test passwords (Portal track) |

- All are fixtures that guard no system. The fingerprints are recorded without values in the
  release evidence.
- **Resolution:** the founder marks each as "Test credential" in GitGuardian.
- The one real exposure, Portal's former hard-coded store-owner default, is refused at sign-in
  and at password change by its SHA-256 hash. Owners recover through the Portal handoff.

## 6. Repository exposure and secret handling

- The repository is public, by the founder's decision on 2026-10-18.
- CI runs gitleaks over the full history. The only allowlisted fingerprint is the synthetic
  merchant-auth fixture.
- No production secret is in the repository, and `.env.example` holds development placeholders
  only.

Proposals:
1. Enable GitHub secret scanning with push protection.
2. Decide whether to make the repository private before production launch.
3. Keep staging secrets in the staging project only; they are generated fresh and never derived
   from production.

## 7. Portal ownership handoff

- `finprov-86` remains the LifeOS Portal release owner. This track does not modify Portal.
- The interface Portal uses is in [PORTAL-INTEGRATION-CONTRACT.md](PORTAL-INTEGRATION-CONTRACT.md).
- Fixes since the rehearsal that Portal benefits from:
  - The reset grant survives a refused password (`23d509e`).
  - A failed provisioning leaves nothing, and a retry succeeds (`aaf9b24`).
  - Portal can poll a new status endpoint.

## 8. Other production settings proposed

- `CHECKPOINT_DISABLE=1` turns off Prisma's boot-time telemetry call to `checkpoint.prisma.io`,
  seen in the rehearsal network capture. It is set on staging.
- Keep `ECO_ACTIVATION_REQUIRED` unset (off) until the founder approves charging new stores.
- Keep `ECO_EARLY_ADOPTER_ENABLED` unset until its eligibility, amount and currency are confirmed.
- `ECO_PLATFORM_ADMIN_TOKEN`: set only when the first operators are created. It must be 32+
  characters and distinct from the Portal token. Unset it again afterwards.
