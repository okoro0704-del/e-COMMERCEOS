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
import { randomUUID } from "node:crypto";

export class LocalTrustIdAdapter implements ITrustIdProvider {
  readonly primitiveId = "trust-id" as const;
  readonly bound = true;
  async health() {
    return { ok: true, service: "trustid-local" };
  }
  async resolveSession(sessionToken: string): Promise<TrustIdSessionProof | null> {
    if (!sessionToken) return null;
    const trustId = sessionToken.startsWith("TD-") ? sessionToken : `TD-${sessionToken}`;
    return { trustId, sessionToken, trustTier: 1, verified: true };
  }
}

export class LocalElfComMessagingAdapter implements IMessagingProvider {
  readonly primitiveId = "elfcom" as const;
  readonly bound = true;
  readonly sent: Array<MessagingSendInput & { messageId: string }> = [];
  async health() {
    return { ok: true, service: "elfcom-local" };
  }
  async listThreads(ownerTrustId: string) {
    const ids = [...new Set(this.sent.filter((m) => m.ownerTrustId === ownerTrustId).map((m) => m.threadId))];
    return ids.map((id) => ({ id, updatedAt: new Date().toISOString() }));
  }
  async sendMessage(input: MessagingSendInput) {
    const messageId = `local_msg_${randomUUID()}`;
    this.sent.push({ ...input, messageId });
    return { messageId };
  }
}

export class LocalSovereignDriveAdapter implements IStorageProvider {
  readonly primitiveId = "sovereign-drive" as const;
  readonly bound = true;
  readonly store = new Map<string, { body: Uint8Array; contentType?: string }>();
  async health() {
    return { ok: true, service: "sovereign-drive-local" };
  }
  async put(input: {
    namespace: string;
    key: string;
    body: Uint8Array | string;
    contentType?: string;
  }): Promise<StorageObjectRef> {
    const body = typeof input.body === "string" ? Buffer.from(input.body) : input.body;
    const bytes = body instanceof Uint8Array ? body : new Uint8Array(body);
    this.store.set(`${input.namespace}:${input.key}`, { body: bytes, contentType: input.contentType });
    return {
      namespace: input.namespace,
      key: input.key,
      contentType: input.contentType,
      sizeBytes: bytes.byteLength,
      url: `drive://${input.namespace}/${input.key}`,
    };
  }
  async get(input: { namespace: string; key: string }) {
    return this.store.get(`${input.namespace}:${input.key}`) ?? null;
  }
}

type JobHandler = (payload: Record<string, unknown>) => Promise<void>;

export class LocalJobDispatcherAdapter implements IJobDispatcher {
  readonly primitiveId = "platform-jobs" as const;
  readonly bound = true;
  readonly jobs = new Map<string, { status: string; type: string; payload: Record<string, unknown> }>();
  readonly handlers = new Map<string, JobHandler>();

  registerHandler(type: string, handler: JobHandler) {
    this.handlers.set(type, handler);
  }

  async health() {
    return { ok: true, service: "platform-jobs-local" };
  }

  async enqueue(input: JobEnqueueInput) {
    const jobId = `local_job_${randomUUID()}`;
    this.jobs.set(jobId, { status: input.delayMs ? "scheduled" : "queued", type: input.type, payload: input.payload });
    const run = async () => {
      const handler = this.handlers.get(input.type);
      try {
        if (handler) await handler(input.payload);
        const j = this.jobs.get(jobId);
        if (j) j.status = "completed";
      } catch {
        const j = this.jobs.get(jobId);
        if (j) j.status = "failed";
      }
    };
    if (input.delayMs && input.delayMs > 0) {
      const timer = setTimeout(() => void run(), input.delayMs);
      timer.unref();
      return { jobId, status: "scheduled" as const };
    }
    queueMicrotask(() => void run());
    return { jobId, status: "queued" as const };
  }

  async getStatus(jobId: string) {
    return { jobId, status: this.jobs.get(jobId)?.status ?? "unknown" };
  }
}

export class LocalMasterDistributorClient implements IMasterDistributorClient {
  readonly primitiveId = "master-distributor" as const;
  readonly bound = true;
  readonly deploys: Array<{ shellId: string; artifactTag: string; deploymentId: string; url?: string }> = [];
  private seq = 0;
  async health() {
    return { ok: true, service: "master-distributor-local" };
  }
  async requestDeploy(input: { shellId: string; artifactTag: string }) {
    this.seq += 1;
    const deploymentId = `local_dep_${this.seq}`;
    const url = `https://${input.artifactTag.replace(/^tenant:/, "")}.lifeos.app`;
    this.deploys.push({ ...input, deploymentId, url });
    return { deploymentId, status: "accepted" as const, url };
  }
  async getDeployment(deploymentId: string) {
    const found = this.deploys.find((d) => d.deploymentId === deploymentId);
    return { deploymentId, status: "accepted" as const, url: found?.url };
  }
}

/**
 * In-process stand-in for FundzMan. It cannot move money, so it never reports a
 * payment as authorized, held or settled, and it never releases funds.
 */
export class LocalFundzManAdapter implements IFundzManWalletProvider {
  readonly primitiveId = "fundzman" as const;
  readonly bound = true;
  readonly attempts: InitiatePaymentPayload[] = [];
  readonly releases: EscrowReleaseResult[] = [];
  private seq = 0;

  async health() {
    return { ok: true, service: "fundzman-local" };
  }

  async initiatePayment(payload: InitiatePaymentPayload): Promise<PaymentResult> {
    this.seq += 1;
    this.attempts.push(payload);
    return {
      paymentId: `local_unpaid_${this.seq}`,
      status: "failed",
      amount: payload.amount,
      currency: payload.currency,
      message: "The local payment adapter cannot accept payments. No funds were moved.",
    };
  }

  async billPassThrough(payload: BillPaymentPayload): Promise<PaymentResult> {
    this.seq += 1;
    return {
      paymentId: `local_unpaid_bill_${this.seq}`,
      status: "failed",
      amount: payload.amount,
      currency: payload.currency,
      message: "The local payment adapter cannot accept payments. No funds were moved.",
    };
  }

  async getWalletSummary(userId: string): Promise<WalletBalanceSummary> {
    return {
      userId,
      currency: "NGN",
      available: 0,
      pending: 0,
      formattedAvailable: "₦0",
    };
  }

  async releaseEscrow(_payload: EscrowReleasePayload): Promise<EscrowReleaseResult> {
    throw Object.assign(new Error("The local payment adapter holds no funds and cannot release any."), {
      statusCode: 409,
      code: "escrow_unavailable",
    });
  }
}
