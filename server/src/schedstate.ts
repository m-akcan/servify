/**
 * What the schedulers (cron jobs, scheduled backups and test restores) remember across restarts, and the two things
 * built on it:
 *
 *  • Catch-up. Each scheduler writes a heartbeat (the minute it last looked at the clock). After a gap — Servify was
 *    stopped, the machine slept — the minutes in between are replayed through cronDue to find the starts that were
 *    missed. The newest one gets at most one late run, while it is inside its window (cron.ts catchUpWindowMs) and the
 *    schedule isn't due right now anyway. A start that couldn't happen because its server was offline waits the same
 *    way. Per schedule: `lastSlot` (the minute it last started for) and `lastFired` (its wall time, for clock changes)
 *    make sure a start that did happen is never run again.
 *  • Failure streaks. A failing schedule notifies on its first failure, then stays quiet while it keeps failing — but
 *    for a reminder every few hours (settings → alerts.failureRemindHours) — and says once when it works again.
 *    Every run is still recorded; only the notifications are spared.
 *
 * Kept in kv rows (`sched.<kind>.<serviceId>`), cached here and written through on every change.
 */
import { db, kv, services as servicesTable } from './db.ts';
import { bus } from './events.ts';
import { notify, type Notice } from './notify.ts';
import { getSettings } from './settings.ts';
import { catchUpPlan, catchUpWindowMs, cronDue, minuteOf, parseCron } from './cron.ts';

export type SchedKind = 'job' | 'backup' | 'test';

export type FailStreak = {
  /** When the first failure of this streak finished. */
  since: number;
  /** Failed runs in a row. */
  count: number;
  /** When a notification last went out for this streak (null: none did — channels then say nothing on recovery either). */
  notifiedAt: number | null;
  reminders: number;
};

/** A start that was missed and may still get its catch-up run. */
export type PendingCatchUp = {
  /** The minute it was due. */
  slot: number;
  /** How many starts were missed (the catch-up is one run for all of them). */
  missed: number;
  /** down: Servify wasn't running (or looking); blocked: it was due, but couldn't start (its server offline…). */
  reason: 'down' | 'blocked';
  truncated?: boolean;
};

export type SchedState = {
  lastFired?: string | null;
  lastSlot?: number | null;
  pending?: PendingCatchUp | null;
  failing?: FailStreak | null;
};

export type CatchUpInfo = { dueAt: number; missed: number };

const cache = new Map<string, SchedState>();
const keyOf = (kind: SchedKind, id: string) => `sched.${kind}.${id}`;

export function schedState(kind: SchedKind, id: string): SchedState {
  const k = keyOf(kind, id);
  let s = cache.get(k);
  if (!s) {
    try {
      s = JSON.parse(kv.get(k) ?? '{}') as SchedState;
    } catch {
      s = {};
    }
    cache.set(k, s);
  }
  return s;
}

/** Read, change and write back in one go (synchronous: a run finishing meanwhile can't overwrite what the tick wrote). */
export function updateSchedState(kind: SchedKind, id: string, fn: (s: SchedState) => void) {
  const before = schedState(kind, id);
  const s = structuredClone(before);
  fn(s);
  cache.set(keyOf(kind, id), s);
  kv.set(keyOf(kind, id), JSON.stringify(s));
  // What the dashboard shows (failing since…, a catch-up waiting) changed: send the service again.
  if (JSON.stringify([before.failing ?? null, before.pending ?? null]) !== JSON.stringify([s.failing ?? null, s.pending ?? null])) {
    const svc = servicesTable.get(id);
    if (svc) bus.publish({ type: 'service.updated', service: svc });
  }
}

/** Rows of services that no longer exist (called at startup). */
export function pruneSchedState(exists: (serviceId: string) => boolean) {
  for (const { key } of db.prepare(`SELECT key FROM kv WHERE key LIKE 'sched.%'`).all() as { key: string }[]) {
    const m = /^sched\.(job|backup|test)\.(.+)$/.exec(key);
    if (m && !exists(m[2])) {
      kv.delete(key);
      cache.delete(key);
    }
  }
}

// ───────────────────────────── heartbeat ─────────────────────────────

