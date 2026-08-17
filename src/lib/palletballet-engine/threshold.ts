/**
 * Binary-search the maximum safe operating envelope for a pallet — port of
 * `pallet_safety/threshold.py`.
 *
 * Assumptions (unchanged from the Python engine, restated because they still
 * bound what the numbers mean):
 *   - Failure is monotone in speed/accel: a pallet that fails at V is assumed
 *     to fail at all V' > V. True for friction-driven slip and accel-driven
 *     tip, not strictly true for resonance (which we don't model).
 *   - The speed search uses a fixed ramp accel and the accel search a fixed
 *     target speed. They don't interact in v1.
 */

import { DEFAULT_THRESHOLDS, type FailureThresholds, firstFailure } from './failures.js';
import { DEFAULT_PAIR, type SurfacePair } from './friction.js';
import { makeProfile } from './profile.js';
import { buildModel, type MjData, type MjModel, type MujocoModule, simulate } from './solver.js';
import { configFingerprint } from './fingerprint.js';
import { FailureMode, type PalletConfig, type SafetyResult } from './types.js';

const DEFAULT_SETTLE_S = 0.15; // items drop ~10cm during settle — sufficient

export interface SearchConfig {
  speed_min_mps: number;
  speed_max_mps: number;
  accel_min_mps2: number;
  accel_max_mps2: number;
  precision_mps: number;
  precision_mps2: number;
  hold_s: number;
  speed_search_accel: number;
  accel_search_target_speed: number;
}

/**
 * Defaults tuned for realistic conveyor ranges: pallets move 0.3–1.5 m/s in
 * normal distribution ops, up to 2.0 m/s on high-throughput lines; accel is
 * typically 0.5–3 m/s². Searching beyond those adds latency for ranges nobody
 * operates in.
 */
export const DEFAULT_SEARCH: SearchConfig = {
  speed_min_mps: 0.1,
  speed_max_mps: 2.0,
  accel_min_mps2: 0.1,
  accel_max_mps2: 5.0,
  precision_mps: 0.1,
  precision_mps2: 0.2,
  hold_s: 0.25,
  speed_search_accel: 1.0,
  accel_search_target_speed: 1.0,
};

export type SweepAxis = 'speed' | 'accel';
export type SweepPoint = [SweepAxis, number, boolean, FailureMode];

export interface AnalysisResult {
  result: SafetyResult;
  simsRun: number;
  cacheHits: number;
  sweepPoints: SweepPoint[];
}

export interface AnalyzerOptions {
  search?: Partial<SearchConfig>;
  thresholds?: Partial<FailureThresholds>;
  surfacePair?: SurfacePair;
  maxModels?: number;
  maxResults?: number;
  /** Called after each sim with (done, estimatedTotal) — for progress UI. */
  onProgress?: (done: number, estTotal: number) => void;
}

interface CachedModel { model: MjModel; data: MjData }

/**
 * Runs safety analyses for pallets, caching compiled models and results.
 *
 * Instantiate once and call `analyze()` many times. Compiled `MjModel`s and
 * their `MjData` live in the WASM heap and are explicitly freed on eviction —
 * there is no GC for those, so dropping the reference alone would leak.
 */
export class ThresholdAnalyzer {
  readonly search: SearchConfig;
  readonly thresholds: FailureThresholds;
  readonly surfacePair: SurfacePair;

  private readonly mj: MujocoModule;
  private readonly modelCache = new Map<string, CachedModel>();
  private readonly resultCache = new Map<string, AnalysisResult>();
  private readonly maxModels: number;
  private readonly maxResults: number;
  private readonly onProgress?: (done: number, estTotal: number) => void;

  constructor(mj: MujocoModule, opts: AnalyzerOptions = {}) {
    this.mj = mj;
    this.search = { ...DEFAULT_SEARCH, ...opts.search };
    this.thresholds = { ...DEFAULT_THRESHOLDS, ...opts.thresholds };
    this.surfacePair = opts.surfacePair ?? DEFAULT_PAIR;
    this.maxModels = opts.maxModels ?? 32;
    this.maxResults = opts.maxResults ?? 256;
    this.onProgress = opts.onProgress;
  }

