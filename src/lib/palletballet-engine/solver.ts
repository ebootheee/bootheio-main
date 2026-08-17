/**
 * Run a pallet through a conveyor profile in MuJoCo (WASM) and capture a state
 * trace — port of `pallet_safety/solver.py`.
 *
 * The solver does not decide pass/fail; `failures.ts` does that against the
 * resulting `SimulationTrace`.
 *
 * Trace arrays are flat `Float64Array`s in row-major order, matching the numpy
 * shapes on the Python side (documented per field). Flat beats arrays-of-arrays
 * here: a 40-item pallet over 1,750 steps is ~200k doubles per rollout, and the
 * detectors stream over them linearly.
 */

import { buildMjcf, type BuildMjcfOptions } from './mjcf.js';
import { DEFAULT_PAIR, type SurfacePair } from './friction.js';
import { type ConveyorProfile, velocityAt } from './profile.js';
import type { PalletConfig } from './types.js';

// The WASM module and its handles are untyped in @mujoco/mujoco's .d.ts
// (everything is `any`); these aliases document intent at the call sites.
export type MujocoModule = any;
export type MjModel = any;
export type MjData = any;

let modulePromise: Promise<MujocoModule> | null = null;

/**
 * Load (once) and return the MuJoCo WASM module.
 *
 * Uses the single-threaded build deliberately: the `/mt` build measured
 * identical step rates on our model sizes and would force COOP/COEP headers on
 * every page that embeds the engine.
 */
export function loadMujocoModule(): Promise<MujocoModule> {
  if (!modulePromise) {
    modulePromise = import('@mujoco/mujoco').then((m) => (m.default as any)());
  }
  return modulePromise;
}

export interface SimulationTrace {
  /** (n_steps,) seconds since the end of settle */
  times: Float64Array;
  /** (n_steps,) belt velocity */
  conveyorVel: Float64Array;
  /** (n_steps, 3) */
  palletPos: Float64Array;
  /** (n_steps, 4) w,x,y,z */
  palletQuat: Float64Array;
  /** (n_steps, 3) */
  palletLinVel: Float64Array;
  /** (n_steps, 3) */
  palletAngVel: Float64Array;
  /** (n_steps, n_items, 3) */
  itemWorldPos: Float64Array;
  /** (n_steps, n_items, 4) */
  itemWorldQuat: Float64Array;
  /** (n_steps, n_items, 3) in the pallet frame */
  itemPalletPos: Float64Array;
  /** (n_items, 3) */
  itemInitialPalletPos: Float64Array;
  config: PalletConfig;
  profile: ConveyorProfile;
  runtimeS: number;
  nItems: number;
  nSteps: number;
}

export interface SimulateOptions {
  surfacePair?: SurfacePair;
  settleS?: number;
  /** Pre-built model, to skip the XML compile across many runs. */
  model?: MjModel;
  /** Reusable MjData for `model`; reset before use. Avoids per-sim WASM allocs. */
  data?: MjData;
  /** Abort the sim once the pallet tilts past this angle. */
  failFastTipDeg?: number;
  /** Abort once any item has moved this far in the pallet frame. */
  failFastSlideM?: number;
}

/** Compile the MJCF for a pallet config into a reusable MuJoCo model. */
export function buildModel(
  mj: MujocoModule,
  config: PalletConfig,
  opts: BuildMjcfOptions = {},
): MjModel {
  const xml = buildMjcf(config, { actuatedConveyor: true, ...opts });
  return mj.MjModel.from_xml_string(xml);
}

/**
 * Simulate the pallet on the conveyor under the given speed profile.
 *
 * A short `settleS` window runs with the conveyor at rest so the pallet drops
 * and settles on the belt before the velocity ramp begins; those steps are
 * sliced off the returned trace.
 */
export function simulate(
  mj: MujocoModule,
  config: PalletConfig,
  profile: ConveyorProfile,
  opts: SimulateOptions = {},
): SimulationTrace {
  const {
    surfacePair = DEFAULT_PAIR,
    settleS = 0.5,
    failFastTipDeg,
    failFastSlideM,
  } = opts;

  let ownsModel = false;
  let model = opts.model;
  if (!model) {
    model = buildModel(mj, config, { surfacePair });
    ownsModel = true;
  }

  let ownsData = false;
  let data = opts.data;
  if (!data) {
    data = new mj.MjData(model);
    ownsData = true;
  } else {
    mj.mj_resetData(model, data);
  }

  try {
    return runRollout(mj, model, data, config, profile, settleS,
      failFastTipDeg, failFastSlideM);
  } finally {
    if (ownsData) data.delete?.();
    if (ownsModel) model.delete?.();
  }
}

