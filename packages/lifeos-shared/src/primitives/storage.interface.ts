export type StorageObjectRef = {
  namespace: string;
  key: string;
  contentType?: string;
  sizeBytes?: number;
  url?: string;
};

export interface IStorageProvider {
  readonly primitiveId: "sovereign-drive";
  readonly bound: boolean;
  health(): Promise<{ ok: boolean; service?: string }>;
  put(input: {
    namespace: string;
    key: string;
    body: Uint8Array | string;
    contentType?: string;
  }): Promise<StorageObjectRef>;
  get(input: {
    namespace: string;
    key: string;
  }): Promise<{ body: Uint8Array; contentType?: string } | null>;
}
