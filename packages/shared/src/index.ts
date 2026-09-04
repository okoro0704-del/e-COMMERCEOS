export {
  ECOMMERCEOS_MANIFEST,
  ECOMMERCEOS_DEFAULT_MODULES,
  ECOMMERCEOS_DEFAULT_SEED,
  MODULE_IDS,
  type ECommerceOSManifest,
  type ECommerceOsDefaultSeed,
  type ModuleId,
  type ProductCategorySeed,
  type RequiredLifeOsPrimitive,
} from "./manifest/ecommerceos.manifest.js";

export {
  ORDER_STATUSES,
  ORDER_TRANSITIONS,
  LOGISTICS_STATUSES,
  canTransition,
  assertTransition,
  orderStatusFromLogistics,
  type OrderStatus,
  type LogisticsStatus,
} from "./order-states.js";

export { splitSettlement, availableInventory, type SettlementSplit } from "./money.js";