function runRollout(
  mj: MujocoModule,
  model: MjModel,
  data: MjData,
  config: PalletConfig,
  profile: ConveyorProfile,
  settleS: number,
  failFastTipDeg: number | undefined,
  failFastSlideM: number | undefined,
): SimulationTrace {
  const nItems = config.items.length;
  const palletId: number = model.body('pallet_base').id;
  const itemIds = new Int32Array(nItems);
  for (let i = 0; i < nItems; i++) itemIds[i] = model.body(`item_${i}`).id;
  const palletQv0: number = model.jnt('pallet_joint').dofadr;
  const conveyorQv0: number = model.jnt('conveyor_slide').dofadr;

  const timestep: number = model.opt.timestep;
  const nSettle = Math.trunc(settleS / timestep);
  const nRun = Math.trunc(profile.duration_s / timestep);
  const total = nSettle + nRun;

  const times = new Float64Array(total);
  const conveyorVel = new Float64Array(total);
  const palletPos = new Float64Array(total * 3);
  const palletQuat = new Float64Array(total * 4);
  const palletLinVel = new Float64Array(total * 3);
  const palletAngVel = new Float64Array(total * 3);
  const itemWorldPos = new Float64Array(total * nItems * 3);
  const itemWorldQuat = new Float64Array(total * nItems * 4);
  const itemPalletPos = new Float64Array(total * nItems * 3);

  // Live views into the WASM heap — fetched once, valid for the run.
  const qvel: Float64Array = data.qvel;
  const xpos: Float64Array = data.xpos;
  const xquat: Float64Array = data.xquat;
  const xmat: Float64Array = data.xmat;
  const ctrl: Float64Array = data.ctrl;

  const cosTipLimit = failFastTipDeg !== undefined
    ? Math.cos((failFastTipDeg * Math.PI) / 180.0)
    : null;
  const slideLimitSq = failFastSlideM !== undefined
    ? failFastSlideM * failFastSlideM
    : null;

  let initialItemPalletPos: Float64Array | null = null;
  let stoppedAt = total;

  const t0 = performance.now();
  for (let step = 0; step < total; step++) {
    const simT = (step - nSettle) * timestep;
    ctrl[0] = step >= nSettle ? velocityAt(profile, simT) : 0.0;
    mj.mj_step(model, data);

    times[step] = Math.max(simT, 0.0);
    conveyorVel[step] = qvel[conveyorQv0];

    const p3 = step * 3;
    const px = xpos[palletId * 3];
    const py = xpos[palletId * 3 + 1];
    const pz = xpos[palletId * 3 + 2];
    palletPos[p3] = px;
    palletPos[p3 + 1] = py;
    palletPos[p3 + 2] = pz;

    const p4 = step * 4;
    const qw = xquat[palletId * 4];
    const qx = xquat[palletId * 4 + 1];
    const qy = xquat[palletId * 4 + 2];
    palletQuat[p4] = qw;
    palletQuat[p4 + 1] = qx;
    palletQuat[p4 + 2] = qy;
    palletQuat[p4 + 3] = xquat[palletId * 4 + 3];

    for (let k = 0; k < 3; k++) {
      palletLinVel[p3 + k] = qvel[palletQv0 + k];
      palletAngVel[p3 + k] = qvel[palletQv0 + 3 + k];
    }

    if (nItems > 0) {
      const m0 = palletId * 9;
      const base3 = step * nItems * 3;
      const base4 = step * nItems * 4;
      for (let i = 0; i < nItems; i++) {
        const b = itemIds[i];
        const ix = xpos[b * 3];
        const iy = xpos[b * 3 + 1];
        const iz = xpos[b * 3 + 2];
        const o3 = base3 + i * 3;
        itemWorldPos[o3] = ix;
        itemWorldPos[o3 + 1] = iy;
        itemWorldPos[o3 + 2] = iz;

        const o4 = base4 + i * 4;
        itemWorldQuat[o4] = xquat[b * 4];
        itemWorldQuat[o4 + 1] = xquat[b * 4 + 1];
        itemWorldQuat[o4 + 2] = xquat[b * 4 + 2];
        itemWorldQuat[o4 + 3] = xquat[b * 4 + 3];

        // Pallet frame: R^T @ (item_world - pallet_world), R row-major in xmat.
        const rx = ix - px;
        const ry = iy - py;
        const rz = iz - pz;
        itemPalletPos[o3] = rx * xmat[m0] + ry * xmat[m0 + 3] + rz * xmat[m0 + 6];
        itemPalletPos[o3 + 1] = rx * xmat[m0 + 1] + ry * xmat[m0 + 4] + rz * xmat[m0 + 7];
        itemPalletPos[o3 + 2] = rx * xmat[m0 + 2] + ry * xmat[m0 + 5] + rz * xmat[m0 + 8];
      }
    }

    if (step >= nSettle) {
      if (step === nSettle && nItems > 0) {
        initialItemPalletPos = itemPalletPos.slice(
          step * nItems * 3, (step + 1) * nItems * 3,
        );
      }
      if (cosTipLimit !== null) {
        const cosTilt = 1.0 - 2.0 * (qx * qx + qy * qy);
        if (cosTilt < cosTipLimit) { stoppedAt = step + 1; break; }
      }
      if (slideLimitSq !== null && nItems > 0 && initialItemPalletPos) {
        const base3 = step * nItems * 3;
        let maxSq = 0;
        for (let i = 0; i < nItems; i++) {
          const dx = itemPalletPos[base3 + i * 3] - initialItemPalletPos[i * 3];
          const dy = itemPalletPos[base3 + i * 3 + 1] - initialItemPalletPos[i * 3 + 1];
          const dz = itemPalletPos[base3 + i * 3 + 2] - initialItemPalletPos[i * 3 + 2];
          const d = dx * dx + dy * dy + dz * dz;
          if (d > maxSq) maxSq = d;
        }
        if (maxSq > slideLimitSq) { stoppedAt = step + 1; break; }
      }
    }
  }
  const runtimeS = (performance.now() - t0) / 1000;

  const initialSrc = nSettle < total ? nSettle : 0;
  const initial = nItems > 0
    ? itemPalletPos.slice(initialSrc * nItems * 3, (initialSrc + 1) * nItems * 3)
    : new Float64Array(0);

  // Slice off the settle window and any unused tail from early termination.
  const n = stoppedAt - nSettle;
  return {
    times: times.subarray(nSettle, stoppedAt),
    conveyorVel: conveyorVel.subarray(nSettle, stoppedAt),
    palletPos: palletPos.subarray(nSettle * 3, stoppedAt * 3),
    palletQuat: palletQuat.subarray(nSettle * 4, stoppedAt * 4),
    palletLinVel: palletLinVel.subarray(nSettle * 3, stoppedAt * 3),
    palletAngVel: palletAngVel.subarray(nSettle * 3, stoppedAt * 3),
    itemWorldPos: itemWorldPos.subarray(nSettle * nItems * 3, stoppedAt * nItems * 3),
    itemWorldQuat: itemWorldQuat.subarray(nSettle * nItems * 4, stoppedAt * nItems * 4),
    itemPalletPos: itemPalletPos.subarray(nSettle * nItems * 3, stoppedAt * nItems * 3),
    itemInitialPalletPos: initial,
    config,
    profile,
    runtimeS,
    nItems,
    nSteps: n,
  };
}

