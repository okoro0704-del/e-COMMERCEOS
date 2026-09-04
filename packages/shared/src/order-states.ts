/**
 * Order state machine for physical retail checkout + LogisticsOS dispatch.
 *
 * PENDING_PAYMENT ──► PAID_ESCROW ──► DISPATCH_PENDING ──► IN_TRANSIT ──► DELIVERED ──► COMPLETED
 *         │                │                  │                 │
 *         └────────────────┴──────────────────┴─────────────────┴────────► CANCELLED
 */

export const ORDER_STATUSES = [
  "PENDING_PAYMENT",
  "PAID_ESCROW",
  "DISPATCH_PENDING",
  "IN_TRANSIT",
  "DELIVERED",
  "COMPLETED",
  "CANCELLED",
] as const;

export type OrderStatus = (typeof ORDER_STATUSES)[number];

export const LOGISTICS_STATUSES = ["PICKED_UP", "IN_TRANSIT", "DELIVERED"] as const;
export type LogisticsStatus = (typeof LOGISTICS_STATUSES)[number];

export const ORDER_TRANSITIONS: Record<OrderStatus, readonly OrderStatus[]> = {
  PENDING_PAYMENT: ["PAID_ESCROW", "CANCELLED"],
  PAID_ESCROW: ["DISPATCH_PENDING", "CANCELLED"],
  DISPATCH_PENDING: ["IN_TRANSIT", "DELIVERED", "CANCELLED"],
  IN_TRANSIT: ["DELIVERED", "CANCELLED"],
  DELIVERED: ["COMPLETED"],
  COMPLETED: [],
  CANCELLED: [],
};

export function canTransition(from: OrderStatus, to: OrderStatus): boolean {
  return ORDER_TRANSITIONS[from].includes(to);
}

/** Map LogisticsOS webhook status onto the ECommerceOS order machine. */
export function orderStatusFromLogistics(status: LogisticsStatus): OrderStatus {
  if (status === "PICKED_UP" || status === "IN_TRANSIT") return "IN_TRANSIT";
  return "DELIVERED";
}

export function assertTransition(from: OrderStatus, to: OrderStatus): void {
  if (!canTransition(from, to)) {
    throw Object.assign(new Error(`Illegal order transition ${from} → ${to}`), {
      statusCode: 409,
      code: "illegal_transition",
    });
  }
}
