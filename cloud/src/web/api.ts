import type { PayPeriodCadence } from "../db/schema";

export interface Company {
  id: string;
  name: string;
  logoUrl: string | null;
  color: string | null;
  payPeriodCadence: PayPeriodCadence;
  payPeriodAnchorDate: string | null;
  archived: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface Session {
  id: string;
  companyId: string;
  startedAt: string;
  endedAt: string | null;
  note: string | null;
  createdAt: string;
  updatedAt: string;
  company: Company;
}

export interface Status {
  activeSession: Session | null;
  serverTime: string;
}

export interface Summary {
  from: string | null;
  to: string | null;
  companies: Array<Company & { totalSeconds: number }>;
}

export interface CompanyHours {
  companyId: string;
  from: string | null;
  to: string | null;
  totalSeconds: number;
  sessionCount: number;
}

export interface Retrieval {
  id: string;
  companyId: string;
  periodStart: string;
  periodEnd: string;
  nextPeriodEnd: string;
  totalSeconds: number;
  note: string | null;
  createdAt: string;
  updatedAt: string;
  company: Company;
}

export interface RetrievalInput {
  periodStart: string;
  periodEnd: string;
  nextPeriodEnd: string;
  note?: string | null;
  reanchorDate?: string;
}

export interface PurgeInput {
  maxDurationSeconds?: number;
  dryRun?: boolean;
  companyId?: string;
  from?: string;
  to?: string;
}

export interface PurgeResult {
  dryRun: boolean;
  maxDurationSeconds: number;
  purgedCount: number;
  purgedSeconds: number;
  ids: string[];
  byCompany: Array<{
    companyId: string;
    name: string;
    count: number;
    totalSeconds: number;
  }>;
  /**
   * Closed pay periods that contained a purged session. Their stored total
   * reads high by `staleSeconds` until the retrieval is undone and redone.
   */
  affectedRetrievals: Array<{
    id: string;
    companyId: string;
    companyName: string;
    periodStart: string;
    periodEnd: string;
    totalSeconds: number;
    staleSeconds: number;
  }>;
  status: Status;
}

export interface Device {
  id: string;
  name: string;
  firmwareVersion: string | null;
  provisionedAt: string | null;
  lastSeenAt: string | null;
  revokedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface DeviceRegistration {
  device: Device;
  setupToken: string;
}

interface Envelope<T> {
  data: T;
}

interface ErrorEnvelope {
  error?: { message?: string };
}

export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const headers = new Headers(init?.headers);
  if (init?.body) headers.set("content-type", "application/json");
  const response = await fetch(path, { ...init, headers });
  const body = (await response.json().catch(() => ({}))) as Envelope<T> &
    ErrorEnvelope;
  if (!response.ok)
    throw new Error(
      body.error?.message ?? `Request failed (${response.status}).`,
    );
  return body.data;
}

export function query(params: Record<string, string | undefined>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params))
    if (value !== undefined) search.set(key, value);
  const text = search.toString();
  return text ? `?${text}` : "";
}

export const timeClock = {
  companies: (includeArchived = false) =>
    api<Company[]>(
      `/api/v1/companies${query({ includeArchived: includeArchived ? "true" : undefined })}`,
    ),
  createCompany: (body: unknown) =>
    api<Company>("/api/v1/companies", {
      method: "POST",
      body: JSON.stringify(body),
    }),
  devices: () => api<Device[]>("/api/v1/devices"),
  createDevice: (name: string) =>
    api<DeviceRegistration>("/api/v1/devices", {
      method: "POST",
      body: JSON.stringify({ name }),
    }),
  prepareDeviceSetup: (id: string) =>
    api<DeviceRegistration>(`/api/v1/devices/${id}/setup`, {
      method: "POST",
    }),
  deleteDevice: (id: string) =>
    api<{ id: string }>(`/api/v1/devices/${id}`, { method: "DELETE" }),
  updateCompany: (id: string, body: unknown) =>
    api<Company>(`/api/v1/companies/${id}`, {
      method: "PATCH",
      body: JSON.stringify(body),
    }),
  sessions: (params: Record<string, string | undefined> = {}) =>
    api<Session[]>(`/api/v1/sessions${query(params)}`),
  startSession: (companyId: string) =>
    api<Session>("/api/v1/sessions", {
      method: "POST",
      body: JSON.stringify({ companyId, startedAt: new Date().toISOString() }),
    }),
  stopSession: (id: string) =>
    api<{ session: Session; durationSeconds: number }>(
      `/api/v1/sessions/${id}/stop`,
      {
        method: "POST",
        body: JSON.stringify({ endedAt: new Date().toISOString() }),
      },
    ),
  updateSession: (id: string, body: unknown) =>
    api<Session>(`/api/v1/sessions/${id}`, {
      method: "PATCH",
      body: JSON.stringify(body),
    }),
  deleteSession: (id: string) =>
    api<{ id: string }>(`/api/v1/sessions/${id}`, { method: "DELETE" }),
  purgeSessions: (body: PurgeInput) =>
    api<PurgeResult>("/api/v1/sessions/purge", {
      method: "POST",
      body: JSON.stringify(body),
    }),
  status: () => api<Status>("/api/v1/status"),
  summary: (from: Date, to: Date) =>
    api<Summary>(
      `/api/v1/summary${query({ from: from.toISOString(), to: to.toISOString() })}`,
    ),
  companyHours: (companyId: string, from: Date, to: Date) =>
    api<CompanyHours>(
      `/api/v1/companies/${companyId}/hours${query({ from: from.toISOString(), to: to.toISOString() })}`,
    ),
  retrievals: (companyId?: string) =>
    api<Retrieval[]>(`/api/v1/retrievals${query({ companyId })}`),
  createRetrieval: (companyId: string, body: RetrievalInput) =>
    api<Retrieval>(`/api/v1/companies/${companyId}/retrievals`, {
      method: "POST",
      body: JSON.stringify(body),
    }),
  deleteRetrieval: (id: string) =>
    api<{ id: string }>(`/api/v1/retrievals/${id}`, { method: "DELETE" }),
  exportUrl: (params: Record<string, string | undefined> = {}) =>
    `/api/v1/export.csv${query(params)}`,
};
