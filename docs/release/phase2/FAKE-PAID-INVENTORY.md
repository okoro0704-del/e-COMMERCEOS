# Fake-paid order inventory: approval request and reconciliation policy

Status: **prepared and validated on staging. Not run against production.** Running it in
production needs the founder's approval of the specific request in section 3.

## 1. What happened

Before commit `41dec82`, checkout called an in-process FundzMan stand-in whenever
`PRIMITIVES_MODE=local`. That is how production runs: the API warns about it at boot. The
stand-in answered `escrow_held` with payment ids `local_pay_<n>`, and the order became
`PAID_ESCROW` (`paidAt` set). From there it could be dispatched and delivered. **No money moved for
any of these orders.**

Since `41dec82`, checkout refuses with `503 payments_unavailable`. The merchant console shows these
orders as "Not paid (test payment)" (`paymentStatus: simulated_not_paid`).

## 2. The query

File: [`fake-paid-orders-inventory.sql`](fake-paid-orders-inventory.sql).
SHA-256 of the LF-normalised file: `974687810ae9b93f2c7889bd397ceacfc2a872bef14adb3d81cd5c4f63b74fd5`.

| Query | Returns |
|---|---|
| Q1 | Every order that is or was presented as paid, grouped by evidence (`local_stub`, `no_payment_id`, `other_payment_id`), status and currency. For each group: order count, store count, total amount, dispatch requested, first and last paid date. |
| Q2 | A cross-check from the order history: `fundzman.pay` events that carry a `local_pay_` id. |
| Q3 | Stub-paid orders by month, and how far each got (in fulfilment, delivered, cancelled). |

Safeguards built into the file:
- It runs inside `BEGIN TRANSACTION READ ONLY`, which PostgreSQL enforces.
- `statement_timeout` is 30 s.
- It returns **aggregates only**. No buyer names, phones, emails, addresses, payment ids, order
  numbers or store identities leave the database.

### Staging validation (2026-10-19, staging project `ecommerceos-staging`)

The query ran through the staging `pg-backup-job` under a role holding only `SELECT` on `Order`
and `OrderEvent`:

```
reader_grants: Order:SELECT,OrderEvent:SELECT
reader_denied_other_tables=yes        (SELECT on StaffMember refused)
read_only_refuses_writes=yes          (even the owner account cannot UPDATE inside the READ ONLY transaction)
Q1|local_stub|DISPATCH_PENDING|NGN|1|1|1850000|1|2026-10-18|2026-10-18
Q2|1|1|2026-10-18|2026-10-18
Q3|2026-10|1|1|0|0
```

The single row is the synthetic order the baseline rehearsal (f06227c) paid through the stand-in,
so the query finds exactly what it should.

## 3. Production read: request for approval

| Item | Proposal |
|---|---|
| Target | The PostgreSQL database behind `DATABASE_URL` of service `ecommerceos-api`, Railway project **ECommerceOS** (`f11e86f6-39ef-4f72-ae3f-b5332cfe3c1e`), environment **production**. Nothing else. |
| Scope | Exactly the file above, verified by its SHA-256 before running: tables `Order` and `OrderEvent`, read only, aggregates only. No other statement. |
| Option A (recommended: no production change) | The founder runs the file in the Railway dashboard SQL console for that database and pastes the three result tables back. Privilege: the console's database owner, constrained by the READ ONLY transaction, the timeout and the aggregate-only text. |
| Option B (stricter privilege, small production change) | Create a temporary `NOLOGIN` role `eco_inventory_reader` with `USAGE` on `public` and `SELECT` on `"Order"` and `"OrderEvent"` only. Run the file with `SET ROLE eco_inventory_reader`, then `DROP ROLE`. This is DDL on production, so it needs its own approval. It was validated on staging. |
| Credentials | None are copied or printed; the console uses its own session. No production secret is read by Claude. |
| Privacy | Aggregate counts and amounts only. If per-store follow-up is needed later, that is a separate request. |
| Output handling | Results are recorded in the release notes only. No raw rows are exported. |
| Not done | No payment state changes, no order deletions, no refunds, no fulfilment changes. |

**Approval needed:** "Approve Option A (or B) for `fake-paid-orders-inventory.sql`, SHA-256
`974687…74fd5`, against ECommerceOS production `DATABASE_URL`."

## 4. Proposed reconciliation policy (for decision; nothing is executed)

Principles:
- These orders were **never paid**, so there is nothing to refund unless a buyer paid the merchant
  some other way. The merchant confirms that per order.
- Every write needs a per-batch approval and a database snapshot taken first.
- Each change is a conditional update from the observed status, so a re-run changes nothing.
- Each change records the previous status in an `OrderEvent` (`source: reconciliation`) and an
  audit row. Two people review each batch.
- Buyer contact goes through the merchant of record. Digiconomy does not export buyer data.

| Status found (evidence `local_stub`) | Proposed action |
|---|---|
| `PAID_ESCROW` (not dispatched) | Tell the merchant. After approval, cancel with reason `reconciled: simulated payment` and release reserved stock. |
| `DISPATCH_PENDING`, `IN_TRANSIT` | Ask the merchant to hold or recall fulfilment. With `LOGISTICS_MODE=local`, no real courier job was sent. Then the merchant chooses: collect payment through an approved channel, or cancel. |
| `DELIVERED`, `COMPLETED` | Goods may have left without payment. The merchant decides whether to pursue payment from the buyer. No automatic change; record the merchant's decision. |
| `CANCELLED` with `paidAt` set | No action. Report only. |
| `no_payment_id` or `other_payment_id` | Investigate first. For `other_payment_id`, check with the payment provider before any decision. |

Owner reporting: the aggregate counts go to the founder. Per-merchant notices need the separate
per-store request.
