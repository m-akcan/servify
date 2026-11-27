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
  return dueAt(c, wallTime(d, tz), () => wallTime(new Date(d.getTime() - 60_000), tz), lastFired);
}

/** cronDue on wall times: `now`, and the minute before it (only asked for when needed: an Intl call). */
function dueAt(c: Cron, now: Wall, before: () => Wall, lastFired?: string | null): string | null {
  const key = wallKey(now);
  // Only jobs set for certain hours are tied to the clock. "Every hour" or "every 15 minutes" simply keeps its
  // rhythm through a clock change (as cron does): it runs in the repeated hour too, and nothing needs catching up.
  const fixedTime = c.fields[1].size < 24;
  if (matchesWall(c, now)) return fixedTime && key === lastFired ? null : key;
  if (!fixedTime) return null;
  // Did the wall clock jump forward since the minute before? Then look at the minutes that never happened.
  const prev = before();
  const gap = wallMinutes(now) - wallMinutes(prev) - 1;
  if (gap <= 0 || gap > 180) return null;
  for (let i = 1; i <= gap; i++) {
    const t = new Date((wallMinutes(prev) + i) * 60_000);
    const skipped: Wall = { year: t.getUTCFullYear(), month: t.getUTCMonth() + 1, day: t.getUTCDate(), hour: t.getUTCHours(), minute: t.getUTCMinutes(), dow: t.getUTCDay() };
    if (matchesWall(c, skipped)) return key === lastFired ? null : key;
  }
  return null;
}

// ───────────────────────────── missed runs (catch-up) ─────────────────────────────

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
/** The start of the minute `ms` falls in. */
export const minuteOf = (ms: number) => Math.floor(ms / MINUTE) * MINUTE;
/** The default catch-up window is never longer than this (and the look back for missed runs never shorter). */
export const MAX_CATCHUP_WINDOW_MS = 24 * HOUR;

/**
 * The starts a schedule had in the minutes after `afterMs` and before `beforeMs` (minute starts, neither included) —
 * exactly as cronDue would have made them minute by minute, from `lastFired` on, so a repeated hour counts once and a
 * skipped one once. Looks back at most `maxBackMs` from `beforeMs` (`truncated` says the gap was longer).
 */
export function missedRuns(c: Cron, afterMs: number, beforeMs: number, tz: string | null | undefined, lastFired: string | null | undefined, maxBackMs = MAX_CATCHUP_WINDOW_MS) {
  const first = Math.max(minuteOf(afterMs) + MINUTE, minuteOf(beforeMs) - maxBackMs);
  const slots: number[] = [];
  let fired = lastFired ?? null;
  let prev: Wall | null = null;
  for (let t = first; t < minuteOf(beforeMs); t += MINUTE) {
    const w = wallTime(new Date(t), tz);
    const p = prev;
    const due = dueAt(c, w, () => p ?? wallTime(new Date(t - MINUTE), tz), fired);
    prev = w;
    if (!due) continue;
    fired = due;
    slots.push(t);
  }
  return { slots, lastFired: fired, truncated: first > minuteOf(afterMs) + MINUTE };
}

/** The first start after `fromMs` (not included), ignoring clock changes; null if none within a year. */
function nextMatch(c: Cron, fromMs: number, tz?: string | null): number | null {
  const start = minuteOf(fromMs) + MINUTE;
  // Walk by the minute, but skip whole days whose date can't match (a time zone costs an Intl call per step).
  for (let t = start, i = 0; i < 366 * 24 * 60; ) {
    const w = wallTime(new Date(t), tz);
    if (matchesWall(c, w)) return t;
    const dayOk = c.fields[3].has(w.month) && (c.domStar && c.dowStar ? true : c.domStar ? c.fields[4].has(w.dow) : c.dowStar ? c.fields[2].has(w.day) : c.fields[2].has(w.day) || c.fields[4].has(w.dow));
    // Not today: jump to (just before) the next midnight on the wall, minus an hour of slack for clock changes.
    const step = dayOk ? (c.fields[1].has(w.hour) ? 1 : 60 - w.minute) : Math.max(1, (23 - w.hour) * 60 + (60 - w.minute) - 60);
    t += step * MINUTE;
    i += step;
  }
  return null;
}

/**
 * How long after a missed start it is still worth running it late: half the time to the start after it (past that,
 * the next regular run is nearer than the missed one), at most 24 h. A daily job catches up for 12 h, an hourly one
 * for 30 min, an every-minute one never (30 s: by then its next run is already due). `overrideMs` replaces the rule.
 */
export function catchUpWindowMs(c: Cron, slotMs: number, tz?: string | null, overrideMs?: number | null): number {
  if (overrideMs != null && overrideMs >= 0) return overrideMs;
  let next = nextMatch(c, slotMs, tz);
  // The repeated hour when clocks go back is not a start of a job set for certain hours (cronDue): the one after it is.
  const key = wallKey(wallTime(new Date(slotMs), tz));
  if (next !== null && c.fields[1].size < 24 && wallKey(wallTime(new Date(next), tz)) === key) next = nextMatch(c, next, tz);
  return next === null ? MAX_CATCHUP_WINDOW_MS : Math.min(MAX_CATCHUP_WINDOW_MS, (next - slotMs) / 2);
}

/**
 * What the scheduler finds at `now` after not looking since `afterMs` (Servify was stopped, the machine slept): the
 * starts it missed, and whether the newest of them gets its one catch-up run — only when it is inside its window and
 * the schedule isn't due this very minute anyway (that regular run covers it; never two at once). `lastFired` and
 * `afterMs` come from what last ran, so a start that did happen is never missed.
 */
export function catchUpPlan(c: Cron, tz: string | null | undefined, o: { afterMs: number; now: Date; lastFired?: string | null; windowMs?: number | null }) {
  const m = missedRuns(c, o.afterMs, o.now.getTime(), tz, o.lastFired, Math.max(MAX_CATCHUP_WINDOW_MS, o.windowMs ?? 0));
  const last = m.slots.length ? m.slots[m.slots.length - 1] : null;
  const dueNow = cronDue(c, o.now, tz, m.lastFired) !== null;
  const windowMs = last === null ? null : catchUpWindowMs(c, last, tz, o.windowMs);
  const catchUp = last !== null && windowMs !== null && !dueNow && o.now.getTime() - last <= windowMs;
  return { missed: m.slots.length, truncated: m.truncated, last, lastFired: m.lastFired, dueNow, windowMs, catchUp };
}

/** expr|tz → the next start, and the moment it was worked out from (good for any later moment before that start). */
const nextCache = new Map<string, { from: number; at: number | null }>();

export function nextRun(expr: string, from = new Date(), tz?: string | null): Date | null {
  let c: Cron;
  try {
    c = parseCron(expr);
  } catch {
    return null;
  }
  // Asked for on every serialised service: remember the answer until that moment has passed. Only for moments at or
  // after the one it was worked out from — an earlier `from` may have an earlier next start.
  const cacheKey = `${expr}|${tz ?? ''}`;
  const hit = nextCache.get(cacheKey);
  const t = from.getTime();
  if (hit && typeof hit.at === 'number' && hit.from <= t && hit.at > t) return new Date(hit.at);
  const found = nextMatch(c, t, tz);
  if (nextCache.size > 500) nextCache.clear();
  nextCache.set(cacheKey, { from: t, at: found });
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
