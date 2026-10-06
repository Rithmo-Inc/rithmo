// Deterministic PRNG + sampling helpers.
//
// Every value in the frozen world derives from one fixed seed, so the manifest is
// reproducible byte-for-byte. Never use Math.random() anywhere in the seed path.

export class Rng {
  #s: number;

  constructor(seed: number) {
    this.#s = seed >>> 0;
  }

  // mulberry32
  next(): number {
    this.#s = (this.#s + 0x6d2b79f5) >>> 0;
    let t = this.#s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  int(minInclusive: number, maxInclusive: number): number {
    return minInclusive + Math.floor(this.next() * (maxInclusive - minInclusive + 1));
  }

  pick<T>(arr: readonly T[]): T {
    return arr[Math.floor(this.next() * arr.length)];
  }

  // Weighted pick: [[value, weight], ...]
  weighted<T>(pairs: readonly (readonly [T, number])[]): T {
    const total = pairs.reduce((s, p) => s + p[1], 0);
    let r = this.next() * total;
    for (const [v, w] of pairs) {
      r -= w;
      if (r <= 0) return v;
    }
    return pairs[pairs.length - 1][0];
  }

  bool(pTrue: number): boolean {
    return this.next() < pTrue;
  }

  // Approximate lognormal via Box-Muller — gives the long right tail real deal sizes have.
  logNormal(median: number, sigma: number): number {
    const u1 = Math.max(this.next(), 1e-9);
    const u2 = this.next();
    const z = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
    return median * Math.exp(sigma * z);
  }

  /**
   * A Poisson count: how many independent things happen in one interval.
   *
   * Knuth's product method. Exact for the lambdas this repo uses (a day's event count, single
   * digits) and it consumes a variable number of draws, so a caller that needs a stable stream
   * afterwards must give this its own Rng -- which is why planDay owns one.
   *
   * Added rather than approximated with an int range because a uniform count would put the same
   * spread on every day; a Poisson puts most days near the mean and still produces the occasional
   * genuinely quiet or genuinely busy one, which is what the frozen close history actually shows.
   */
  poisson(lambda: number): number {
    if (!(lambda > 0)) return 0;
    const limit = Math.exp(-lambda);
    let k = 0;
    let p = 1;
    do {
      k++;
      p *= this.next();
    } while (p > limit);
    return k - 1;
  }

  // Uniform ms between two instants.
  between(startMs: number, endMs: number): number {
    return startMs + Math.floor(this.next() * (endMs - startMs));
  }

  shuffle<T>(arr: T[]): T[] {
    const a = [...arr];
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(this.next() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  }
}

export const DAY = 86_400_000;
export const MONTH = 30 * DAY;

export function iso(ms: number): string {
  return new Date(ms).toISOString();
}

export function isoDate(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

// Business-day nudge: pull weekend timestamps onto a weekday so activity does not
// cluster on Saturdays, which reads as synthetic at a glance.
export function toWeekday(ms: number): number {
  const d = new Date(ms);
  const day = d.getUTCDay();
  if (day === 0) return ms + DAY;
  if (day === 6) return ms + 2 * DAY;
  return ms;
}
