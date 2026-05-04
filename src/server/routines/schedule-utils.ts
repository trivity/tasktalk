import type { RoutineSchedule } from '../db/schema.js';

/**
 * Compute the next run time (UTC) for a schedule given the user's IANA timezone.
 * Returns the smallest UTC Date strictly after `after` that satisfies the schedule.
 *
 * Timezone math is done via Intl.DateTimeFormat: we extract wall-clock parts in
 * the target timezone and re-interpret them through tzOffsetMinutes to round-trip
 * to UTC. Edge cases around DST transitions can land on the wrong side by an
 * hour for those two days a year — acceptable for v1.
 */
export function computeNextRun(schedule: RoutineSchedule, timezone: string, after: Date = new Date()): Date {
  const [hour, minute] = parseTime(schedule.time);

  // Walk forward day-by-day until we find a day that satisfies the schedule.
  // Cap at 366 to bound runtime.
  for (let dayOffset = 0; dayOffset <= 366; dayOffset++) {
    const candidate = wallClockInTzPlusDays(after, dayOffset, hour, minute, timezone);
    if (candidate.getTime() <= after.getTime()) continue; // past or now — keep walking
    if (matchesSchedule(candidate, schedule, timezone)) return candidate;
  }
  // Fallback: 24h from now. Should never hit this.
  return new Date(after.getTime() + 24 * 60 * 60 * 1000);
}

function parseTime(t: string): [number, number] {
  const m = /^(\d{1,2}):(\d{2})$/.exec(t);
  if (!m) return [0, 0];
  return [Math.min(23, Math.max(0, Number(m[1]))), Math.min(59, Math.max(0, Number(m[2])))];
}

function matchesSchedule(utcDate: Date, schedule: RoutineSchedule, timezone: string): boolean {
  const parts = wallClockParts(utcDate, timezone);
  if (schedule.kind === 'daily') return true;
  if (schedule.kind === 'weekly') return schedule.days.includes(parts.weekday);
  if (schedule.kind === 'monthly') return parts.day === schedule.dayOfMonth;
  return false;
}

/**
 * Build a UTC Date for "today + dayOffset" at hour:minute in `timezone`.
 * The returned Date represents the same instant as the wall clock time in the
 * target timezone.
 */
function wallClockInTzPlusDays(reference: Date, dayOffset: number, hour: number, minute: number, timezone: string): Date {
  const refParts = wallClockParts(reference, timezone);
  // Construct a Date for the target wall-clock day in the target TZ.
  // Step 1: build a candidate UTC Date assuming the wall clock IS UTC.
  const targetUtc = new Date(Date.UTC(refParts.year, refParts.month - 1, refParts.day + dayOffset, hour, minute));
  // Step 2: find the offset for that instant in the target TZ.
  const offsetMin = tzOffsetMinutes(targetUtc, timezone);
  // Step 3: subtract the offset to get the actual UTC instant whose wall clock
  // in `timezone` is hour:minute on that day.
  return new Date(targetUtc.getTime() - offsetMin * 60_000);
}

type WallClockParts = { year: number; month: number; day: number; hour: number; minute: number; weekday: number };

function wallClockParts(date: Date, timezone: string): WallClockParts {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    weekday: 'short',
  });
  const parts = dtf.formatToParts(date);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '';
  const weekdayMap: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  return {
    year: Number(get('year')),
    month: Number(get('month')),
    day: Number(get('day')),
    hour: Number(get('hour')) % 24,
    minute: Number(get('minute')),
    weekday: weekdayMap[get('weekday')] ?? 0,
  };
}

/**
 * Offset in minutes east of UTC for `date` interpreted in `timezone`.
 * E.g., for America/New_York in winter returns -300 (EST = UTC-5).
 */
function tzOffsetMinutes(date: Date, timezone: string): number {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
  const parts = dtf.formatToParts(date);
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value);
  const asUtc = Date.UTC(
    get('year'),
    get('month') - 1,
    get('day'),
    get('hour') === 24 ? 0 : get('hour'),
    get('minute'),
    get('second'),
  );
  return Math.round((asUtc - date.getTime()) / 60_000);
}

export function describeSchedule(schedule: RoutineSchedule, timezone: string): string {
  const tzShort = timezone.split('/').pop()?.replace(/_/g, ' ') ?? timezone;
  if (schedule.kind === 'daily') return `Daily at ${schedule.time} ${tzShort}`;
  if (schedule.kind === 'weekly') {
    const names = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
    const days = schedule.days.map((d) => names[d]).join(', ');
    return `${days} at ${schedule.time} ${tzShort}`;
  }
  if (schedule.kind === 'monthly') return `Day ${schedule.dayOfMonth} of each month at ${schedule.time} ${tzShort}`;
  return 'Custom schedule';
}

export function validateSchedule(s: unknown): RoutineSchedule | null {
  if (!s || typeof s !== 'object') return null;
  const obj = s as Record<string, unknown>;
  const time = obj.time;
  if (typeof time !== 'string' || !/^\d{1,2}:\d{2}$/.test(time)) return null;
  if (obj.kind === 'daily') return { kind: 'daily', time };
  if (obj.kind === 'weekly') {
    if (!Array.isArray(obj.days) || obj.days.length === 0) return null;
    const days = (obj.days as unknown[]).filter((d): d is number => typeof d === 'number' && d >= 0 && d <= 6);
    if (days.length === 0) return null;
    return { kind: 'weekly', days, time };
  }
  if (obj.kind === 'monthly') {
    const dom = Number(obj.dayOfMonth);
    if (!Number.isInteger(dom) || dom < 1 || dom > 28) return null;
    return { kind: 'monthly', dayOfMonth: dom, time };
  }
  return null;
}