/** Return a trace subsampled to the given output rate (for replay/rendering). */
export function downsample(trace: SimulationTrace, hz: number): SimulationTrace {
  if (hz <= 0 || trace.nSteps === 0) return trace;
  const period = 1.0 / hz;
  const keep: number[] = [0];
  let last = trace.times[0];
  for (let i = 0; i < trace.nSteps; i++) {
    if (trace.times[i] - last >= period) { keep.push(i); last = trace.times[i]; }
  }
  const n = keep.length;
  const ni = trace.nItems;
  const gather = (src: Float64Array, stride: number): Float64Array => {
    const out = new Float64Array(n * stride);
    for (let j = 0; j < n; j++) {
      const s = keep[j] * stride;
      for (let k = 0; k < stride; k++) out[j * stride + k] = src[s + k];
    }
    return out;
  };
  return {
    ...trace,
    times: gather(trace.times, 1),
    conveyorVel: gather(trace.conveyorVel, 1),
    palletPos: gather(trace.palletPos, 3),
    palletQuat: gather(trace.palletQuat, 4),
    palletLinVel: gather(trace.palletLinVel, 3),
    palletAngVel: gather(trace.palletAngVel, 3),
    itemWorldPos: gather(trace.itemWorldPos, ni * 3),
    itemWorldQuat: gather(trace.itemWorldQuat, ni * 4),
    itemPalletPos: gather(trace.itemPalletPos, ni * 3),
    nSteps: n,
  };
}
