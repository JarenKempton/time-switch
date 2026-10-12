import { ApiError } from "./http";

const UNIQUE_CONFLICTS: Array<[string, ApiError]> = [
  [
    "companies.name",
    new ApiError(
      409,
      "company_name_conflict",
      "A company with that name already exists.",
    ),
  ],
  [
    "index 'idx_sessions_one_open'",
    new ApiError(
      409,
      "session_already_active",
      "Another session is already active.",
    ),
  ],
  [
    "hour_retrievals.period_start",
    new ApiError(
      409,
      "retrieval_overlap",
      "Those hours were already retrieved. Undo the last retrieval first.",
    ),
  ],
];

export function violatesUnique(error: unknown, target?: string): boolean {
  for (let current = error; current instanceof Error; current = current.cause) {
    const failed = /UNIQUE constraint failed: (.*)/.exec(current.message);
    if (failed && (!target || failed[1].includes(target))) return true;
  }
  return false;
}

export function normalizeError(error: unknown): unknown {
  if (error instanceof ApiError) return error;
  if (error && typeof error === "object" && "issues" in error)
    return new ApiError(422, "validation_error", "Request data is invalid.");
  for (const [target, conflict] of UNIQUE_CONFLICTS)
    if (violatesUnique(error, target)) return conflict;
  return error;
}
