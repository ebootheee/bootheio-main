/**
 * Python's `random.Random`, reimplemented for seed-for-seed compatibility.
 *
 * The random-pallet path is the one place the port could silently diverge:
 * everything else is checked against a Python-generated fixture, but a pallet
 * the browser *invents* has nothing to compare to. If the generator disagrees,
 * "seed 1234" means one pallet in the browser and a different one from the API
 * or a batch run, and nobody notices until the numbers stop reconciling.
 *
 * So this is CPython's Mersenne Twister (`_randommodule.c`) plus the derived
 * methods from `Lib/random.py`, not a lookalike. `test/generator.test.ts`
 * checks 1,500 Python-generated pallets reproduce exactly.
 *
 * Only the methods `MockRandomAdapter` actually uses are implemented:
 * random, uniform, randint, choice, getrandbits.
 */

const N = 624;
const M = 397;
const MATRIX_A = 0x9908b0df;
const UPPER_MASK = 0x80000000;
const LOWER_MASK = 0x7fffffff;

export class PyRandom {
  private mt = new Uint32Array(N);
  private mti = N + 1;

  constructor(seed?: number | bigint | null) {
    this.seed(seed);
  }

  /**
   * CPython `random_seed`: an int seed is taken as |seed|, split into 32-bit
   * little-endian words, and fed to `init_by_array`. A `null`/absent seed would
   * be OS entropy in Python; here it falls back to a random 32-bit value, which
   * is by definition not reproducible either way.
   */
  seed(seed?: number | bigint | null): void {
    if (seed === undefined || seed === null) {
      this.initByArray(new Uint32Array([(Math.random() * 0x100000000) >>> 0]));
      return;
    }
    let n = typeof seed === 'bigint' ? seed : BigInt(Math.trunc(seed));
    if (n < 0n) n = -n;
    const words: number[] = [];
    if (n === 0n) {
      words.push(0);
    } else {
      while (n > 0n) {
        words.push(Number(n & 0xffffffffn) >>> 0);
        n >>= 32n;
      }
    }
    this.initByArray(Uint32Array.from(words));
  }

  private initGenrand(s: number): void {
    const mt = this.mt;
    mt[0] = s >>> 0;
    for (let i = 1; i < N; i++) {
      const prev = mt[i - 1] ^ (mt[i - 1] >>> 30);
      mt[i] = (Math.imul(1812433253, prev) + i) >>> 0;
    }
    this.mti = N;
  }

  private initByArray(key: Uint32Array): void {
    this.initGenrand(19650218);
    const mt = this.mt;
    let i = 1;
    let j = 0;
    let k = Math.max(N, key.length);
    for (; k; k--) {
      const prev = mt[i - 1] ^ (mt[i - 1] >>> 30);
      mt[i] = (((mt[i] ^ Math.imul(prev, 1664525)) >>> 0) + key[j] + j) >>> 0;
      i++; j++;
      if (i >= N) { mt[0] = mt[N - 1]; i = 1; }
      if (j >= key.length) j = 0;
    }
    for (k = N - 1; k; k--) {
      const prev = mt[i - 1] ^ (mt[i - 1] >>> 30);
      mt[i] = (((mt[i] ^ Math.imul(prev, 1566083941)) >>> 0) - i) >>> 0;
      i++;
      if (i >= N) { mt[0] = mt[N - 1]; i = 1; }
    }
    mt[0] = 0x80000000;
    this.mti = N;
  }

  /** One tempered 32-bit output. */
  private genrandUint32(): number {
    const mt = this.mt;
    if (this.mti >= N) {
      let kk = 0;
      for (; kk < N - M; kk++) {
        const y = (mt[kk] & UPPER_MASK) | (mt[kk + 1] & LOWER_MASK);
        mt[kk] = mt[kk + M] ^ (y >>> 1) ^ (y & 1 ? MATRIX_A : 0);
      }
      for (; kk < N - 1; kk++) {
        const y = (mt[kk] & UPPER_MASK) | (mt[kk + 1] & LOWER_MASK);
        mt[kk] = mt[kk + (M - N)] ^ (y >>> 1) ^ (y & 1 ? MATRIX_A : 0);
      }
      const y = (mt[N - 1] & UPPER_MASK) | (mt[0] & LOWER_MASK);
      mt[N - 1] = mt[M - 1] ^ (y >>> 1) ^ (y & 1 ? MATRIX_A : 0);
      this.mti = 0;
    }
    let y = mt[this.mti++];
    y ^= y >>> 11;
    y ^= (y << 7) & 0x9d2c5680;
    y ^= (y << 15) & 0xefc60000;
    y ^= y >>> 18;
    return y >>> 0;
  }

  /** `random.random()` — 53-bit float from two 32-bit draws. */
  random(): number {
    const a = this.genrandUint32() >>> 5;
    const b = this.genrandUint32() >>> 6;
    return (a * 67108864.0 + b) * (1.0 / 9007199254740992.0);
  }

  /** `random.getrandbits(k)`. Returns a bigint; the first word is least significant. */
  getrandbits(k: number): bigint {
    if (k <= 0) throw new Error('number of bits must be greater than zero');
    if (k <= 32) return BigInt(this.genrandUint32() >>> (32 - k));
    let result = 0n;
    let shift = 0n;
    let remaining = k;
    while (remaining > 0) {
      let r = this.genrandUint32();
      if (remaining < 32) r >>>= 32 - remaining;
      result |= BigInt(r >>> 0) << shift;
      shift += 32n;
      remaining -= 32;
    }
    return result;
  }

  /** `Random._randbelow_with_getrandbits` — rejection sampling, no modulo bias. */
  private randbelow(n: number): number {
    if (n <= 0) return 0;
    const k = 32 - Math.clz32(n); // n.bit_length() for n < 2^31
    let r = Number(this.getrandbits(k));
    while (r >= n) r = Number(this.getrandbits(k));
    return r;
  }

  /** `random.randint(a, b)` — inclusive on both ends. */
  randint(a: number, b: number): number {
    return a + this.randbelow(b - a + 1);
  }

  /** `random.uniform(a, b)`. */
  uniform(a: number, b: number): number {
    return a + (b - a) * this.random();
  }

  /** `random.choice(seq)`. */
  choice<T>(seq: readonly T[]): T {
    if (seq.length === 0) throw new Error('Cannot choose from an empty sequence');
    return seq[this.randbelow(seq.length)];
  }
}

/**
 * `str(uuid.UUID(int=n))` truncated to 8 chars, which is what the adapter uses
 * for pallet ids. `UUID(int=...)` sets no version bits, so the string is just
 * the zero-padded 32-hex-digit value with dashes — the first 8 characters are
 * the top 32 bits.
 */
export function uuidPrefix8(n: bigint): string {
  return n.toString(16).padStart(32, '0').slice(0, 8);
}
