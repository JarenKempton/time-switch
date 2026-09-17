export function formatDuration(totalSeconds: number): string {
  const seconds = Math.max(0, Math.floor(totalSeconds));
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  if (hours === 0) return `${minutes}m`;
  return `${hours}h ${minutes.toString().padStart(2, "0")}m`;
}

/** Decimal hours, the number most invoices and payroll forms want. */
export function formatHours(totalSeconds: number): string {
  return (Math.max(0, totalSeconds) / 3600).toFixed(2);
}

export function formatClock(totalSeconds: number): string {
  const seconds = Math.max(0, Math.floor(totalSeconds));
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const remainder = seconds % 60;
  return [hours, minutes, remainder]
    .map((part) => part.toString().padStart(2, "0"))
    .join(":");
}

export function formatDateTime(value: string | number | Date): string {
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(value));
}

export function formatTime(value: string | number | Date): string {
  return new Intl.DateTimeFormat(undefined, {
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(value));
}

export function formatDate(
  value: string | number | Date,
  withYear = false,
): string {
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    ...(withYear ? { year: "numeric" } : {}),
  }).format(new Date(value));
}

export function formatWeekday(value: string | number | Date): string {
  return new Intl.DateTimeFormat(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
  }).format(new Date(value));
}

/**
 * A period range for display. Ends are exclusive instants, so the last
 * calendar day shown is the day before the end when the end is at midnight.
 */
export function formatRange(
  start: string | number | Date,
  end: string | number | Date,
): string {
  const startDate = new Date(start);
  const endDate = new Date(end);
  const inclusiveEnd = new Date(endDate.getTime() - 1);
  const sameYear = startDate.getFullYear() === inclusiveEnd.getFullYear();
  return `${formatDate(startDate, !sameYear)} – ${formatDate(inclusiveEnd, true)}`;
}

export function formatRelative(
  value: string | number | Date,
  now = Date.now(),
): string {
  const diff = now - new Date(value).getTime();
  const minutes = Math.round(diff / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  if (days < 14) return `${days}d ago`;
  return formatDate(value, true);
}

export function sessionSeconds(
  session: { startedAt: string; endedAt: string | null },
  now: number,
): number {
  const end = session.endedAt ? new Date(session.endedAt).getTime() : now;
  return (end - new Date(session.startedAt).getTime()) / 1000;
}
