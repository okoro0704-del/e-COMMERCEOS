export type InitiatePaymentPayload = {
  payerTrustId: string;
  payeeId: string;
  amount: number;
  currency: string;
  reference?: string;
  escrow?: boolean;
  metadata?: Record<string, unknown>;
};

export type PaymentResult = {
  paymentId: string;
  status: "pending" | "authorized" | "settled" | "failed" | "escrow_held";
  amount: number;
  currency: string;
  receiptId?: string;
  message?: string;
};

export type WalletBalanceSummary = {
  userId: string;
  currency: string;
  available: number;
  pending: number;
  formattedAvailable: string;
};

export type BillPaymentPayload = {
  payerTrustId: string;
  billId: string;
  amount: number;
  currency: string;
  passThrough: Record<string, unknown>;
};

export type EscrowSplit = {
  payeeId: string;
  role: "merchant" | "rider" | "platform";
  amount: number;
};

export type EscrowReleasePayload = {
  paymentId: string;
  splits: EscrowSplit[];
  currency: string;
  reference?: string;
  metadata?: Record<string, unknown>;
};

export type EscrowReleaseResult = {
  releaseId: string;
  paymentId: string;
  status: "settled" | "failed";
  splits: EscrowSplit[];
};

export interface IFundzManWalletProvider {
  readonly primitiveId: "fundzman";
  readonly bound: boolean;
  health(): Promise<{ ok: boolean; service?: string }>;
  initiatePayment(payload: InitiatePaymentPayload): Promise<PaymentResult>;
  billPassThrough(payload: BillPaymentPayload): Promise<PaymentResult>;
  getWalletSummary(userId: string): Promise<WalletBalanceSummary>;
  releaseEscrow(payload: EscrowReleasePayload): Promise<EscrowReleaseResult>;
}
