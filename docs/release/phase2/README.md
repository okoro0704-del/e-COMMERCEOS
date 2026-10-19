# eCommerceOS Phase 2: product completion and release hardening

Branch `dev/phase2-commercial`, stacked on PR #3 (`3c2e69d`, which is stacked on PRs #1 and #2).
It is not for merging until PRs #1–#3 are reviewed and merged in order.

## Commits

| Commit | Change |
|---|---|
| `23d509e` | Reset grant: refuse the new password before spending the one-time grant; a grant from another account is neither used nor burned. |
| `490a1c4` | Commercial model: NGN 30,000 setup, manual verification, 5% partner commission, reversal and duplicate safeguards, platform API. |
| `7d46947` | CORS: only configured origins; unsafe production values refuse to boot. |
| `85facdb` | Web: store activation panel, `/platform` console, product editing, closed storefront. |
| `8b8c7ab` | CORS: allow PATCH, PUT and DELETE (browser writes were blocked). |
| `727157f` | API: store branding, merchant cancellation of unpaid orders, conditional cancellation. |
| `62999a8` | Web: branding, order management and low stock. |
| `aaf9b24` | Provisioning rollback on failure, masked errors, status endpoint for Portal. |

## Feature matrix

| Area | Status | Notes |
|---|---|---|
| **1. Customer storefront (mobile)** | Functional | Catalogue, product, cart, order page, publications, marketplace discovery. Branded hero (colour, logo, tagline). "Opening soon" while a store awaits setup. No sideways scroll at 390 px. **Checkout takes no payment** (`503 payments_unavailable`): payment containment. |
| **2. Business-owner admin** | Functional | Sign-in, Portal handoff and password. Store activation (fee, manual payment submission, history). Branding. Add and edit products (title, visibility, price, stock with reason). Low stock. Orders (filter, detail, cancel unpaid). Publish media, DigiPedia, marketplace operator tools. |
| **3. Digiconomy platform admin** | Built (new) | `/platform`: operator sign-in with a tab-scoped session, overview, verification queue, activations, reversal (admins), partners, commissions, stores. Operators are created only with `ECO_PLATFORM_ADMIN_TOKEN`. |
| **4. Product, inventory, orders** | Functional, partly | Products and stock are editable. Orders: view and cancel unpaid only. Dispatch and delivery stay courier-driven and are unreachable while payments are disabled. |
| **5. Marketing-partner referrals** | Built (new) | Partner codes (create, suspend, reactivate). The owner enters a code at setup submission. 5% of the verified setup fee, credited once, reversed with the activation. Totals per partner. No payouts, no partner self-service. |
| **6. Merchant activation** | Built (new) | NGN 30,000 standard setup. Early-adopter price configurable and off. Manual verification with an amount match, reject and reverse. New stores stay closed until verified (when `ECO_ACTIVATION_REQUIRED=true`); existing stores are grandfathered. Not modelled: monthly subscriptions. |
| Mock or preview only | — | `VITE_DEMO_MODE` preview catalogue (off in builds). `PRIMITIVES_MODE=local` stand-ins for identity, messaging, storage, jobs and wallet. |

## Tests

| Suite | Result |
|---|---|
| e2e on SQLite at `aaf9b24` (9 files) | **64/64** |
| e2e on PostgreSQL 18 at `aaf9b24` (same files) | **64/64** |
| Typecheck (API, web) and web build | pass |
| Static environment-isolation check | pass |
| New reset-grant tests against the pre-fix code | 2 fail (defect reproduced); concurrency passes in both |
| New CORS-methods and provisioning-rollback tests against the pre-fix code | fail (defects reproduced) |

## Staging evidence (isolated project `ecommerceos-staging`)

- **Deployed:** API `aaf9b24` (Railway deployment `4d08fb89`); web `aaf9b24` (Netlify deploy
  `6ad568c1`). The staging URLs are in the release report, not in this public repository.
- **Isolation gate:** 18/18 before and after each deploy. The gate gained checks that the
  platform token is staging-only and distinct, the early-adopter price is off, and CORS is exactly
  the staging origin.
- **Schema upgrade:** snapshot taken first; `NO_ROWS_LOST_IN_UPGRADE`; 5 new tables; Prisma
  "already in sync".
- **Commercial acceptance:** 40/40.
- **Owner recovery after the fix:** 12/12. A refused password keeps the grant; replay is refused;
  5 concurrent uses produce exactly one winner.
- **Browser walkthrough:** 20/20, 18 screenshots at desktop and 390 px phone width. No request
  reached a production host.
- **Fake-paid inventory:** validated read-only under a least-privilege role (see
  [FAKE-PAID-INVENTORY.md](FAKE-PAID-INVENTORY.md)).

## Remaining commercial gaps

1. **No way to take a customer payment.** Online checkout is disabled by containment. Production
   needs either a verified payment provider integration or an approved offline flow (pay on
   delivery or transfer, confirmed by the merchant).
2. **Early-adopter offer:** eligibility, amount and currency need the founder's confirmation.
3. **Setup payment:** bank details or instructions need approval (`ECO_SETUP_PAYMENT_INSTRUCTIONS`).
   No receipts, invoices or VAT treatment for the setup fee.
4. **Partners:** commission payouts, partner sign-in and statements are not built (records only).
5. **Verification controls:** a single verifier can verify; there is no four-eyes rule and no
   operator MFA. Operators are managed through the bootstrap token only.
6. **Plans:** the relation to Portal's monthly plans is undecided (see the contract's open decisions).
7. **Grandfathered stores:** whether existing stores pay is a policy decision.
8. **Portal integration:** not connected; needs the joint authorization
   ([PORTAL-INTEGRATION-CONTRACT.md](PORTAL-INTEGRATION-CONTRACT.md)).
9. **DigiPedia in isolated staging:** shows "Internal server error" because its upstream is
   pinned to `.invalid`. It should degrade to "unavailable".

## Security blockers before production

See [RELEASE-HARDENING.md](RELEASE-HARDENING.md):
1. Review and merge PRs #1–#3, then this branch, in order.
2. Set the production `CORS_ORIGINS` before deploying.
3. Add the CI gate (branch protection plus Railway "Wait for CI").
4. Set up production backups.
5. Run the approved fake-paid inventory read and decide on reconciliation.
6. Resolve the GitGuardian incidents.
7. Decide on repository visibility.
8. Add scoped service tokens and operator MFA.

## Estimate to a production release candidate

About **2–3 weeks**, assuming the founder's decisions arrive promptly and the offline payment
route is chosen:

| Work | Estimate |
|---|---|
| Founder approvals and decisions | elapsed time |
| Merge sequence, CI gate, backups, CORS and environment | 2–3 days |
| Inventory read and reconciliation | 1–2 days |
| Offline order payment flow | 3–5 days |
| Operator MFA, four-eyes, scoped tokens | 2–3 days |
| Joint Portal integration and test | 3–5 days |

A payment provider integration instead of the offline flow adds 2+ weeks.

## GO / NO-GO

- **Staging: GO** for `aaf9b24` as the Phase 2 staging candidate. It is isolated, tested, and
  every Phase 2 workflow passes.
- **Production: NO-GO.** See the security blockers and commercial gap 1 above.
