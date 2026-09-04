import type {
  IFundzManWalletProvider,
  IJobDispatcher,
  IMasterDistributorClient,
  IMessagingProvider,
  IStorageProvider,
  ITrustIdProvider,
  LifeOsPrimitiveId,
} from "@lifeos/shared";

export type LifeOsPrimitiveContainer = {
  trustId: ITrustIdProvider;
  messaging: IMessagingProvider;
  storage: IStorageProvider;
  jobs: IJobDispatcher;
  distributor: IMasterDistributorClient;
  wallet: IFundzManWalletProvider;
};

let container: LifeOsPrimitiveContainer | null = null;

export function setLifeOsPrimitives(next: LifeOsPrimitiveContainer): void {
  container = next;
}

export function getLifeOsPrimitives(): LifeOsPrimitiveContainer {
  if (!container) {
    throw new Error("LifeOS primitives not registered — call registerLifeOsPrimitives at boot");
  }
  return container;
}

export function getTrustIdProvider(): ITrustIdProvider {
  return getLifeOsPrimitives().trustId;
}

export function getLifeOsMessagingProvider(): IMessagingProvider {
  return getLifeOsPrimitives().messaging;
}

export function getLifeOsStorageProvider(): IStorageProvider {
  return getLifeOsPrimitives().storage;
}

export function getJobsProvider(): IJobDispatcher {
  return getLifeOsPrimitives().jobs;
}

export function getDistributorProvider(): IMasterDistributorClient {
  return getLifeOsPrimitives().distributor;
}

export function getFundzManWalletProvider(): IFundzManWalletProvider {
  return getLifeOsPrimitives().wallet;
}

export async function assertLifeOsPrimitivesReady() {
  const c = getLifeOsPrimitives();
  const entries: Array<[keyof LifeOsPrimitiveContainer, { bound: boolean; primitiveId: string }]> = [
    ["trustId", c.trustId],
    ["messaging", c.messaging],
    ["storage", c.storage],
    ["jobs", c.jobs],
    ["distributor", c.distributor],
    ["wallet", c.wallet],
  ];
  const missing = entries.filter(([, p]) => !p.bound).map(([k]) => k);
  if (missing.length) {
    throw new Error(`Primitives not bound: ${missing.join(", ")}`);
  }
  return {
    ok: true as const,
    count: 6 as const,
    ids: entries.map(([, p]) => p.primitiveId as LifeOsPrimitiveId),
  };
}
