# eCommerceOS Phase 3: commercial release hardening

Branch `dev/phase3-release-hardening`, stacked on `dev/phase2-commercial` (PR #4), which stacks
on PRs #3, #2 and #1. It is not for merging until PRs #1–#4 are reviewed and merged in order.
Production is unchanged.

## Commits

| Commit | Change |
|---|---|
| `0736eba` | **A.** Offline-assisted checkout (bank transfer to the merchant, pay on delivery), with the Phase 3 schema |
| `0860dbe` | **C, B, F.** MFA-only operator console, invitations, role admin, session expiry and revocation, two-person reversal, audit view; draft invoices and receipts; payouts disabled; DigiPedia unavailability message |
| `f61ef21` | Web: customer checkout and order pages, merchant payment actions and settings, MFA console, approvals, operators, audit |
| `9d821f2` | Secret scan: Phase 3 test fixtures recorded by exact fingerprint |
| `7f1c4d6` | Web fix: a `?store=` store stays chosen while browsing (found in the staging walkthrough) |
| `44f828b` | Web fix: the open order stays in view after an action (found in the staging walkthrough) |
| `8055c23` | Web: draft documents in their own column |

## A. Offline-assisted checkout

**Payment.** Customers pay the merchant directly. No escrow; no customer money passes through
Digiconomy. The former in-process payment stub is not used: `escrowPaymentId` and `paidAt` stay
empty for offline orders.

**State transitions.** Each is a conditional write inside a transaction, with an order event and
an audit row.

| From | Action | Who | To |
|---|---|---|---|
| bank_transfer: order `PENDING_PAYMENT`, payment `awaiting_transfer` | Customer reports the transfer | the order's customer | payment `customer_reported`; order **unchanged, not paid** |
| `customer_reported` | Verify (amount must equal total) | owner or admin | order `CONFIRMED`, payment `verified` |
| `customer_reported` | Reject with reason | owner or admin | payment `rejected`; the customer can report again |
| pay_on_delivery | Order placed | customer | order `CONFIRMED`, payment `due_on_delivery` |
| `CONFIRMED` | Dispatch | any store staff | `IN_TRANSIT` |
| `CONFIRMED`/`IN_TRANSIT` | Deliver (cash amount must equal total for pay on delivery) | owner or admin | `DELIVERED`, payment `collected`; stock consumed |
| `DELIVERED` | Complete | owner or admin | `COMPLETED` |
| `CONFIRMED`/`IN_TRANSIT` | Cancel: pay on delivery | owner or admin | `CANCELLED`, payment `void`; stock released |
| `CONFIRMED`/`IN_TRANSIT` | Cancel: verified transfer, needs a refund reference | **owner only** | `CANCELLED`, payment `refunded_offline` |
| `PENDING_PAYMENT` | Window expires (48 h for transfers) | system | `CANCELLED`, payment `void`. **Never** while a customer report is pending |

**Idempotency and concurrency:**
- The same report again is a no-op; a different reference under review is refused.
- Under concurrent verification, deliveries and cancellations, exactly one action succeeds.

**Authorization:**
- Owners change payment settings; admins can read them.
- Bank details are shown only on the customer's own order, until it is paid. The audit keeps
  only the last four digits of the account.

## B. Commercial activation

- Unchanged: the NGN 30,000 standard fee, 5% commission on verified activations, exactly-once
  verification and reversal, and the early-adopter price (off).
- Existing stores keep operating; no new charge is applied to them.
- **Drafts:** an invoice on submission and a receipt on verification, with the transaction
  reference. Tax fields are `unreviewed`, with empty rate and amount. They are voided on
  rejection or reversal.
- Commission records carry `payoutStatus: "disabled"`; no payout path exists.

## C. Operator console hardening

- **Two-step verification.** Every console session uses TOTP (authenticator apps).
  - A password alone yields a short-lived, MFA-only token.
  - Secrets are encrypted at rest; each code is single use.
  - Five wrong codes end the challenge.
  - Without `ECO_OPERATOR_MFA_KEY`, sign-in is refused.
- **Bootstrap token.** It creates only the first admin, then refuses (`bootstrap_closed`). It is
  not a standing way in.
- **Onboarding.** Operators join only by an admin's single-use, 72-hour invitation, then enrol
  two-step verification.
- **Roles.** Verifiers review payments. Admins also manage partners and operators, approve, and
  read the audit log. Nobody changes their own role, status or MFA.
- **Sessions.** They expire after 8 hours absolute or 30 minutes idle. They are revoked on role
  change, suspension or MFA reset. Operators can sign out other devices.
- **Two-person rule.** One admin requests a reversal; a different admin approves it. Only then
  does it run, once, and the audit records both admins.
- **Audit.** Privileged actions are recorded and shown to admins.

## D. Production infrastructure

See [PRODUCTION-AUDIT.md](PRODUCTION-AUDIT.md). Read-only findings:
1. The live API **reflects any CORS origin**, with credentials allowed.
2. `main` has no branch protection.
3. Railway and Netlify auto-deploy from `main` without waiting for CI.
4. There are no production backups.

Each finding has an exact proposal waiting for approval.

## E. Historical fake-paid orders

Unchanged: the read-only inventory and its approval request are in
[../phase2/FAKE-PAID-INVENTORY.md](../phase2/FAKE-PAID-INVENTORY.md). The production query was
not run, and no historical order or payment record was modified.

## F. User experience

- DigiPedia being unconfigured or unreachable now shows "DigiPedia is not available for this
  store yet" or "temporarily unavailable" as a calm notice. Unexpected errors are still hidden
  behind "Internal server error".
- Verified in the browser at phone and desktop widths:
  - customer checkout;
  - merchant payment verification;
  - pay on delivery;
  - order cancellation;
  - product and stock editing;
  - branding;
  - platform operator workflows.

## G. Portal coordination

Contract v2: [../phase2/PORTAL-INTEGRATION-CONTRACT.md](../phase2/PORTAL-INTEGRATION-CONTRACT.md).

It goes to `finprov-c0` only after that session proves it controls the LifeOS Portal repository,
by reporting the recorded branch heads `a3e0129` and `25cb161`. On 2026-10-19 the session was no
longer running, so nothing was exchanged.

## Test evidence

| Suite | Result |
|---|---|
| e2e on SQLite and on PostgreSQL 18 at `f61ef21` (11 files; later commits are web or allowlist only) | **80/80** and **80/80** |
| New suites | `offline-checkout` (6), `platform-console` (8, including the RFC 6238 test vector), DigiPedia unavailability (2) |
| Updated | `commercial-activation` (13; MFA operators, two-person reversal) |
| Typecheck, web build, isolation check, full-history secret scan | pass |
| Staging acceptance (API, synthetic data) | **53/53**. An earlier run on the same build passed 54/54; that one included the one-time invitation of the second admin |
| Staging owner recovery | **12/12** |
| Staging browser walkthrough (phone 390 px and desktop) | **25/25**, 16 screenshots; no request reached a production host |
| Staging isolation gate | **19/19** before and after deploy |
| Staging schema upgrade | Snapshot of 23 tables and 876 rows; `NO_ROWS_LOST_IN_UPGRADE` |

**Staging deployment:** API `9d821f2` (Railway deployment `6956fd14`); web `8055c23` (Netlify
deploy `6ad613d9`). The API code is identical across those commits.

## Remaining production blockers

1. Review and merge PRs #1 → #2 → #3 → #4 → this branch, in order. After PR #2: branch
   protection and required checks.
2. Approve the production `CORS_ORIGINS` value (the live API reflects any origin).
3. Enable Railway "Wait for CI" and lock Netlify auto-publishing.
4. Set up production backups (Railway Pro or a scheduled dump job) and take a pre-release snapshot.
5. Production secrets for Phase 3: `ECO_OPERATOR_MFA_KEY`, and `ECO_PLATFORM_ADMIN_TOKEN` only
   for the first admin, unset afterwards.
6. Approve and run the fake-paid inventory read, then the reconciliation decisions.
7. Business inputs: early-adopter eligibility; whether existing stores pay; a VAT and tax review
   for the drafts; a partner payout process; the bank-details review process for merchants.
8. Mark the GitGuardian incidents as test credentials, and decide repository visibility.
9. Joint Portal integration authorization, after verifying `finprov-c0`.

## Recommended release candidate

The head of `dev/phase3-release-hardening`, once CI is green, as the single candidate containing
PRs #1–#4. Release it only after the approvals above, in the release order in
[PRODUCTION-AUDIT.md](PRODUCTION-AUDIT.md) section 6.

**Staging: GO. Production: NO-GO** until the blockers are resolved and each production action
is approved.
