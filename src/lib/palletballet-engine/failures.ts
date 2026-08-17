/**
 * Failure-mode detectors over a `SimulationTrace` — port of
 * `pallet_safety/failures.py`.
 *
 * Each detector returns the time of the first failure event (seconds,
 * post-settle) or `null` if that mode never occurred. `firstFailure` returns
 * the earliest failure across all modes.
 */

import { FailureMode } from './types.js';
import type { SimulationTrace } from './solver.js';

export interface FailureThresholds {
  tip_angle_deg: number;
  item_slide_m: number;
  pallet_slip_m: number;
  load_shift_m: number;
}

export const DEFAULT_THRESHOLDS: FailureThresholds = {
  tip_angle_deg: 8.0,
  item_slide_m: 0.05,
  pallet_slip_m: 0.30,
  load_shift_m: 0.02,
};

/**
 * Pallet rotation off vertical at each timestep, in degrees.
 *
 * quat is (w, x, y, z); the world-Z component of the body-Z axis is
 * 1 - 2*(x^2 + y^2), and arccos of that is the tilt angle.
 */
export function tipAngleDeg(trace: SimulationTrace): Float64Array {
  const out = new Float64Array(trace.nSteps);
  for (let i = 0; i < trace.nSteps; i++) {
    const x = trace.palletQuat[i * 4 + 1];
    const y = trace.palletQuat[i * 4 + 2];
    const cosTilt = Math.min(1.0, Math.max(-1.0, 1.0 - 2.0 * (x * x + y * y)));
    out[i] = (Math.acos(cosTilt) * 180.0) / Math.PI;
  }
  return out;
}

export function detectTip(trace: SimulationTrace, thresholdDeg: number): number | null {
  const angles = tipAngleDeg(trace);
  for (let i = 0; i < angles.length; i++) {
    if (angles[i] > thresholdDeg) return trace.times[i];
  }
  return null;
}

export function detectItemSlide(trace: SimulationTrace, thresholdM: number): number | null {
  const { nItems, nSteps } = trace;
  if (nItems === 0) return null;
  for (let t = 0; t < nSteps; t++) {
    const base = t * nItems * 3;
    for (let k = 0; k < nItems; k++) {
      const dx = trace.itemPalletPos[base + k * 3] - trace.itemInitialPalletPos[k * 3];
      const dy = trace.itemPalletPos[base + k * 3 + 1] - trace.itemInitialPalletPos[k * 3 + 1];
      const dz = trace.itemPalletPos[base + k * 3 + 2] - trace.itemInitialPalletPos[k * 3 + 2];
      // sqrt-then-compare, not squared-compare: `np.linalg.norm(...) > thr` can
      // disagree with `d2 > thr*thr` in the last ulp, and a detector that flips
      // at the boundary is exactly what the parity harness is trying to rule out.
      if (Math.sqrt(dx * dx + dy * dy + dz * dz) > thresholdM) return trace.times[t];
    }
  }
  return null;
}

/**
 * Slip = |belt displacement - pallet displacement|, integrated over time.
 *
 * Belt displacement at t is the numerical integral of conveyor_vel; the pallet
 * displacement is its x-translation since the start of the run.
 */
export function detectPalletSlip(trace: SimulationTrace, thresholdM: number): number | null {
  const n = trace.nSteps;
  if (n < 2) return null;
  const x0 = trace.palletPos[0];
  let beltDisp = 0.0;
  for (let i = 0; i < n; i++) {
    // np.diff(times, prepend=times[0]) — the first dt is zero by construction.
    const dt = i === 0 ? 0.0 : trace.times[i] - trace.times[i - 1];
    beltDisp += trace.conveyorVel[i] * dt;
    const palletDisp = trace.palletPos[i * 3] - x0;
    if (Math.abs(beltDisp - palletDisp) > thresholdM) return trace.times[i];
  }
  return null;
}

/** Item-to-item pairwise distance change. O(n^2) per step, but n is small. */
export function detectLoadShift(trace: SimulationTrace, thresholdM: number): number | null {
  const { nItems, nSteps } = trace;
  if (nItems < 2) return null;

  const nPairs = (nItems * (nItems - 1)) / 2;
  const initD = new Float64Array(nPairs);
  const init = trace.itemInitialPalletPos;
  let p = 0;
  for (let i = 0; i < nItems; i++) {
    for (let j = i + 1; j < nItems; j++) {
      const dx = init[i * 3] - init[j * 3];
      const dy = init[i * 3 + 1] - init[j * 3 + 1];
      const dz = init[i * 3 + 2] - init[j * 3 + 2];
      initD[p++] = Math.sqrt(dx * dx + dy * dy + dz * dz);
    }
  }

  for (let t = 0; t < nSteps; t++) {
    const base = t * nItems * 3;
    p = 0;
    for (let i = 0; i < nItems; i++) {
      for (let j = i + 1; j < nItems; j++) {
        const dx = trace.itemPalletPos[base + i * 3] - trace.itemPalletPos[base + j * 3];
        const dy = trace.itemPalletPos[base + i * 3 + 1] - trace.itemPalletPos[base + j * 3 + 1];
        const dz = trace.itemPalletPos[base + i * 3 + 2] - trace.itemPalletPos[base + j * 3 + 2];
        const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
        if (Math.abs(d - initD[p++]) > thresholdM) return trace.times[t];
      }
    }
  }
  return null;
}

/** (mode, time) of the earliest failure event. */
export function firstFailure(
  trace: SimulationTrace,
  thresholds: FailureThresholds = DEFAULT_THRESHOLDS,
): [FailureMode, number | null] {
  const candidates: Array<[FailureMode, number | null]> = [
    [FailureMode.TIP_OVER, detectTip(trace, thresholds.tip_angle_deg)],
    [FailureMode.TOP_ITEM_SLIDE, detectItemSlide(trace, thresholds.item_slide_m)],
    [FailureMode.PALLET_SLIP, detectPalletSlip(trace, thresholds.pallet_slip_m)],
    [FailureMode.LOAD_SHIFT, detectLoadShift(trace, thresholds.load_shift_m)],
  ];
  let best: [FailureMode, number | null] | null = null;
  for (const c of candidates) {
    if (c[1] === null) continue;
    // `min` over (mode, time) pairs, first-wins on ties — matches Python's
    // stable `min(finite, key=...)` over the same candidate order.
    if (best === null || (c[1] as number) < (best[1] as number)) best = c;
  }
  return best ?? [FailureMode.NO_FAILURE, null];
}
