/** Minimal 5-field cron: minute hour day-of-month month day-of-week, with * , - / and @macros. */

const MACROS: Record<string, string> = {
  '@yearly': '0 0 1 1 *',
  '@annually': '0 0 1 1 *',
  '@monthly': '0 0 1 * *',
  '@weekly': '0 0 * * 0',
  '@daily': '0 0 * * *',
  '@midnight': '0 0 * * *',
  '@hourly': '0 * * * *',
};

const RANGES: [number, number][] = [
  [0, 59],
  [0, 23],
  [1, 31],
  [1, 12],
  [0, 6],
];

export type Cron = { fields: Set<number>[]; domStar: boolean; dowStar: boolean };

/**
 * `strict` is for new input: whole numbers only, one "-" per range, digits for a step. Schedules stored before
 * that check existed are still read the lenient way, so a job that ran yesterday runs today.
 */
function parseField(src: string, [lo, hi]: [number, number], strict = false): Set<number> {
  const out = new Set<number>();
  const num = (v: string) => (strict && !/^\d+$/.test(v) ? NaN : Number(v));
  for (const part of src.split(',')) {
    if (strict && !part) throw new Error(`empty value in "${src}"`);
    const pieces = part.split('/');
    if (strict && pieces.length > 2) throw new Error(`bad step in "${part}"`);
    const [range, stepStr] = pieces;
    const step = stepStr !== undefined && (strict || stepStr) ? num(stepStr) : 1;
    if (!Number.isInteger(step) || step < 1) throw new Error(`bad step in "${part}"`);
    let a: number;
    let b: number;
    if (range === '*') [a, b] = [lo, hi];
    else if (range.includes('-')) {
      const ends = range.split('-');
      if (strict && ends.length !== 2) throw new Error(`bad range in "${part}"`);
      [a, b] = ends.map(num) as [number, number];
    } else {
      a = num(range);
      b = stepStr ? hi : a;
    }
    if (!Number.isInteger(a) || !Number.isInteger(b) || a < lo || b > hi || a > b) throw new Error(`"${part}" out of range ${lo}-${hi}`);
    for (let v = a; v <= b; v += step) out.add(v === 7 && hi === 6 ? 0 : v);
  }
  return out;
}

export function parseCron(expr: string, strict = false): Cron {
  const e = MACROS[expr.trim()] ?? expr.trim();
  const parts = e.split(/\s+/);
  if (parts.length !== 5) throw new Error('cron needs 5 fields: minute hour day month weekday');
  const fields = parts.map((p, i) => parseField(p.replace(/^7$/, '0'), i === 4 ? [0, 7] : RANGES[i], strict));
  fields[4] = new Set([...fields[4]].map((d) => (d === 7 ? 0 : d)));
  return { fields, domStar: parts[2] === '*', dowStar: parts[4] === '*' };
}

// ───────────────────────────── wall-clock time ─────────────────────────────

/** A moment as the clock on the wall shows it, in a time zone (or the server's own when none is given). */
export type Wall = { year: number; month: number; day: number; hour: number; minute: number; dow: number };

const formats = new Map<string, Intl.DateTimeFormat>();
/** Null for a name Intl doesn't know. */
function formatFor(tz: string): Intl.DateTimeFormat | null {
  let f = formats.get(tz);
  if (!f) {
    try {
      f = new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', weekday: 'short' });
    } catch {
      return null;
    }
    formats.set(tz, f);
  }
  return f;
}
const DOW: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

export function validTimeZone(tz: string): boolean {
  return !!tz && !!formatFor(tz);
}

/** An unknown zone falls back to the server's time (a job should rather run than silently never run). */
export function wallTime(d: Date, tz?: string | null): Wall {
  const f = tz ? formatFor(tz) : null;
  if (!f) return { year: d.getFullYear(), month: d.getMonth() + 1, day: d.getDate(), hour: d.getHours(), minute: d.getMinutes(), dow: d.getDay() };
  const p: Record<string, string> = {};
  for (const x of f.formatToParts(d)) p[x.type] = x.value;
  return { year: Number(p.year), month: Number(p.month), day: Number(p.day), hour: Number(p.hour) % 24, minute: Number(p.minute), dow: DOW[p.weekday] ?? 0 };
}

const wallKey = (w: Wall) => `${w.year}-${w.month}-${w.day} ${w.hour}:${w.minute}`;
/** Minutes since a fixed day, as if the wall clock were UTC: for telling how far two wall times are apart. */
const wallMinutes = (w: Wall) => Date.UTC(w.year, w.month - 1, w.day, w.hour, w.minute) / 60_000;

