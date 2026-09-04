export type DeployRequest = {
  shellId: string;
  artifactTag: string;
  environment?: "staging" | "production";
};

export type DeployResult = {
  deploymentId: string;
  status: "accepted" | "running" | "failed";
  url?: string;
};

export interface IMasterDistributorClient {
  readonly primitiveId: "master-distributor";
  readonly bound: boolean;
  health(): Promise<{ ok: boolean; service?: string }>;
  requestDeploy(input: DeployRequest): Promise<DeployResult>;
  getDeployment(deploymentId: string): Promise<DeployResult>;
}

/** Portal / docs alias */
export type IDistributorProvider = IMasterDistributorClient;
