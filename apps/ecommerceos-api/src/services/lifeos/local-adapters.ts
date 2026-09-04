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

export class LocalFundzManAdapter implements IFundzManWalletProvider {
  readonly primitiveId = "fundzman" as const;
  readonly bound = true;
  readonly intents = new Map<string, { amount: number; currency: string; status: string; payerTrustId: string }>();
  readonly releases: EscrowReleaseResult[] = [];
  private seq = 0;

  async health() {
    return { ok: true, service: "fundzman-local" };
  }

  async initiatePayment(payload: InitiatePaymentPayload): Promise<PaymentResult> {
    this.seq += 1;
    const paymentId = `local_pay_${this.seq}`;
    const status = payload.escrow ? "escrow_held" : "authorized";
    this.intents.set(paymentId, {
      amount: payload.amount,
      currency: payload.currency,
      status,
      payerTrustId: payload.payerTrustId,
    });
    return {
      paymentId,
      status,
      amount: payload.amount,
      currency: payload.currency,
      receiptId: `local_rcpt_${this.seq}`,
      message: "local fundzman stub",
    };
  }

  async billPassThrough(payload: BillPaymentPayload): Promise<PaymentResult> {
    this.seq += 1;
    return {
      paymentId: `local_bill_${this.seq}`,
      status: "settled",
      amount: payload.amount,
      currency: payload.currency,
      receiptId: `local_bill_rcpt_${this.seq}`,
      message: "local bill pass-through",
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

  async releaseEscrow(payload: EscrowReleasePayload): Promise<EscrowReleaseResult> {
    const intent = this.intents.get(payload.paymentId);
    if (!intent || intent.status !== "escrow_held") {
      throw Object.assign(new Error("No escrow to release"), { statusCode: 409, code: "escrow_not_held" });
    }
    const splitSum = payload.splits.reduce((s, x) => s + x.amount, 0);
    if (splitSum !== intent.amount) {
      throw Object.assign(new Error("Split sum does not match escrow amount"), {
        statusCode: 400,
        code: "split_mismatch",
      });
    }
    intent.status = "settled";
    const result: EscrowReleaseResult = {
      releaseId: `local_rel_${++this.seq}`,
      paymentId: payload.paymentId,
      status: "settled",
      splits: payload.splits,
    };
    this.releases.push(result);
    return result;
  }
}
