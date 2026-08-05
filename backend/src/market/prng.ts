/**
 * Deterministic PRNG utilities for the demo market simulation.
 * Given the same seed and time bucket, every value reproduces exactly —
 * required so the paper-trading engine and tests are deterministic.
 *
 * Floats are acceptable HERE ONLY: this generates simulated market data.
 * All financial arithmetic downstream uses bigint.
 */

/** FNV-1a string hash → uint32 seed. */
export function hashSeed(input: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** mulberry32 — small, fast, deterministic PRNG. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** One deterministic uniform sample in [0,1) for a composite key. */
export function sample(key: string): number {
  return mulberry32(hashSeed(key))();
}

/** Deterministic sample in [min, max). */
export function sampleRange(key: string, min: number, max: number): number {
  return min + sample(key) * (max - min);
}

/** Deterministic approximately-normal sample (sum of 4 uniforms, centered). */
export function sampleNormal(key: string): number {
  const rng = mulberry32(hashSeed(key));
  return rng() + rng() + rng() + rng() - 2; // mean 0, range [-2, 2]
}

/** Floor a timestamp into a bucket index. */
export function bucketOf(nowMs: number, bucketMs: number): number {
  return Math.floor(nowMs / bucketMs);
}
