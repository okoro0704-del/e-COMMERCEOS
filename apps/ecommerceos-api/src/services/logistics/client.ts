export type GeoAddress = {
  lat: number;
  lng: number;
  addressLine1: string;
  addressLine2?: string | null;
  city: string;
  region?: string | null;
  postalCode?: string | null;
  country: string;
  contactName?: string;
  contactPhone?: string | null;
};

export type LogisticsDispatchPayload = {
  orderId: string;
  tenantId: string;
  pickup: GeoAddress;
  dropoff: GeoAddress;
  package: {
    weightGrams: number;
    lengthCm: number;
    widthCm: number;
    heightCm: number;
  };
  buyer: {
    trustId: string;
    name: string;
    phone?: string | null;
    email?: string | null;
  };
};

export type LogisticsDispatchResult = {
  logisticsJobId: string;
  status: string;
};

export interface ILogisticsDispatchClient {
  dispatch(payload: LogisticsDispatchPayload): Promise<LogisticsDispatchResult>;
}

let client: ILogisticsDispatchClient | null = null;

export function setLogisticsClient(next: ILogisticsDispatchClient): void {
  client = next;
}

export function getLogisticsClient(): ILogisticsDispatchClient {
  if (!client) {
    throw new Error("Logistics client not registered");
  }
  return client;
}

export class LocalLogisticsClient implements ILogisticsDispatchClient {
  readonly jobs: Array<LogisticsDispatchPayload & LogisticsDispatchResult> = [];
  private seq = 0;

  async dispatch(payload: LogisticsDispatchPayload): Promise<LogisticsDispatchResult> {
    this.seq += 1;
    const result = { logisticsJobId: `log_job_${this.seq}`, status: "CREATED" };
    this.jobs.push({ ...payload, ...result });
    return result;
  }
}

export class RemoteLogisticsClient implements ILogisticsDispatchClient {
  constructor(
    private readonly baseUrl: string,
    private readonly token: string,
  ) {}

  async dispatch(payload: LogisticsDispatchPayload): Promise<LogisticsDispatchResult> {
    const res = await fetch(`${this.baseUrl.replace(/\/$/, "")}/internal/logistics/dispatch`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.token}`,
      },
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      const text = await res.text();
      throw Object.assign(new Error(`Logistics dispatch failed: ${res.status} ${text}`), {
        statusCode: 502,
        code: "logistics_dispatch_failed",
      });
    }
    return (await res.json()) as LogisticsDispatchResult;
  }
}
