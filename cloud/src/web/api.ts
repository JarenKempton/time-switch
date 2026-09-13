export interface Company {
  id: string;
  name: string;
  logoUrl: string | null;
  color: string | null;
  payPeriodCadence: "weekly" | "biweekly" | "semimonthly" | "monthly";
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