  /** Full safety envelope for a pallet. Cached by config fingerprint. */
  analyze(config: PalletConfig): AnalysisResult {
    const h = configFingerprint(config);
    const cached = this.resultCache.get(h);
    if (cached) {
      return {
        result: cached.result,
        simsRun: 0,
        cacheHits: 1,
        sweepPoints: cached.sweepPoints,
      };
    }

    const t0 = performance.now();
    const entry = this.getModel(config);
    this.progressDone = 0;
    const speed = this.binarySearchSpeed(config, entry);
    const accel = this.binarySearchAccel(config, entry);

    // Margins relative to the operating envelope (clamped 0..1)
    const speedMargin = Math.max(0.0, (speed.value - this.search.speed_min_mps)
      / (this.search.speed_max_mps - this.search.speed_min_mps));
    const accelMargin = Math.max(0.0, (accel.value - this.search.accel_min_mps2)
      / (this.search.accel_max_mps2 - this.search.accel_min_mps2));

    // Dominant failure = whichever dimension is the tighter constraint
    const dominant = speedMargin < accelMargin ? speed.mode : accel.mode;
    const margin = Math.min(speedMargin, accelMargin);

    const result: SafetyResult = {
      pallet_id: config.pallet_id,
      max_speed_mps: speed.value,
      max_accel_mps2: accel.value,
      max_decel_mps2: accel.value, // symmetric approx; v2 could search separately
      max_lateral_g: 0.3, // placeholder until we model curves
      dominant_failure_mode: dominant,
      margin_pct: Math.max(0.0, Math.min(100.0, margin * 100.0)),
      confidence: Math.max(0.0, Math.min(1.0, margin * 1.25)),
      sim_runtime_ms: performance.now() - t0,
      config_hash: h,
    };

    const analysis: AnalysisResult = {
      result,
      simsRun: speed.n + accel.n,
      cacheHits: 0,
      sweepPoints: [
        ...speed.sweep.map(([v, s, m]) => ['speed', v, s, m] as SweepPoint),
        ...accel.sweep.map(([v, s, m]) => ['accel', v, s, m] as SweepPoint),
      ],
    };
    this.storeResult(h, analysis);
    return analysis;
  }

  /** Just the speed search, for callers that don't need the full envelope. */
  maxSafeSpeed(config: PalletConfig): { speed: number; mode: FailureMode; sims: number } {
    const r = this.binarySearchSpeed(config, this.getModel(config));
    return { speed: r.value, mode: r.mode, sims: r.n };
  }

  /** Free every cached WASM handle. Call when discarding the analyzer. */
  dispose(): void {
    for (const { model, data } of this.modelCache.values()) {
      data.delete?.();
      model.delete?.();
    }
    this.modelCache.clear();
    this.resultCache.clear();
  }

  // ---- internals ----

  private progressDone = 0;

  private binarySearchSpeed(config: PalletConfig, entry: CachedModel) {
    const sweep: Array<[number, boolean, FailureMode]> = [];
    let lo = this.search.speed_min_mps;
    let hi = this.search.speed_max_mps;
    let n = 0;

    // Check the high bound first — if safe, no search needed.
    const atHi = this.runSpeed(config, entry, hi);
    sweep.push([hi, atHi.safe, atHi.mode]);
    n++;
    if (atHi.safe) return { value: hi, mode: FailureMode.NO_FAILURE, n, sweep };

    // Check the low bound — if not safe, the pallet is fragile; return zero.
    const atLo = this.runSpeed(config, entry, lo);
    sweep.push([lo, atLo.safe, atLo.mode]);
    n++;
    if (!atLo.safe) return { value: 0.0, mode: atLo.mode, n, sweep };

    let lastFail = atHi.mode;
    while (hi - lo > this.search.precision_mps) {
      const mid = (lo + hi) / 2.0;
      const r = this.runSpeed(config, entry, mid);
      sweep.push([mid, r.safe, r.mode]);
      n++;
      if (r.safe) lo = mid;
      else { hi = mid; lastFail = r.mode; }
    }
    return { value: lo, mode: lastFail, n, sweep };
  }

