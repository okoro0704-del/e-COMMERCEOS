export type TrustIdSessionProof = {
  trustId: string;
  sessionToken?: string;
  trustTier?: number;
  verified?: boolean;
};

export interface ITrustIdProvider {
  readonly primitiveId: "trust-id";
  readonly bound: boolean;
  health(): Promise<{ ok: boolean; service?: string }>;
  resolveSession(sessionToken: string): Promise<TrustIdSessionProof | null>;
}
