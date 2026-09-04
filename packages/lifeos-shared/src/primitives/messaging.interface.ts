export type MessagingThreadSummary = {
  id: string;
  subject?: string;
  updatedAt?: string;
};

export type MessagingSendInput = {
  ownerTrustId: string;
  threadId: string;
  body: string;
  channel?: "chat" | "sms";
};

export interface IMessagingProvider {
  readonly primitiveId: "elfcom";
  readonly bound: boolean;
  health(): Promise<{ ok: boolean; service?: string }>;
  listThreads(ownerTrustId: string): Promise<MessagingThreadSummary[]>;
  sendMessage(input: MessagingSendInput): Promise<{ messageId: string }>;
}
