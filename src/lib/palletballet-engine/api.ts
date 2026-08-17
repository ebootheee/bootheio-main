/**
 * The HTTP API's response shapes, produced locally.
 *
 * Port of the handlers in `pallet_safety/service/api.py`. Keeping the exact
 * payload shapes means the browser client swaps `fetch` for a function call
 * without touching any rendering code — and it keeps one description of what a
 * solve result *is*, shared by the service and the client engine.
 */

import { get as getTemplate } from './catalog.js';
import { DEFAULT_THRESHOLDS, type FailureThresholds, firstFailure, tipAngleDeg } from './failures.js';
import { Configurator, type RawInputs } from './configurator.js';
import { MockRandomAdapter, type MockRandomOptions } from './mockRandom.js';
import { type ConveyorProfile, makeProfile } from './profile.js';
import { allScenarios, getScenario, type Scenario } from './scenarios.js';
import { downsample, type MujocoModule, simulate, type SimulationTrace } from './solver.js';
import { ThresholdAnalyzer } from './threshold.js';
import {
  compositeComM,
  overhangM,
  stackHeightM,
  totalMassKg,
  type PalletConfig,
  type Vec3,
} from './types.js';

export interface ScenarioSummary {
  slug: string;
  name: string;
  tag: string;
  description: string;
  expected_failure: string;
  item_count: number;
  total_mass_kg: number;
  stack_height_m: number;
}

export interface ReplayItem {
  sku: string;
  name: string;
  dims_m: Vec3;
  fragility: string;
  category: string;
}

export interface ReplayData {
  times_s: number[];
  belt_disp_m: number[];
  base_dims_m: Vec3;
  pallet_pos_m: Vec3[];
  pallet_quat_wxyz: number[][];
  items: ReplayItem[];
  item_pos_m: Vec3[][];
  item_quat_wxyz: number[][][];
}

export interface SolveResponse {
  pallet_id: string;
  failure: { mode: string; time_s: number | null; max_tip_angle_deg: number };
  trace: {
    times_s: number[];
    conveyor_vel_mps: number[];
    pallet_vel_x_mps: number[];
    pallet_pos_x_m: number[];
    tip_angle_deg: number[];
  };
  runtime_ms: number;
  n_steps_simulated: number;
  replay: ReplayData | null;
}

export interface SafetyResponse {
  result: {
    pallet_id: string;
    max_speed_mps: number;
    max_accel_mps2: number;
    max_decel_mps2: number;
    max_lateral_g: number;
    dominant_failure_mode: string;
    margin_pct: number;
    confidence: number;
    sim_runtime_ms: number;
    config_hash: string;
  };
  sims_run: number;
  cache_hits: number;
}

export interface SolveOptions {
  profile: Partial<ConveyorProfile>;
  includeReplay?: boolean;
  outputHz?: number;
  thresholds?: FailureThresholds;
}

// ---- helpers ----

function chunk(arr: Float64Array, stride: number): number[][] {
  const out: number[][] = [];
  for (let i = 0; i + stride <= arr.length; i += stride) {
    out.push(Array.from(arr.subarray(i, i + stride)));
  }
  return out;
}

/** Per-step arrays of per-item vectors: (steps, items, stride). */
function chunk3(arr: Float64Array, nItems: number, stride: number): number[][][] {
  const out: number[][][] = [];
  const perStep = nItems * stride;
  if (perStep === 0) return out;
  for (let i = 0; i + perStep <= arr.length; i += perStep) {
    out.push(chunk(arr.subarray(i, i + perStep) as Float64Array, stride));
  }
  return out;
}

/**
 * The API serializes PalletConfig with pydantic's computed fields attached, and
 * the game's renderer reads them. Recreate that shape rather than making the
 * consumer compute them.
 */
export function withComputedFields(config: PalletConfig): PalletConfig & Record<string, unknown> {
  return {
    ...config,
    items: config.items.map((i) => ({
      ...i,
      center_of_mass: [i.position[0], i.position[1], i.position[2] + i.dims_m[2] / 2.0],
    })),
    total_mass_kg: totalMassKg(config),
    composite_com_m: compositeComM(config),
    stack_height_m: stackHeightM(config),
    overhang_m: overhangM(config),
  } as PalletConfig & Record<string, unknown>;
}