  private binarySearchAccel(config: PalletConfig, entry: CachedModel) {
    const sweep: Array<[number, boolean, FailureMode]> = [];
    let lo = this.search.accel_min_mps2;
    let hi = this.search.accel_max_mps2;
    let n = 0;
    const target = this.search.accel_search_target_speed;

    const atHi = this.runAccel(config, entry, target, hi);
    sweep.push([hi, atHi.safe, atHi.mode]);
    n++;
    if (atHi.safe) return { value: hi, mode: FailureMode.NO_FAILURE, n, sweep };

    const atLo = this.runAccel(config, entry, target, lo);
    sweep.push([lo, atLo.safe, atLo.mode]);
    n++;
    if (!atLo.safe) return { value: 0.0, mode: atLo.mode, n, sweep };

    let lastFail = atHi.mode;
    while (hi - lo > this.search.precision_mps2) {
      const mid = (lo + hi) / 2.0;
      const r = this.runAccel(config, entry, target, mid);
      sweep.push([mid, r.safe, r.mode]);
      n++;
      if (r.safe) lo = mid;
      else { hi = mid; lastFail = r.mode; }
    }
    return { value: lo, mode: lastFail, n, sweep };
  }

  private runSpeed(config: PalletConfig, entry: CachedModel, speed: number) {
    const accel = this.search.speed_search_accel;
    return this.runProfile(config, entry, speed, accel);
  }

  private runAccel(config: PalletConfig, entry: CachedModel, targetSpeed: number, accel: number) {
    return this.runProfile(config, entry, targetSpeed, accel);
  }

  private runProfile(
    config: PalletConfig, entry: CachedModel, targetSpeed: number, accel: number,
  ): { safe: boolean; mode: FailureMode } {
    const rampTime = targetSpeed / accel;
    const profile = makeProfile({
      target_speed_mps: targetSpeed,
      accel_mps2: accel,
      duration_s: rampTime + this.search.hold_s,
    });
    const trace = simulate(this.mj, config, profile, {
      surfacePair: this.surfacePair,
      settleS: DEFAULT_SETTLE_S,
      model: entry.model,
      data: entry.data,
      failFastTipDeg: this.thresholds.tip_angle_deg,
      failFastSlideM: this.thresholds.item_slide_m,
    });
    const [mode] = firstFailure(trace, this.thresholds);
    // Both searches probe the bounds then bisect to a fixed precision, so the
    // sim count is known within ±1 up front: 2 bounds + ceil(log2(range/prec)).
    this.onProgress?.(++this.progressDone, estimatedSims(this.search));
    return { safe: mode === FailureMode.NO_FAILURE, mode };
  }

  private getModel(config: PalletConfig): CachedModel {
    const h = configFingerprint(config);
    const hit = this.modelCache.get(h);
    if (hit) return hit;
    if (this.modelCache.size >= this.maxModels) {
      const oldestKey = this.modelCache.keys().next().value as string;
      const oldest = this.modelCache.get(oldestKey)!;
      oldest.data.delete?.();
      oldest.model.delete?.();
      this.modelCache.delete(oldestKey);
    }
    const model = buildModel(this.mj, config, { surfacePair: this.surfacePair });
    const entry: CachedModel = { model, data: new this.mj.MjData(model) };
    this.modelCache.set(h, entry);
    return entry;
  }

  private storeResult(h: string, analysis: AnalysisResult): void {
    if (this.resultCache.size >= this.maxResults) {
      this.resultCache.delete(this.resultCache.keys().next().value as string);
    }
    this.resultCache.set(h, analysis);
  }
}

/** Upper bound on sims for one `analyze()` — used to drive progress UI. */
export function estimatedSims(search: SearchConfig = DEFAULT_SEARCH): number {
  const speedSteps = Math.ceil(
    Math.log2((search.speed_max_mps - search.speed_min_mps) / search.precision_mps),
  );
  const accelSteps = Math.ceil(
    Math.log2((search.accel_max_mps2 - search.accel_min_mps2) / search.precision_mps2),
  );
  return 2 + speedSteps + 2 + accelSteps;
}
