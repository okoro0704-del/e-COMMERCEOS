# LifeOS Portal ↔ eCommerceOS: storefront provisioning contract (proposal v1)

Status: **proposal for joint review** by the eCommerceOS track and the LifeOS Portal release
owner. LifeOS Portal is not modified by this work. Neither side connects to the other's staging
until a specific joint integration authorization is given.

Each item is marked **[built]** (on branch `dev/phase2-commercial`, tested) or **[proposed]**.

## 1. Identifiers

| Identifier | Owner | Meaning | Stability |
|---|---|---|---|
| `tenantId` (request) / `distributorTenantId` | Portal | Portal's install or business-app id for this storefront | Stable; stored as `settings.distributorTenantId` |
| `owner.subject` | Portal (TrustID) | The Portal identity that owns the store | Stable; bound once to the store's owner account |
| `trustId.businessPublicId` | Portal | The business (one business may have several stores) | Stable; stored as `Tenant.lifeosBusinessId` |
| `subdomain` | Portal proposes, eCommerceOS confirms | The store handle (`a-z0-9-`) | Immutable after creation |
| `tenantId` (response) | eCommerceOS | eCommerceOS's own store id | Stable; use in all later calls |

Store names, colours and logos are branding the merchant can change. They are never identifiers.

## 2. Service authentication

- **[built]** `Authorization: Bearer <INTERNAL_PROVISION_TOKEN>`, compared in constant time.
  - In production the token must be set and must not be a known development value, or the API
    refuses to boot.
  - Today this one token guards provisioning, admin handoff, status, the unpaid-order sweep and
    the logistics webhook.
- **[built]** Platform-operator creation uses a separate `ECO_PLATFORM_ADMIN_TOKEN` that Portal
  never holds. Production refuses it if it equals the Portal token.
- **[proposed]** Scoped credentials per caller:
  - `ECO_PORTAL_TOKEN`, scopes `provision`, `handoff`, `store-status`;
  - a jobs token, scope `jobs`;
  - an HMAC-signed logistics webhook.
  - Each is rotatable with a two-token overlap window. Requests carry `x-request-id`, which
    eCommerceOS echoes and logs.

## 3. Create a storefront: `POST /internal/distributor/provision` [built]

The request names `subdomain`, `displayName` and `tenantId`, and optionally `owner.subject`,
`adminStaff.email`, `trustId.businessPublicId`, `brand`, `verticalId` and `seed`.

**Idempotency.** The key is `(subdomain, owner.subject)`.

| Outcome | HTTP | Portal should |
|---|---|---|
| Created | `201` + `{ ok, tenantId, storefrontUrl, adminConsoleUrl, staffId, slug, credentialSetup, launchUrls }` | Store `tenantId`. With `owner.subject` and no password, `credentialSetup` is `portal_handoff`. |
| Same owner repeats the request | `200` + the same body with `replayed: true` | Treat it as success (safe to retry). |
| Handle taken by anyone else | `409 conflict` | Do not retry. Offer another handle. |
| Invalid body | `400 validation_error` | Fix the request. Do not retry. |
| Bad or missing token | `401` | Alert. Do not retry. |
| Unexpected failure | `500 provision_failed` + `requestId`, generic message | Retry the **same** request with backoff (1 s, 4 s, 16 s, then alert). |

**Rollback [built].** A failure after the store row is created deletes it, so nothing partial
remains and a retry starts clean. Internal error details stay in the eCommerceOS log under
`requestId`.

## 4. Provisioning and activation status: `GET /internal/ecommerceos/stores/:subdomain` [built]

```json
{ "tenantId": "…", "subdomain": "…", "status": "active", "provisioned": true, "ownerBound": true,
  "activation": { "required": true, "status": "pending|active|legacy", "storeOpen": false },
  "createdAt": "…" }
```

It returns `404` if no such store exists. Portal can poll it after a timeout or retry, and to
display setup status.

## 5. Ownership verification: `POST /internal/ecommerceos/admin-handoff` [built]

The request names `subdomain` and `ownerSubject`, and optionally `ownerEmail` and `tenantId`.

**Portal's duty.** It must verify that the signed-in Portal user owns this install before calling.

**eCommerceOS rules.**
- A store whose owner is already bound accepts only that `ownerSubject`. Anyone else gets
  `403 owner_mismatch`.
- A legacy store with no binding is claimed once, by an owner-email match. The claim is atomic:
  of concurrent claims, exactly one wins and the binding is never overwritten.
- Response: `201 { url: "<admin>#handoff=<code>", expiresInSec: 120 }`. The code travels in the
  URL fragment, so it stays out of logs and Referer headers.
- The code is single use. The browser exchanges it for a store session plus a 15-minute,
  single-use password reset grant.
- A refused new password does not spend the grant (fixed in `23d509e`). Replay, expiry, use by
  another account and concurrent use are all refused.

## 6. Activation and billing events

**[built] Model (eCommerceOS is the system of record for setup payments).**
- **Fees.**
  - Standard brand setup: NGN 30,000, one time.
  - Early-adopter price: configurable, **off** until eligibility, amount and currency are
    confirmed.
- **Payment.** The owner pays outside the platform and submits the transfer reference.
  Digiconomy platform staff verify it by hand. The amount received must match the fee.
- **Partner commission.** 5% of the verified setup payment, credited once. It is reversed with
  the activation. Customer orders earn no commission.
- **Safeguards.**
  - One payment reference activates one store.
  - A store has one open submission and one verified activation.
  - Concurrent reviews succeed once.
  - Every transition is audited.

**[proposed] Events to Portal.**
- **Delivery.** `POST {PORTAL_API_URL}/internal/ecommerceos/events`, signed with HMAC-SHA256 over
  the raw body using a dedicated secret (`x-eco-signature`, `x-eco-timestamp`; reject if more
  than 5 minutes skewed). Delivery is at least once; Portal deduplicates by `id`.
- **Event types:**
  - `store.provisioned`
  - `activation.submitted`, `activation.verified`, `activation.rejected`, `activation.reversed`
  - `partner_commission.accrued`, `partner_commission.reversed`
- **Payload:** `{ id, type, occurredAt, tenantId, subdomain, activation: { id, status, plan,
  amountMinor, currency }, partnerCode? }`. No payer names and no bank details.
- **Ordering.** Apply by `occurredAt`. When in doubt, re-read the status endpoint.
- **Until this exists:** Portal polls the status endpoint (section 4).

**Open decisions for both tracks.**
1. Does Portal show or collect the setup fee, or only link to the store's activation panel?
2. How do Portal's monthly plans ($9–$69 in the Portal catalogue) relate to the one-time setup fee?
3. Should a partner referral code pass through Portal at provisioning (`referral.partnerCode`)?

## 7. Error format and rollback semantics

- Errors are `{ error: <code>, message: <human text>, requestId? }`. Codes are stable; messages
  may change.
- Every write is conditional or idempotent, so retrying the same request is safe. The one
  exception is the `409` cases listed above.
- No call moves money. Paid customer checkout stays disabled in this build
  (`503 payments_unavailable`).
- **Deprovisioning [proposed]:** a soft `status: suspended` that Portal can request, with no
  data deletion. Not built.

## 8. Test plan for the joint authorization [proposed]

1. Provision with a new handle, then provision again with the same body: `201`, then `200 replayed`.
2. Provision the same handle under another owner: `409`.
3. Force a failure; confirm it leaves nothing and the retry gives `201`.
4. Handoff, set the password with one refused attempt first, then sign in.
5. Read the status endpoint before and after a staging activation verification.
6. All of this runs in the two staging environments only, with synthetic data.
