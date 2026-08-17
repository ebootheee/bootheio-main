/**
 * Seeded random adapter — port of `pallet_safety/inputs/mock_random.py`.
 *
 * Same seed → same pallet as the Python adapter, byte for byte. That requires
 * two things beyond a faithful translation:
 *
 *   1. `PyRandom` (CPython's Mersenne Twister), not `Math.random`.
 *   2. Preserving *iteration order* everywhere the RNG consumes a collection.
 *      The weight tables below are arrays rather than objects because
 *      `_weighted_choice` walks them in declaration order and compares against
 *      a cumulative sum, and `byEnv()` returns catalog order for the same
 *      reason. Reordering either silently changes what a seed produces.
 *
 * Calibrated against published 3PL / cold-storage pallet-build conventions:
 * Ti 4–10, Hi 4–7, 70% homogeneous, ≤1200 kg, ≤1.85 m.
 */

import { allSkus, byEnv, get as getTemplate } from './catalog.js';
import { StackPattern, type RawInputs, type VisionLayout } from './configurator.js';
import { PyRandom, uuidPrefix8 } from './pyrandom.js';
import { EnvCondition } from './types.js';

export enum Homogeneity {
  HOMOGENEOUS = 'homogeneous',
  LAYER_HOMOGENEOUS = 'layer_homogeneous',
  MIXED = 'mixed',
}

/** Order matters — `weightedChoice` walks these in sequence. */
export const DEFAULT_PATTERN_WEIGHTS: Array<[StackPattern, number]> = [
  [StackPattern.BRICK, 0.55],
  [StackPattern.COLUMN, 0.20],
  [StackPattern.PINWHEEL, 0.20],
  [StackPattern.IRREGULAR, 0.05],
];

export const DEFAULT_HOMOGENEITY_WEIGHTS: Array<[Homogeneity, number]> = [
  [Homogeneity.HOMOGENEOUS, 0.70],
  [Homogeneity.LAYER_HOMOGENEOUS, 0.20],
  [Homogeneity.MIXED, 0.10],
];

export const DEFAULT_ENV_WEIGHTS: Array<[EnvCondition, number]> = [
  [EnvCondition.FROZEN, 0.45],
  [EnvCondition.REFRIGERATED, 0.35],
  [EnvCondition.THAWED, 0.10],
  [EnvCondition.TRANSITIONING, 0.10],
];

export const DEFAULT_BASE_PALLET_WEIGHTS: Array<[string, number]> = [
  ['EUR', 0.55],
  ['GMA', 0.35],
  ['CHEP', 0.10],
];

const ENV_TEMP_RANGES: Record<EnvCondition, [number, number]> = {
  [EnvCondition.FROZEN]: [-25.0, -18.0],
  [EnvCondition.REFRIGERATED]: [0.0, 5.0],
  [EnvCondition.THAWED]: [15.0, 22.0],
  [EnvCondition.TRANSITIONING]: [-2.0, 8.0],
};

// Hard safety caps from ANSI MH1 / ISO 6780 pallet ratings.
const MAX_PALLET_WEIGHT_KG = 1200.0;
const MAX_STACK_HEIGHT_M = 1.85;

// Minimum Ti per pattern — patterns only "work" at these counts. Pinwheel is a
// 4-corner rotation; brick needs ≥4 to form the interlocking offset.
const MIN_TI_BY_PATTERN: Record<StackPattern, number> = {
  [StackPattern.COLUMN]: 1,
  [StackPattern.BRICK]: 4,
  [StackPattern.PINWHEEL]: 4,
  [StackPattern.IRREGULAR]: 3,
};

export interface MockRandomOptions {
  seed?: number | bigint | null;
  minLayers?: number;
  maxLayers?: number;
  minItemsPerLayer?: number;
  maxItemsPerLayer?: number;
  anomalyRate?: number;
  patternWeights?: Array<[StackPattern, number]>;
  envWeights?: Array<[EnvCondition, number]>;
  homogeneityWeights?: Array<[Homogeneity, number]>;
}

export class MockRandomAdapter {
  readonly minLayers: number;
  readonly maxLayers: number;
  readonly minItemsPerLayer: number;
  readonly maxItemsPerLayer: number;
  readonly anomalyRate: number;
  private readonly patternWeights: Array<[StackPattern, number]>;
  private readonly envWeights: Array<[EnvCondition, number]>;
  private readonly homogeneityWeights: Array<[Homogeneity, number]>;
  private readonly rng: PyRandom;

  constructor(opts: MockRandomOptions = {}) {
    this.minLayers = opts.minLayers ?? 3;
    this.maxLayers = opts.maxLayers ?? 7;
    this.minItemsPerLayer = opts.minItemsPerLayer ?? 4;
    this.maxItemsPerLayer = opts.maxItemsPerLayer ?? 10;
    this.anomalyRate = opts.anomalyRate ?? 0.08;
    this.patternWeights = opts.patternWeights ?? DEFAULT_PATTERN_WEIGHTS;
    this.envWeights = opts.envWeights ?? DEFAULT_ENV_WEIGHTS;
    this.homogeneityWeights = opts.homogeneityWeights ?? DEFAULT_HOMOGENEITY_WEIGHTS;
    this.rng = new PyRandom(opts.seed ?? null);
  }