export function readBeat(scheduler: string): number | null {
  const v = Number(kv.get(`sched.beat.${scheduler}`));
  return Number.isFinite(v) && v > 0 ? v : null;
}
export function writeBeat(scheduler: string, minute: number) {
  kv.set(`sched.beat.${scheduler}`, String(minute));
}

// ───────────────────────────── one schedule, one tick ─────────────────────────────

/** SERVIFY_CATCHUP_WINDOW_MINUTES replaces the default window (half the interval, at most 24 h) for every schedule. */
export function catchUpWindowOverride(): number | null {
  const v = process.env.SERVIFY_CATCHUP_WINDOW_MINUTES;
  if (v === undefined || v.trim() === '') return null;
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n * 60_000 : null;
}

/** A catch-up waits this long after Servify starts: services are adopted and connected servers come back meanwhile. */
const GRACE_MS = Number(process.env.SERVIFY_CATCHUP_GRACE_SECONDS ?? 20) * 1000;
const bootedAt = Date.now();

export type ScheduleHooks = {
  /** Still running from before: this start is skipped. */
  busy(): string | null;
  /** Why it can't start now at all (its server is offline…), or null. */
  blocked(): string | null;
  /** What a catch-up run waits for besides (a database to be running…), or null when ready. */
  notReady?(): string | null;
  start(catchUp: CatchUpInfo | null): void;
  /** A start that didn't happen, with why (recorded where the schedule's history is). */
  skip(reason: string): void;
};

export type ScheduleInput = { kind: SchedKind; id: string; expr: string; tz?: string | null; catchUp: boolean };

const when = (ms: number) => new Date(ms).toLocaleString();
export const fmtWindow = (ms: number) => (ms >= 3_600_000 ? `${+(ms / 3_600_000).toFixed(1)} h` : ms >= 60_000 ? `${Math.round(ms / 60_000)} min` : `${Math.round(ms / 1000)} s`);

/**
 * One scheduler tick for one schedule. `prevMinute`: the minute this scheduler looked last (the previous process's
 * heartbeat on its first tick; null on a fresh install or the first start of a version that kept none — nothing is
 * caught up then). `newMinute`: the start of a minute (due checks); in between, only a waiting catch-up is retried.
 */
export function stepSchedule(s: ScheduleInput, now: Date, prevMinute: number | null, newMinute: boolean, h: ScheduleHooks) {
  const c = parseCron(s.expr);
  const M = minuteOf(now.getTime());
  const st = schedState(s.kind, s.id);
  if (newMinute) {
    // 1. Minutes nobody looked at: what was due then?
    const after = Math.max(prevMinute ?? -Infinity, st.lastSlot ?? -Infinity);
    if (prevMinute !== null && Number.isFinite(after) && M - after > 60_000) {
      const plan = catchUpPlan(c, s.tz, { afterMs: after, now, lastFired: st.lastFired, windowMs: catchUpWindowOverride() });
      if (plan.missed && plan.last !== null) {
        const earlier = st.pending?.reason === 'down' ? st.pending.missed : 0;
        updateSchedState(s.kind, s.id, (x) => {
          x.lastFired = plan.lastFired;
          x.lastSlot = plan.last;
          x.pending = { slot: plan.last!, missed: plan.missed + earlier, reason: 'down', ...(plan.truncated ? { truncated: true } : {}) };
        });
      }
    }
    // 2. This minute. Never twice for the same minute (a restart within it).
    const cur = schedState(s.kind, s.id);
    const due = cur.lastSlot === M ? null : cronDue(c, now, s.tz, cur.lastFired);
    if (due) {
      // A regular start supersedes a waiting catch-up: never two runs for one gap.
      updateSchedState(s.kind, s.id, (x) => {
        x.lastFired = due;
        x.lastSlot = M;
        x.pending = null;
      });
      const busy = h.busy();
      if (busy) return h.skip(busy);
      const blocked = h.blocked();
      if (blocked) {
        if (s.catchUp) updateSchedState(s.kind, s.id, (x) => (x.pending = { slot: M, missed: 1, reason: 'blocked' }));
        return h.skip(`${blocked}${s.catchUp ? ' — it runs once when that is over, if within its catch-up window' : ''}`);
      }
      return h.start(null);
    }
  }
  // 3. A missed start waiting for its catch-up run.
  const p = schedState(s.kind, s.id).pending;
  if (!p) return;
  const runs = `${p.truncated ? 'at least ' : ''}${p.missed} run${p.missed === 1 ? '' : 's'}`;
  const missedText = p.reason === 'down' ? `missed ${runs} while Servify wasn't running (last due ${when(p.slot)})` : `the run due ${when(p.slot)} couldn't start`;
  const clear = () => updateSchedState(s.kind, s.id, (x) => (x.pending = null));
  if (!s.catchUp) {
    clear();
    if (p.reason === 'down') h.skip(`${missedText} — catch-up is off`);
    return;
  }
  const win = catchUpWindowMs(c, p.slot, s.tz, catchUpWindowOverride());
  if (now.getTime() - p.slot > win) {
    clear();
    h.skip(`${missedText} — not caught up: more than ${fmtWindow(win)} ago (its catch-up window)`);
    return;
  }
  if (Date.now() - bootedAt < GRACE_MS) return;
  if (h.busy() || h.blocked() || h.notReady?.()) return; // keeps waiting, within the window
  clear();
  h.start({ dueAt: p.slot, missed: p.missed });
}

