/**
 * Failed sign-in bookkeeping, per client address (IPv6 by /64). No imports and an injectable clock, so the acceptance
 * tests can check the arithmetic directly.
 *
 *  - The first FREE failures in a row cost nothing. Each one after that locks the address for twice as long as the
 *    one before (1 s, 2 s, 4 s … at most MAX_LOCK). Locked addresses get a 429 before any password is checked, so a
 *    locked-out attacker learns nothing and costs no hashing.
 *  - At most DAILY failures per address in any 24 hours; past that it is locked until the oldest one is a day old.
 *  - A success resets the address. A day without failures forgets it.
 *  - Global: failures from all addresses in the last minute. Above GLOBAL_FREE, each password check waits a little
 *    longer (never more than MAX_DELAY) — slowed down, never refused, so the owner on a fresh address still gets in.
 */
export type ThrottleLimits = { free: number; maxLockMs: number; daily: number; globalFree: number; maxDelayMs: number; maxKeys: number };

export const DEFAULT_LIMITS: ThrottleLimits = { free: 5, maxLockMs: 15 * 60_000, daily: 50, globalFree: 30, maxDelayMs: 5_000, maxKeys: 20_000 };

type Entry = { streak: number; lockedUntil: number; day: number[]; last: number };

export class FailureThrottle {
  private m = new Map<string, Entry>();
  private recent: number[] = [];
  readonly limits: ThrottleLimits;
  private now: () => number;
  constructor(limits: Partial<ThrottleLimits> = {}, now: () => number = Date.now) {
    this.limits = { ...DEFAULT_LIMITS, ...limits };
    this.now = now;
  }

  private entry(key: string, create: boolean): Entry | null {
    const now = this.now();
    let e = this.m.get(key) ?? null;
    if (e && now - e.last > 86_400_000) {
      this.m.delete(key);
      e = null;
    }
    if (!e && create) {
      e = { streak: 0, lockedUntil: 0, day: [], last: now };
      this.m.set(key, e);
      // Bounded memory: the address seen longest ago goes first.
      if (this.m.size > this.limits.maxKeys) this.m.delete(this.m.keys().next().value!);
    }
    if (e) {
      while (e.day.length && now - e.day[0] > 86_400_000) e.day.shift();
    }
    return e;
  }

  /** Milliseconds this address must still wait (0: go ahead). */
  lockedMs(key: string): number {
    const e = this.entry(key, false);
    if (!e) return 0;
    const now = this.now();
    let until = e.lockedUntil;
    if (e.day.length >= this.limits.daily) until = Math.max(until, e.day[0] + 86_400_000);
    return Math.max(0, until - now);
  }

  /** A failed attempt. Returns the new lock (ms; 0 = none yet) and whether this one hit the daily cap. */
  fail(key: string): { lockMs: number; dailyCap: boolean } {
    const now = this.now();
    const e = this.entry(key, true)!;
    // Refresh its place in the map (most recent last).
    this.m.delete(key);
    this.m.set(key, e);
    e.last = now;
    e.streak++;
    e.day.push(now);
    if (e.day.length > this.limits.daily) e.day.splice(0, e.day.length - this.limits.daily);
    if (e.streak >= this.limits.free) e.lockedUntil = now + Math.min(this.limits.maxLockMs, 1000 * 2 ** (e.streak - this.limits.free));
    this.recent.push(now);
    this.trimRecent();
    if (this.recent.length > 10_000) this.recent.splice(0, this.recent.length - 10_000);
    return { lockMs: this.lockedMs(key), dailyCap: e.day.length >= this.limits.daily };
  }

  succeed(key: string) {
    this.m.delete(key);
  }

  private trimRecent() {
    const now = this.now();
    while (this.recent.length && now - this.recent[0] > 60_000) this.recent.shift();
  }

  /** Failures from all addresses in the last minute. */
  globalRate(): number {
    this.trimRecent();
    return this.recent.length;
  }

  /** How long a password check should wait right now (ms): 100 ms per failure per minute above globalFree, capped. */
  globalDelayMs(): number {
    const over = this.globalRate() - this.limits.globalFree;
    return over > 0 ? Math.min(this.limits.maxDelayMs, over * 100) : 0;
  }

  get size() {
    return this.m.size;
  }
}