  read(): RawInputs {
    const env = this.weightedChoice(this.envWeights);
    const pattern = this.weightedChoice(this.patternWeights);
    const homogeneity = this.weightedChoice(this.homogeneityWeights);
    const baseType = this.weightedChoice(DEFAULT_BASE_PALLET_WEIGHTS);

    const [layers0, itemsPerLayer] = this.sampleTiHi(pattern);

    // The RNG is only consumed when the anomaly fires — Python's conditional
    // expression short-circuits, so an unconditional draw here would desync
    // every subsequent value.
    const isAnomaly = this.rng.random() < this.anomalyRate;
    const leanAngle = isAnomaly ? this.rng.uniform(2.0, 8.0) : 0.0;
    const overhang = isAnomaly ? this.rng.uniform(0.025, 0.10) : 0.0;

    const pool = this.skusForEnv(env);
    const skusPool = pool.length > 0 ? pool : allSkus();
    const chosen = this.pickSkus(skusPool, layers0, itemsPerLayer, homogeneity);

    const [trimmed, layers] = this.enforceCaps(chosen, layers0, itemsPerLayer);

    const [tLo, tHi] = ENV_TEMP_RANGES[env];
    const bodyTemp = this.rng.uniform(tLo, tHi);
    const secSince = env === EnvCondition.TRANSITIONING
      ? this.rng.uniform(30, 300)
      : this.rng.uniform(1800, 7200);

    const vision: VisionLayout = {
      pattern,
      layers,
      items_per_layer: itemsPerLayer,
      lean_angle_deg: leanAngle,
      max_overhang_m: overhang,
    };
    return {
      barcode_skus: trimmed,
      vision,
      env,
      body_temp_c: bodyTemp,
      seconds_since_temp_change: secSince,
      pallet_id: `P-${uuidPrefix8(this.rng.getrandbits(128))}`,
      base_pallet_type: baseType,
    };
  }

  // ---- helpers ----

  /**
   * Sample (Hi, Ti) constrained to what the pattern physically needs — a Ti=1
   * pinwheel would be a twisted tower, so it's disallowed.
   */
  private sampleTiHi(pattern: StackPattern): [number, number] {
    const hardMin = MIN_TI_BY_PATTERN[pattern];
    let tiLo = Math.max(hardMin, this.minItemsPerLayer);
    let tiHi = Math.max(tiLo, this.maxItemsPerLayer);
    if (pattern === StackPattern.COLUMN) {
      tiHi = Math.min(tiHi, 2); // column is a tower, not wide
      tiLo = Math.min(tiLo, tiHi);
    }
    const ti = this.rng.randint(tiLo, tiHi);
    const hi = this.rng.randint(this.minLayers, this.maxLayers);
    return [hi, ti];
  }

  private pickSkus(
    pool: string[], layers: number, itemsPerLayer: number, mode: Homogeneity,
  ): string[] {
    const n = layers * itemsPerLayer;
    if (pool.length === 0) return [];
    if (mode === Homogeneity.HOMOGENEOUS) {
      const sku = this.rng.choice(pool);
      return Array.from({ length: n }, () => sku);
    }
    if (mode === Homogeneity.LAYER_HOMOGENEOUS) {
      const out: string[] = [];
      for (let i = 0; i < layers; i++) {
        const sku = this.rng.choice(pool);
        for (let j = 0; j < itemsPerLayer; j++) out.push(sku);
      }
      return out;
    }
    return Array.from({ length: n }, () => this.rng.choice(pool));
  }

  /**
   * Trim layers from the top until the pallet is under the weight and height
   * caps. Real ops would refuse to build it; for data generation we emit the
   * under-cap pallet that would actually arrive at the conveyor.
   */
  private enforceCaps(
    skus: string[], layers: number, itemsPerLayer: number,
  ): [string[], number] {
    // The 0.15 m pallet base is included so this matches `stackHeightM`, which
    // sums from the base origin.
    const BASE_H = 0.15;
    let cur = layers;
    while (cur > 1) {
      const n = cur * itemsPerLayer;
      const templates = skus.slice(0, n).map(getTemplate);
      let weight = 0;
      for (const t of templates) weight += t.weight_kg;
      let stackH = BASE_H;
      for (let i = 0; i < cur; i++) {
        let tallest = -Infinity;
        for (const t of templates.slice(i * itemsPerLayer, (i + 1) * itemsPerLayer)) {
          tallest = Math.max(tallest, t.dims_m[2]);
        }
        stackH += tallest;
      }
      if (weight <= MAX_PALLET_WEIGHT_KG && stackH <= MAX_STACK_HEIGHT_M) break;
      cur -= 1;
    }
    return [skus.slice(0, cur * itemsPerLayer), cur];
  }

  private weightedChoice<T>(weights: Array<[T, number]>): T {
    let total = 0;
    for (const [, w] of weights) total += w;
    const r = this.rng.random() * total;
    let cum = 0.0;
    for (const [k, w] of weights) {
      cum += w;
      if (r <= cum) return k;
    }
    return weights[weights.length - 1][0];
  }

  private skusForEnv(env: EnvCondition): string[] {
    return byEnv(env).map((t) => t.sku);
  }
}
