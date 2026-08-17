// Seeded PRNG so every finding is replayable.
//
// A fuzzer that can't reproduce its own findings is a fuzzer you can't fix bugs
// from. Every random choice in this suite draws from one seeded generator, and
// the seed is printed at the top of every run — `--seed <n>` replays it exactly.

/** mulberry32: small, fast, good enough distribution for input selection. */
export function makeRng(seed) {
  let a = seed >>> 0;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };

  return {
    /** Float in [0, 1). */
    next,
    /** Integer in [0, max). */
    int: (max) => Math.floor(next() * max),
    /** Uniform choice from an array. */
    pick: (arr) => arr[Math.floor(next() * arr.length)],
    /** True with probability p. */
    chance: (p) => next() < p,
    /** Fisher-Yates copy — leaves the input array untouched. */
    shuffle: (arr) => {
      const out = [...arr];
      for (let i = out.length - 1; i > 0; i--) {
        const j = Math.floor(next() * (i + 1));
        [out[i], out[j]] = [out[j], out[i]];
      }
      return out;
    },
  };
}

/** A seed for an unseeded run. Printed so the run can be replayed. */
export function randomSeed() {
  return Math.floor(Math.random() * 0x7fffffff);
}
