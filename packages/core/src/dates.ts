/**
 * Date helpers. Small and dependency-free so guardrails and analytics stay
 * testable without mocking the clock.
 */
const MS_PER_DAY = 24 * 60 * 60 * 1000;

export function differenceInCalendarDays(later: Date, earlier: Date): number {
  const a = Date.UTC(later.getUTCFullYear(), later.getUTCMonth(), later.getUTCDate());
  const b = Date.UTC(earlier.getUTCFullYear(), earlier.getUTCMonth(), earlier.getUTCDate());
  return Math.round((a - b) / MS_PER_DAY);
}

export function differenceInHours(later: Date, earlier: Date): number {
  return Math.floor((later.getTime() - earlier.getTime()) / (60 * 60 * 1000));
}

export function addDays(date: Date, days: number): Date {
  return new Date(date.getTime() + days * MS_PER_DAY);
}

export function addHours(date: Date, hours: number): Date {
  return new Date(date.getTime() + hours * 60 * 60 * 1000);
}

export function startOfUtcDay(date: Date): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
}

export function isoDay(date: Date | string): string {
  return new Date(date).toISOString().slice(0, 10);
}

/** Monday of the ISO week containing `date`, as a YYYY-MM-DD key. */
export function weekKey(date: Date | string, now = new Date()): string {
  const target = new Date(date);
  // getUTCDay() is 0 for Sunday; shift so Monday is the start of the week.
  const monday = new Date(
    Date.UTC(target.getUTCFullYear(), target.getUTCMonth(), target.getUTCDate()),
  );
  monday.setUTCDate(monday.getUTCDate() - ((monday.getUTCDay() + 6) % 7));
  void now;
  return monday.toISOString().slice(0, 10);
}

export function relativeTime(from: Date | string, now = new Date()): string {
  const diff = new Date(now).getTime() - new Date(from).getTime();
  const minutes = Math.floor(diff / 60000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  const months = Math.floor(days / 30);
  return months < 12 ? `${months}mo ago` : `${Math.floor(months / 12)}y ago`;
}