import { api, type Session, type Status } from "./api";

interface ModelContext {
  registerTool(
    tool: {
      name: string;
      title: string;
      description: string;
      inputSchema: Record<string, unknown>;
      annotations: { readOnlyHint: boolean; untrustedContentHint: boolean };
      execute(input: unknown): unknown | Promise<unknown>;
    },
    options?: { signal?: AbortSignal },
  ): void | Promise<void>;
}

declare global {
  interface Document {
    readonly modelContext?: ModelContext;
  }
}

function companyIdFrom(input: unknown): string {
  if (
    !input ||
    typeof input !== "object" ||
    !("companyId" in input) ||
    typeof input.companyId !== "string"
  ) {
    throw new Error("companyId is required.");
  }
  return input.companyId;
}

export function registerTimeClockTools(
  onChanged: () => Promise<void>,
): () => void {
  const context = document.modelContext;
  if (!context?.registerTool) return () => undefined;
  const lifecycle = new AbortController();
  const options = { signal: lifecycle.signal };

  void Promise.resolve(
    context.registerTool(
      {
        name: "get_time_clock_status",
        title: "Get time clock status",
        description: "Read the currently active company and session, if any.",
        inputSchema: {
          type: "object",
          properties: {},
          additionalProperties: false,
        },
        annotations: { readOnlyHint: true, untrustedContentHint: false },
        execute: async () => api<Status>("/api/v1/status"),
      },
      options,
    ),
  ).catch(console.error);

  void Promise.resolve(
    context.registerTool(
      {
        name: "start_company_session",
        title: "Start company session",
        description: "Clock into one company when no other session is active.",
        inputSchema: {
          type: "object",
          properties: { companyId: { type: "string", format: "uuid" } },
          required: ["companyId"],
          additionalProperties: false,
        },
        annotations: { readOnlyHint: false, untrustedContentHint: false },
        execute: async (input) => {
          const session = await api<Session>("/api/v1/sessions", {
            method: "POST",
            body: JSON.stringify({
              companyId: companyIdFrom(input),
              startedAt: new Date().toISOString(),
            }),
          });
          await onChanged();
          return {
            sessionId: session.id,
            companyId: session.companyId,
            startedAt: session.startedAt,
          };
        },
      },
      options,
    ),
  ).catch(console.error);

  void Promise.resolve(
    context.registerTool(
      {
        name: "stop_active_session",
        title: "Stop active session",
        description: "Clock out of the currently active session.",
        inputSchema: {
          type: "object",
          properties: {},
          additionalProperties: false,
        },
        annotations: { readOnlyHint: false, untrustedContentHint: false },
        execute: async () => {
          const status = await api<Status>("/api/v1/status");
          if (!status.activeSession) throw new Error("No session is active.");
          const result = await api<{
            session: Session;
            durationSeconds: number;
          }>(`/api/v1/sessions/${status.activeSession.id}/stop`, {
            method: "POST",
            body: JSON.stringify({ endedAt: new Date().toISOString() }),
          });
          await onChanged();
          return {
            sessionId: result.session.id,
            durationSeconds: result.durationSeconds,
          };
        },
      },
      options,
    ),
  ).catch(console.error);

  return () => lifecycle.abort();
}