/** Whether any schedule of this kind waits for a catch-up (between minutes, the schedulers only look when one does). */
export function anyPending(kind: SchedKind): boolean {
  for (const [k, v] of cache) if (v.pending && k.startsWith(`sched.${kind}.`)) return true;
  return false;
}

/** A schedule that is off or stopped forgets a missed start: starting it again doesn't run it late. */
export function dropPending(kind: SchedKind, id: string) {
  if (schedState(kind, id).pending) updateSchedState(kind, id, (x) => (x.pending = null));
}

/** For the dashboard and API. */
export function scheduleInfo(kind: SchedKind, id: string) {
  const st = schedState(kind, id);
  return { failing: st.failing ?? null, pendingCatchUp: st.pending ? { dueAt: st.pending.slot, missed: st.pending.missed } : null };
}

// ───────────────────────────── failure streaks ─────────────────────────────

export function failureRemindMs(): number {
  const h = getSettings().alerts.failureRemindHours ?? 24;
  return h > 0 ? h * 3_600_000 : 0;
}

/**
 * The outcome of a run of a schedule. `failure`: the notice for a failure (its title names the job); sent for the
 * first failure of a streak, then as a reminder every `failureRemindHours` while it keeps failing. A success after a
 * notified failure sends one "recovered" notice on the same event (channels that hear about the failure hear it's over).
 */
export function reportOutcome(kind: SchedKind, id: string, ok: boolean, n: { failure: Notice; subject: string; project?: string }) {
  const now = Date.now();
  const st = schedState(kind, id);
  if (ok) {
    const f = st.failing;
    if (!f) return;
    updateSchedState(kind, id, (x) => (x.failing = null));
    if (f.notifiedAt === null) return;
    notify({
      ...n.failure,
      level: 'success',
      title: `${n.subject} recovered`,
      message: `${n.project ? `${n.project}: ` : ''}succeeded again after ${f.count} failed run${f.count === 1 ? '' : 's'} (failing since ${when(f.since)}).`,
    });
    return;
  }
  const f: FailStreak = st.failing ? { ...st.failing, count: st.failing.count + 1 } : { since: now, count: 1, notifiedAt: null, reminders: 0 };
  const remind = failureRemindMs();
  let send: Notice | null = null;
  if (f.notifiedAt === null) send = f.count === 1 ? n.failure : { ...n.failure, title: `${n.failure.title} (${f.count} failures in a row)` };
  else if (remind && now - f.notifiedAt >= remind) {
    send = { ...n.failure, title: `${n.subject} is still failing`, message: `${f.count} failed runs in a row since ${when(f.since)}. Latest:\n\n${n.failure.message}` };
    f.reminders++;
  }
  if (send) f.notifiedAt = now;
  updateSchedState(kind, id, (x) => (x.failing = f));
  if (send) notify(send);
}
