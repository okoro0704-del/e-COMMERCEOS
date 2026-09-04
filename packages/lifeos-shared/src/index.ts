/**
 * LifeOS Core Shell primitives (Phase F) — vendored into ECommerceOS so the
 * domain shell consumes `@lifeos/shared` without a sibling monorepo link.
 */
export type { ITrustIdProvider, TrustIdSessionProof } from "./primitives/trust-id.interface.js";
export type {
  IMessagingProvider,
  MessagingThreadSummary,
  MessagingSendInput,
} from "./primitives/messaging.interface.js";
export type { IStorageProvider, StorageObjectRef } from "./primitives/storage.interface.js";
export type {
  IJobDispatcher,
  IJobsProvider,
  JobEnqueueInput,
  JobEnqueueResult,
} from "./primitives/jobs.interface.js";
export type {
  IMasterDistributorClient,
  IDistributorProvider,
  DeployRequest,
  DeployResult,
} from "./primitives/distributor.interface.js";
export type {
  IFundzManWalletProvider,
  InitiatePaymentPayload,
  PaymentResult,
  WalletBalanceSummary,
  BillPaymentPayload,
  EscrowSplit,
  EscrowReleasePayload,
  EscrowReleaseResult,
} from "./primitives/wallet.interface.js";

export const LIFEOS_PRIMITIVE_IDS = [
  "trust-id",
  "elfcom",
  "sovereign-drive",
  "platform-jobs",
  "master-distributor",
  "fundzman",
] as const;

export type LifeOsPrimitiveId = (typeof LIFEOS_PRIMITIVE_IDS)[number];
