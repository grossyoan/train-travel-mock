/**
 * Local time for IANA time zones, with nothing but Intl: trains run on station time,
 * so timetables are built and displayed in the local time of each station.
 */

const MINUTE = 60_000;
const DAY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
/** A date-time without a UTC offset, as an HTML datetime-local input sends it. */
const NAIVE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?$/;

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatter(timeZone: string): Intl.DateTimeFormat {
  let cached = formatters.get(timeZone);
  if (!cached) {
    cached = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
    formatters.set(timeZone, cached);
  }
  return cached;
}

interface WallClock {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

function wallClock(instant: Date, timeZone: string): WallClock {
  const parts = Object.fromEntries(
    formatter(timeZone)
      .formatToParts(instant)
      .map((part) => [part.type, Number(part.value)]),
  );
  return {
    year: parts.year ?? 0,
    month: parts.month ?? 0,
    day: parts.day ?? 0,
    hour: parts.hour ?? 0,
    minute: parts.minute ?? 0,
    second: parts.second ?? 0,
  };
}

/** Minutes to add to UTC to get the zone's local time at `instant` (+60 for Paris in winter). */
function offsetMinutes(instant: Date, timeZone: string): number {
  const local = wallClock(instant, timeZone);
  const asUtc = Date.UTC(local.year, local.month - 1, local.day, local.hour, local.minute, local.second);
  return Math.round((asUtc - Math.floor(instant.getTime() / 1000) * 1000) / MINUTE);
}

/**
 * The instant at which the zone's clock shows the given wall time. Two passes settle the
 * offset across daylight saving changes; a wall time skipped by the spring change
 * resolves to the instant just after it, as clocks do.
 */
function fromWallClock(year: number, month: number, day: number, minutes: number, timeZone: string): Date {
  const naive = Date.UTC(year, month - 1, day) + minutes * MINUTE;
  let instant = naive - offsetMinutes(new Date(naive), timeZone) * MINUTE;
  instant = naive - offsetMinutes(new Date(instant), timeZone) * MINUTE;
  return new Date(instant);
}

const pad = (value: number) => String(value).padStart(2, "0");

/** "2026-07-15T09:00:00+02:00": the instant as the zone's clock shows it. */
export function formatInZone(instant: Date, timeZone: string): string {
  const local = wallClock(instant, timeZone);
  const offset = offsetMinutes(instant, timeZone);
  const sign = offset < 0 ? "-" : "+";
  const absolute = Math.abs(offset);
  return `${local.year}-${pad(local.month)}-${pad(local.day)}T${pad(local.hour)}:${pad(local.minute)}:${pad(local.second)}${sign}${pad(Math.floor(absolute / 60))}:${pad(absolute % 60)}`;
}

/** The calendar day ("2026-07-15") the zone's clock shows at `instant`. */
export function localDay(instant: Date, timeZone: string): string {
  const local = wallClock(instant, timeZone);
  return `${local.year}-${pad(local.month)}-${pad(local.day)}`;
}

/** The instant of `minutes` after local midnight on `day` in the zone. */
export function atLocalTime(day: string, minutes: number, timeZone: string): Date {
  const [year = 0, month = 1, date = 1] = day.split("-").map(Number);
  return fromWallClock(year, month, date, minutes, timeZone);
}

export function addDays(day: string, days: number): string {
  const [year = 0, month = 1, date = 1] = day.split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, date + days)).toISOString().slice(0, 10);
}

/**
 * Reads a date for a station: a day alone means local midnight, a date-time without
 * offset is local time, and anything with an offset or `Z` is taken as is.
 */
export function parseDateInZone(value: string, timeZone: string): Date | undefined {
  const trimmed = value.trim();
  if (DAY_PATTERN.test(trimmed)) return atLocalTime(trimmed, 0, timeZone);
  const naive = NAIVE_PATTERN.exec(trimmed);
  if (naive) {
    // Seconds are optional: an absent group is undefined, which Number() would turn into NaN.
    const [, year = 0, month = 1, day = 1, hour = 0, minute = 0, second = 0] = naive.map((group) =>
      group === undefined ? undefined : Number(group),
    );
    return fromWallClock(year, month, day, hour * 60 + minute + second / 60, timeZone);
  }
  const timestamp = Date.parse(trimmed);
  return Number.isNaN(timestamp) ? undefined : new Date(timestamp);
}