function buildReplay(ds: SimulationTrace, cfg: PalletConfig): ReplayData {
  const times = Array.from(ds.times);
  const beltDisp: number[] = [];
  let acc = 0;
  for (let i = 0; i < ds.nSteps; i++) {
    const dt = i === 0 ? 0 : ds.times[i] - ds.times[i - 1];
    acc += ds.conveyorVel[i] * dt;
    beltDisp.push(ds.nSteps > 1 ? acc : 0);
  }

  const items: ReplayItem[] = cfg.items.map((item) => {
    let name = item.sku;
    let category = 'unknown';
    try {
      const tpl = getTemplate(item.sku);
      name = tpl.name;
      category = tpl.category;
    } catch {
      // Unknown SKU: fall back to the raw code, as the service does.
    }
    return {
      sku: item.sku, name, dims_m: item.dims_m,
      fragility: item.fragility, category,
    };
  });

  return {
    times_s: times,
    belt_disp_m: beltDisp,
    base_dims_m: cfg.base_dims_m,
    pallet_pos_m: chunk(ds.palletPos, 3) as Vec3[],
    pallet_quat_wxyz: chunk(ds.palletQuat, 4),
    items,
    item_pos_m: chunk3(ds.itemWorldPos, ds.nItems, 3) as Vec3[][],
    item_quat_wxyz: chunk3(ds.itemWorldQuat, ds.nItems, 4),
  };
}

/**
 * The engine behind the endpoints. One instance per worker; it owns the
 * analyzer (and therefore the compiled-model cache).
 */
export class EngineApi {
  private readonly analyzer: ThresholdAnalyzer;
  private readonly configurator = new Configurator();

  constructor(
    private readonly mj: MujocoModule,
    onProgress?: (done: number, estTotal: number) => void,
  ) {
    this.analyzer = new ThresholdAnalyzer(mj, { onProgress });
  }

  /** `GET /scenarios` */
  scenarios(): ScenarioSummary[] {
    return allScenarios().map((s) => ({
      slug: s.slug,
      name: s.name,
      tag: s.tag,
      description: s.description,
      expected_failure: s.expected_failure,
      item_count: s.pallet.items.length,
      total_mass_kg: totalMassKg(s.pallet),
      stack_height_m: stackHeightM(s.pallet),
    }));
  }

  /** `GET /scenarios/{slug}` */
  scenario(slug: string): Scenario {
    const s = getScenario(slug);
    return { ...s, pallet: withComputedFields(s.pallet) };
  }

  /** `POST /raw/random` + `POST /pallet/from-raw`, i.e. `POST /pallet/random`. */
  randomPallet(opts: MockRandomOptions): PalletConfig {
    const raw: RawInputs = new MockRandomAdapter(opts).read();
    return withComputedFields(this.configurator.build(raw));
  }

  /** `POST /solve` */
  solve(pallet: PalletConfig, opts: SolveOptions): SolveResponse {
    const profile = makeProfile(opts.profile);
    const thresholds = opts.thresholds ?? DEFAULT_THRESHOLDS;
    const trace = simulate(this.mj, pallet, profile);
    const [mode, t] = firstFailure(trace, thresholds);
    const angles = tipAngleDeg(trace);
    let maxAngle = 0;
    for (const a of angles) if (a > maxAngle) maxAngle = a;

    const ds = downsample(trace, opts.outputHz ?? 50.0);
    const dsAngles = tipAngleDeg(ds);

    return {
      pallet_id: pallet.pallet_id,
      failure: { mode, time_s: t, max_tip_angle_deg: maxAngle },
      trace: {
        times_s: Array.from(ds.times),
        conveyor_vel_mps: Array.from(ds.conveyorVel),
        pallet_vel_x_mps: chunk(ds.palletLinVel, 3).map((v) => v[0]),
        pallet_pos_x_m: chunk(ds.palletPos, 3).map((v) => v[0]),
        tip_angle_deg: Array.from(dsAngles),
      },
      runtime_ms: trace.runtimeS * 1000.0,
      n_steps_simulated: trace.nSteps,
      replay: opts.includeReplay ? buildReplay(ds, pallet) : null,
    };
  }

  /** `POST /safety/analyze` */
  analyze(pallet: PalletConfig): SafetyResponse {
    const a = this.analyzer.analyze(pallet);
    return {
      result: { ...a.result },
      sims_run: a.simsRun,
      cache_hits: a.cacheHits,
    };
  }

  dispose(): void {
    this.analyzer.dispose();
  }
}
