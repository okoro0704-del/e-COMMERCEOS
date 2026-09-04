# ECommerceOS

Physical retail and e-commerce engine for LifeOS Business. Manages products, inventory, carts, and order processing. Consumes all 6 Phase F primitives (`@lifeos/shared`) and dispatches paid physical orders to LogisticsOS / TransportationOS.

## Workspace

| Path | Package |
|------|---------|
| `apps/ecommerceos-api` | `@ecommerceos/api` Fastify service |
| `packages/lifeos-shared` | `@lifeos/shared` Phase F primitive contracts |
| `packages/shared` | `@ecommerceos/shared` manifest, order state machine |

## Primitives

| Primitive | Binding |
|-----------|---------|
| Trust ID | Merchant admin sessions + buyer checkout guard |
| FundzMan | `POST /v1/checkout/pay` holds escrow; delivery releases merchant / rider / platform splits |
| Sovereign Drive | Product photos and invoice PDFs |
| ElfCom | Chat/SMS order status updates |
| Platform Jobs | Cancel unpaid orders after 30 minutes and release reserved inventory |
| Master Distributor | Subdomain routing (`{subdomain}.lifeos.app`) |

## Order state machine

`PENDING_PAYMENT` → `PAID_ESCROW` → `DISPATCH_PENDING` → `IN_TRANSIT` → `DELIVERED` → `COMPLETED` / `CANCELLED`

Paid orders call `POST /internal/logistics/dispatch`. LogisticsOS posts status to `POST /internal/ecommerce/webhooks/logistics-update`.

## Setup

```bash
cp .env.example .env
npm run setup
npm run dev:api
```

Portal provision:

```http
POST /internal/distributor/provision
Authorization: Bearer $INTERNAL_PROVISION_TOKEN
```

Returns `tenantId`, `storefrontUrl`, and `adminConsoleUrl`.

## Tests

```bash
npm run test:e2e
```
