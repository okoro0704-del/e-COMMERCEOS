-- eCommerceOS: orders the pre-containment checkout may have marked paid without moving money.
--
-- Before commit 41dec82, checkout called an in-process FundzMan stand-in whenever
-- PRIMITIVES_MODE=local. It reported "escrow_held" with payment ids "local_pay_<n>", and the
-- order became PAID_ESCROW (paidAt set) and could then be dispatched and delivered.
--
-- Safety:
-- * Read only: everything runs inside a READ ONLY transaction, which PostgreSQL enforces.
-- * Least privilege: intended for a role holding only SELECT on "Order" and "OrderEvent".
-- * Privacy: aggregates only. No buyer names, phones, emails, addresses, payment ids or order
--   numbers are returned. Store identities are not returned either (counts of stores only).
-- * Bounded: a statement timeout stops a slow query instead of loading the database.
-- Run with: psql "$URL" -X -v ON_ERROR_STOP=1 -f fake-paid-orders-inventory.sql

BEGIN TRANSACTION READ ONLY;
SET LOCAL statement_timeout = '30s';

-- Q1. Every order that is, or was, presented as paid, by payment evidence, status and currency.
--   evidence = local_stub        payment id from the in-process stand-in: no money moved
--              no_payment_id     marked paid with no payment id at all
--              other_payment_id  a payment id from somewhere else: verify with the provider
WITH paid AS (
  SELECT o."tenantId", o.status, o.currency, o."totalMinor", o."paidAt", o."logisticsJobId",
         CASE
           WHEN o."escrowPaymentId" LIKE 'local\_pay\_%' THEN 'local_stub'
           WHEN o."escrowPaymentId" IS NULL THEN 'no_payment_id'
           ELSE 'other_payment_id'
         END AS evidence
  FROM public."Order" o
  WHERE o."paidAt" IS NOT NULL
     OR o."escrowPaymentId" IS NOT NULL
     OR o.status IN ('PAID_ESCROW', 'DISPATCH_PENDING', 'IN_TRANSIT', 'DELIVERED', 'COMPLETED')
)
SELECT 'Q1' AS q, evidence, status, currency,
       count(*) AS orders,
       count(DISTINCT "tenantId") AS stores,
       sum("totalMinor") AS total_minor,
       count("logisticsJobId") AS dispatch_requested,
       min("paidAt")::date AS first_paid,
       max("paidAt")::date AS last_paid
FROM paid
GROUP BY evidence, status, currency
ORDER BY evidence, status, currency;

-- Q2. Cross-check from the order history: payment events written by the stand-in.
SELECT 'Q2' AS q,
       count(*) AS stub_payment_events,
       count(DISTINCT e."orderId") AS orders_with_stub_event,
       min(e."createdAt")::date AS first_event,
       max(e."createdAt")::date AS last_event
FROM public."OrderEvent" e
WHERE e.source = 'fundzman.pay'
  AND e.payload::jsonb ->> 'paymentId' LIKE 'local\_pay\_%';

-- Q3. Stub-paid orders by month and how far they progressed (fulfilment exposure).
SELECT 'Q3' AS q,
       to_char(date_trunc('month', o."paidAt"), 'YYYY-MM') AS month,
       count(*) AS orders,
       count(*) FILTER (WHERE o.status IN ('DISPATCH_PENDING', 'IN_TRANSIT')) AS in_fulfilment,
       count(*) FILTER (WHERE o.status IN ('DELIVERED', 'COMPLETED')) AS delivered,
       count(*) FILTER (WHERE o.status = 'CANCELLED') AS cancelled
FROM public."Order" o
WHERE o."escrowPaymentId" LIKE 'local\_pay\_%'
GROUP BY 1, 2
ORDER BY 2;

COMMIT;