function matchesWall(c: Cron, w: Wall): boolean {
  const [min, hr, dom, mon, dow] = c.fields;
  if (!min.has(w.minute) || !hr.has(w.hour) || !mon.has(w.month)) return false;
  // Standard cron: if both day fields are restricted, either may match.
  const domOk = dom.has(w.day);
  const dowOk = dow.has(w.dow);
  if (c.domStar && c.dowStar) return true;
  if (c.domStar) return dowOk;
  if (c.dowStar) return domOk;
  return domOk || dowOk;
}

export function cronMatches(c: Cron, d: Date, tz?: string | null): boolean {
  return matchesWall(c, wallTime(d, tz));
}

/**
 * Should a job with this schedule start in the minute of `d`? Like cronMatches, plus the two days a year the clock
 * changes:
 * (jobs set for certain hours only — see below)
 *  - clocks go back (02:30 comes twice): the job runs the first time only. `lastFired` is the wall time it last
 *    started at, as returned by this function; pass it back in.
 *  - clocks go forward (02:30 never comes): a job scheduled inside the skipped hour runs right after it, once.
 * Returns the wall time to remember when the job should start, else null.
 */
export function cronDue(c: Cron, d: Date, tz?: string | null, lastFired?: string | null): string | null {
  const now = wallTime(d, tz);
  const key = wallKey(now);
  // Only jobs set for certain hours are tied to the clock. "Every hour" or "every 15 minutes" simply keeps its
  // rhythm through a clock change (as cron does): it runs in the repeated hour too, and nothing needs catching up.
  const fixedTime = c.fields[1].size < 24;
  if (matchesWall(c, now)) return fixedTime && key === lastFired ? null : key;
  if (!fixedTime) return null;
  // Did the wall clock jump forward since the minute before? Then look at the minutes that never happened.
  const before = wallTime(new Date(d.getTime() - 60_000), tz);
  const gap = wallMinutes(now) - wallMinutes(before) - 1;
  if (gap <= 0 || gap > 180) return null;
  for (let i = 1; i <= gap; i++) {
    const t = new Date((wallMinutes(before) + i) * 60_000);
    const skipped: Wall = { year: t.getUTCFullYear(), month: t.getUTCMonth() + 1, day: t.getUTCDate(), hour: t.getUTCHours(), minute: t.getUTCMinutes(), dow: t.getUTCDay() };
    if (matchesWall(c, skipped)) return key === lastFired ? null : key;
  }
  return null;
}

const nextCache = new Map<string, number | null>();

export function nextRun(expr: string, from = new Date(), tz?: string | null): Date | null {
  let c: Cron;
  try {
    c = parseCron(expr);
  } catch {
    return null;
  }
  // Asked for on every serialised service: remember the answer until that moment has passed.
  const cacheKey = `${expr}|${tz ?? ''}`;
  const hit = nextCache.get(cacheKey);
  if (typeof hit === 'number' && hit > from.getTime()) return new Date(hit);
  const start = Math.floor(from.getTime() / 60_000) * 60_000 + 60_000;
  let found: number | null = null;
  // Walk by the minute, but skip whole days whose date can't match (a time zone costs an Intl call per step).
  for (let t = start, i = 0; i < 366 * 24 * 60; ) {
    const d = new Date(t);
    const w = wallTime(d, tz);
    if (matchesWall(c, w)) {
      found = t;
      break;
    }
    const dayOk = c.fields[3].has(w.month) && (c.domStar && c.dowStar ? true : c.domStar ? c.fields[4].has(w.dow) : c.dowStar ? c.fields[2].has(w.day) : c.fields[2].has(w.day) || c.fields[4].has(w.dow));
    // Not today: jump to (just before) the next midnight on the wall, minus an hour of slack for clock changes.
    const step = dayOk ? (c.fields[1].has(w.hour) ? 1 : 60 - w.minute) : Math.max(1, (23 - w.hour) * 60 + (60 - w.minute) - 60);
    t += step * 60_000;
    i += step;
  }
  if (nextCache.size > 500) nextCache.clear();
  nextCache.set(cacheKey, found);
  return found === null ? null : new Date(found);
}

/** For new input: strict (see parseField). */
export function validateCron(expr: string): string | null {
  try {
    parseCron(expr, true);
    return null;
  } catch (e) {
    return (e as Error).message;
  }
}
