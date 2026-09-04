import { config } from "../config.js";
import { setLifeOsPrimitives, type LifeOsPrimitiveContainer } from "./lifeos/container.js";
import {
  LocalElfComMessagingAdapter,
  LocalFundzManAdapter,
  LocalJobDispatcherAdapter,
  LocalMasterDistributorClient,
  LocalSovereignDriveAdapter,
  LocalTrustIdAdapter,
} from "./lifeos/local-adapters.js";
import {
  RemoteElfComMessagingAdapter,
  RemoteFundzManAdapter,
  RemoteJobDispatcherAdapter,
  RemoteMasterDistributorAdapter,
  RemoteSovereignDriveAdapter,
  RemoteTrustIdAdapter,
} from "./lifeos/remote-adapters.js";
import {
  LocalLogisticsClient,
  RemoteLogisticsClient,
  setLogisticsClient,
  type ILogisticsDispatchClient,
} from "./logistics/client.js";

export type PrimitiveBindingMode = "local" | "remote";

let lifeOsContainer: LifeOsPrimitiveContainer | null = null;
let localJobs: LocalJobDispatcherAdapter | null = null;
let localWallet: LocalFundzManAdapter | null = null;
let localMessaging: LocalElfComMessagingAdapter | null = null;
let localLogistics: LocalLogisticsClient | null = null;

function requiredUrl(name: string, value: string | undefined): string {
  const v = (value ?? "").trim();
  if (!v) throw new Error(`Missing env ${name} for PRIMITIVES_MODE=remote`);
  return v;
}

/** LifeOS Phase F — all 6 primitives via `@lifeos/shared` contracts. */
export function registerLifeOsPrimitives(env: NodeJS.ProcessEnv = process.env): LifeOsPrimitiveContainer {
  const mode = (env.PRIMITIVES_MODE ?? config.primitivesMode ?? "local").toLowerCase();

  localJobs = null;
  localWallet = null;
  localMessaging = null;

  const next: LifeOsPrimitiveContainer =
    mode === "remote"
      ? {
          trustId: new RemoteTrustIdAdapter(
            requiredUrl("TRUSTID_URL", env.TRUSTID_URL ?? env.TRUSTID_API_URL ?? config.trustidApiUrl),
          ),
          messaging: new RemoteElfComMessagingAdapter(
            requiredUrl("ELFCOM_URL", env.ELFCOM_URL ?? config.elfcomUrl),
          ),
          storage: new RemoteSovereignDriveAdapter(
            requiredUrl("SOVEREIGN_DRIVE_URL", env.SOVEREIGN_DRIVE_URL ?? config.sovereignDriveUrl),
          ),
          jobs: new RemoteJobDispatcherAdapter(
            requiredUrl("PLATFORM_JOBS_URL", env.PLATFORM_JOBS_URL ?? env.JOBS_ENGINE_URL ?? config.platformJobsUrl),
          ),
          distributor: new RemoteMasterDistributorAdapter(
            requiredUrl(
              "MASTER_DISTRIBUTOR_URL",
              env.MASTER_DISTRIBUTOR_URL ?? env.DISTRIBUTOR_URL ?? config.masterDistributorUrl,
            ),
          ),
          wallet: new RemoteFundzManAdapter(
            requiredUrl("FUNDZMAN_URL", env.FUNDZMAN_URL ?? config.fundzmanUrl),
          ),
        }
      : (() => {
          localJobs = new LocalJobDispatcherAdapter();
          localWallet = new LocalFundzManAdapter();
          localMessaging = new LocalElfComMessagingAdapter();
          return {
            trustId: new LocalTrustIdAdapter(),
            messaging: localMessaging,
            storage: new LocalSovereignDriveAdapter(),
            jobs: localJobs,
            distributor: new LocalMasterDistributorClient(),
            wallet: localWallet,
          };
        })();

  setLifeOsPrimitives(next);
  lifeOsContainer = next;
  return next;
}

export function registerLogisticsClient(env: NodeJS.ProcessEnv = process.env): ILogisticsDispatchClient {
  const mode = (env.LOGISTICS_MODE ?? env.PRIMITIVES_MODE ?? config.logisticsMode ?? "local").toLowerCase();
  if (mode === "remote") {
    localLogistics = null;
    const client = new RemoteLogisticsClient(
      requiredUrl("LOGISTICS_OS_URL", env.LOGISTICS_OS_URL ?? config.logisticsOsUrl),
      env.PRIMITIVES_SERVICE_TOKEN ?? config.primitivesServiceToken,
    );
    setLogisticsClient(client);
    return client;
  }
  localLogistics = new LocalLogisticsClient();
  setLogisticsClient(localLogistics);
  return localLogistics;
}

export function getRegisteredLifeOsPrimitives(): LifeOsPrimitiveContainer {
  if (!lifeOsContainer) return registerLifeOsPrimitives();
  return lifeOsContainer;
}

export function getLocalJobDispatcher(): LocalJobDispatcherAdapter | null {
  return localJobs;
}

export function getLocalFundzMan(): LocalFundzManAdapter | null {
  return localWallet;
}

export function getLocalElfCom(): LocalElfComMessagingAdapter | null {
  return localMessaging;
}

export function getLocalLogistics(): LocalLogisticsClient | null {
  return localLogistics;
}

export function registerLocalPrimitiveProvidersOrRemote(): void {
  registerLifeOsPrimitives();
  registerLogisticsClient();
}
