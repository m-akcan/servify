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

function parseField(src: string, [lo, hi]: [number, number]): Set<number> {
  const out = new Set<number>();
  for (const part of src.split(',')) {
    const [range, stepStr] = part.split('/');
    const step = stepStr ? Number(stepStr) : 1;
    if (!Number.isInteger(step) || step < 1) throw new Error(`bad step in "${part}"`);
    let a: number;
    let b: number;
    if (range === '*') [a, b] = [lo, hi];
    else if (range.includes('-')) [a, b] = range.split('-').map(Number) as [number, number];
    else {
      a = Number(range);
      b = stepStr ? hi : a;
    }
    if (!Number.isInteger(a) || !Number.isInteger(b) || a < lo || b > hi || a > b) throw new Error(`"${part}" out of range ${lo}-${hi}`);
    for (let v = a; v <= b; v += step) out.add(v === 7 && hi === 6 ? 0 : v);
  }
  return out;
}

export function parseCron(expr: string): Cron {
  const e = MACROS[expr.trim()] ?? expr.trim();
  const parts = e.split(/\s+/);
  if (parts.length !== 5) throw new Error('cron needs 5 fields: minute hour day month weekday');
  const fields = parts.map((p, i) => parseField(p.replace(/^7$/, '0'), i === 4 ? [0, 7] : RANGES[i]));
  fields[4] = new Set([...fields[4]].map((d) => (d === 7 ? 0 : d)));
  return { fields, domStar: parts[2] === '*', dowStar: parts[4] === '*' };
}

export function cronMatches(c: Cron, d: Date): boolean {
  const [min, hr, dom, mon, dow] = c.fields;
  if (!min.has(d.getMinutes()) || !hr.has(d.getHours()) || !mon.has(d.getMonth() + 1)) return false;
  // Standard cron: if both day fields are restricted, either may match.
  const domOk = dom.has(d.getDate());
  const dowOk = dow.has(d.getDay());
  if (c.domStar && c.dowStar) return true;
  if (c.domStar) return dowOk;
  if (c.dowStar) return domOk;
  return domOk || dowOk;
}

export function nextRun(expr: string, from = new Date()): Date | null {
  let c: Cron;
  try {
    c = parseCron(expr);
  } catch {
    return null;
  }
  const d = new Date(from);
  d.setSeconds(0, 0);
  d.setMinutes(d.getMinutes() + 1);
  for (let i = 0; i < 366 * 24 * 60; i++) {
    if (cronMatches(c, d)) return d;
    d.setMinutes(d.getMinutes() + 1);
  }
  return null;
}

export function validateCron(expr: string): string | null {
  try {
    parseCron(expr);
    return null;
  } catch (e) {
    return (e as Error).message;
  }
}
