import type {
  BillPaymentPayload,
  EscrowReleasePayload,
  EscrowReleaseResult,
  IFundzManWalletProvider,
  IJobDispatcher,
  IMasterDistributorClient,
  IMessagingProvider,
  IStorageProvider,
  ITrustIdProvider,
  InitiatePaymentPayload,
  JobEnqueueInput,
  MessagingSendInput,
  PaymentResult,
  StorageObjectRef,
  TrustIdSessionProof,
  WalletBalanceSummary,
} from "@lifeos/shared";

async function httpJson<T>(baseUrl: string, path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${baseUrl.replace(/\/$/, "")}${path}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...(init?.headers ?? {}),
    },
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`HTTP ${res.status} ${path}: ${text}`);
  }
  return (await res.json()) as T;
}

export class RemoteTrustIdAdapter implements ITrustIdProvider {
  readonly primitiveId = "trust-id" as const;
  readonly bound = true;
  constructor(private readonly baseUrl: string) {}
  async health() {
    try {
      const h = await httpJson<{ ok?: boolean; service?: string }>(this.baseUrl, "/health");
      return { ok: h.ok !== false, service: h.service ?? "trustid" };
    } catch {
      return { ok: false, service: "trustid" };
    }
  }
  async resolveSession(sessionToken: string): Promise<TrustIdSessionProof | null> {
    try {
      return await httpJson<TrustIdSessionProof>(this.baseUrl, "/auth/me", {
        headers: { Authorization: `Bearer ${sessionToken}` },
      });
    } catch {
      return null;
    }
  }
}

export class RemoteElfComMessagingAdapter implements IMessagingProvider {
  readonly primitiveId = "elfcom" as const;
  readonly bound = true;
  constructor(private readonly baseUrl: string) {}
  async health() {
    try {
      const h = await httpJson<{ ok?: boolean }>(this.baseUrl, "/health");
      return { ok: h.ok !== false, service: "elfcom" };
    } catch {
      return { ok: false, service: "elfcom" };
    }
  }
  async listThreads(ownerTrustId: string) {
    return httpJson<{ threads: Array<{ id: string }> }>(
      this.baseUrl,
      `/v1/threads/${encodeURIComponent(ownerTrustId)}`,
    ).then((r) => r.threads ?? []);
  }
  async sendMessage(input: MessagingSendInput) {
    return httpJson<{ messageId: string }>(this.baseUrl, "/v1/messages/send", {
      method: "POST",
      body: JSON.stringify(input),
    });
  }
}

export class RemoteSovereignDriveAdapter implements IStorageProvider {
  readonly primitiveId = "sovereign-drive" as const;
  readonly bound = true;
  constructor(private readonly baseUrl: string) {}
  async health() {
    try {
      const h = await httpJson<{ ok?: boolean }>(this.baseUrl, "/health");
      return { ok: h.ok !== false, service: "sovereign-drive" };
    } catch {
      return { ok: false, service: "sovereign-drive" };
    }
  }
  async put(input: {
    namespace: string;
    key: string;
    body: Uint8Array | string;
    contentType?: string;
  }): Promise<StorageObjectRef> {
    const body =
      typeof input.body === "string"
        ? Buffer.from(input.body).toString("base64")
        : Buffer.from(input.body).toString("base64");
    return httpJson<StorageObjectRef>(this.baseUrl, "/v1/storage/put", {
      method: "POST",
      body: JSON.stringify({ ...input, body, encoding: "base64" }),
    });
  }
  async get(input: { namespace: string; key: string }) {
    return httpJson<{ body: string; contentType?: string; encoding?: string } | null>(
      this.baseUrl,
      `/v1/storage/object?namespace=${encodeURIComponent(input.namespace)}&key=${encodeURIComponent(input.key)}`,
    ).then((r) => {
      if (!r) return null;
      const bytes = Buffer.from(r.body, r.encoding === "base64" ? "base64" : "utf8");
      return { body: new Uint8Array(bytes), contentType: r.contentType };
    });
  }
}

export class RemoteJobDispatcherAdapter implements IJobDispatcher {
  readonly primitiveId = "platform-jobs" as const;
  readonly bound = true;
  constructor(private readonly baseUrl: string) {}
  async health() {
    try {
      const h = await httpJson<{ ok?: boolean }>(this.baseUrl, "/health");
      return { ok: h.ok !== false, service: "platform-jobs" };
    } catch {
      return { ok: false, service: "platform-jobs" };
    }
  }
  async enqueue(input: JobEnqueueInput): Promise<{ jobId: string; status: "queued" | "scheduled" }> {
    return httpJson(this.baseUrl, "/v1/jobs/enqueue", {
      method: "POST",
      body: JSON.stringify(input),
    });
  }
  async getStatus(jobId: string): Promise<{ jobId: string; status: string }> {
    return httpJson(this.baseUrl, `/v1/jobs/${encodeURIComponent(jobId)}`);
  }
}

export class RemoteMasterDistributorAdapter implements IMasterDistributorClient {
  readonly primitiveId = "master-distributor" as const;
  readonly bound = true;
  constructor(private readonly baseUrl: string) {}
  async health() {
    try {
      const h = await httpJson<{ ok?: boolean }>(this.baseUrl, "/health");
      return { ok: h.ok !== false, service: "master-distributor" };
    } catch {
      return { ok: false, service: "master-distributor" };
    }
  }
  async requestDeploy(input: {
    shellId: string;
    artifactTag: string;
    environment?: "staging" | "production";
  }): Promise<{ deploymentId: string; status: "accepted" | "running" | "failed"; url?: string }> {
    return httpJson(this.baseUrl, "/v1/deployments", {
      method: "POST",
      body: JSON.stringify(input),
    });
  }
  async getDeployment(
    deploymentId: string,
  ): Promise<{ deploymentId: string; status: "accepted" | "running" | "failed"; url?: string }> {
    return httpJson(this.baseUrl, `/v1/deployments/${encodeURIComponent(deploymentId)}`);
  }
}

export class RemoteFundzManAdapter implements IFundzManWalletProvider {
  readonly primitiveId = "fundzman" as const;
  readonly bound = true;
  constructor(private readonly baseUrl: string) {}
  async health() {
    try {
      const h = await httpJson<{ ok?: boolean; service?: string }>(this.baseUrl, "/health");
      return { ok: h.ok !== false, service: h.service ?? "fundzman" };
    } catch {
      return { ok: false, service: "fundzman" };
    }
  }
  async initiatePayment(payload: InitiatePaymentPayload): Promise<PaymentResult> {
    return httpJson(this.baseUrl, "/v1/wallet/pay", {
      method: "POST",
      body: JSON.stringify(payload),
    });
  }
  async billPassThrough(payload: BillPaymentPayload): Promise<PaymentResult> {
    return httpJson(this.baseUrl, "/v1/wallet/bill-pass-through", {
      method: "POST",
      body: JSON.stringify(payload),
    });
  }
  async getWalletSummary(userId: string): Promise<WalletBalanceSummary> {
    return httpJson(this.baseUrl, `/v1/wallet/${encodeURIComponent(userId)}/summary`);
  }
  async releaseEscrow(payload: EscrowReleasePayload): Promise<EscrowReleaseResult> {
    return httpJson(this.baseUrl, "/v1/wallet/escrow/release", {
      method: "POST",
      body: JSON.stringify(payload),
    });
  }
}
