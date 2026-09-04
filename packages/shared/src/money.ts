/** Money helpers — amounts are integer minor units (kobo / cents). */

export type SettlementSplit = {
  merchandiseMinor: number;
  deliveryFeeMinor: number;
  platformCommissionMinor: number;
  merchantShareMinor: number;
  riderFeeMinor: number;
  totalMinor: number;
};

export function splitSettlement(opts: {
  merchandiseMinor: number;
  deliveryFeeMinor: number;
  platformCommissionBps: number;
}): SettlementSplit {
  const platformCommissionMinor = Math.round(
    (opts.merchandiseMinor * opts.platformCommissionBps) / 10_000,
  );
  const merchantShareMinor = opts.merchandiseMinor - platformCommissionMinor;
  const riderFeeMinor = opts.deliveryFeeMinor;
  const totalMinor = opts.merchandiseMinor + opts.deliveryFeeMinor;
  return {
    merchandiseMinor: opts.merchandiseMinor,
    deliveryFeeMinor: opts.deliveryFeeMinor,
    platformCommissionMinor,
    merchantShareMinor,
    riderFeeMinor,
    totalMinor,
  };
}

export function availableInventory(inventoryCount: number, reservedCount: number): number {
  return Math.max(0, inventoryCount - reservedCount);
}
