/** Belt-velocity profile over time — port of `solver.ConveyorProfile`. */

export type ProfileShape = 'accel_hold' | 'constant' | 'ramp_decel';

export interface ConveyorProfile {
  /** 0 <= target_speed_mps <= 5 */
  target_speed_mps: number;
  /** 0 < accel_mps2 <= 10 */
  accel_mps2: number;
  /** 0 < duration_s <= 30 */
  duration_s: number;
  shape: ProfileShape;
  decel_start_s: number;
}

export const PROFILE_DEFAULTS: ConveyorProfile = {
  target_speed_mps: 0.5,
  accel_mps2: 0.5,
  duration_s: 5.0,
  shape: 'accel_hold',
  decel_start_s: 3.0,
};

export function makeProfile(partial: Partial<ConveyorProfile> = {}): ConveyorProfile {
  return { ...PROFILE_DEFAULTS, ...partial };
}

/**
 * Belt velocity at time `t`.
 *
 *   accel_hold: ramp 0 → target over target/accel seconds, then hold.
 *   constant:   instant target speed (worst-case slip transient).
 *   ramp_decel: hold target, then ramp target → 0 from decel_start_s.
 */
export function velocityAt(p: ConveyorProfile, t: number): number {
  if (t <= 0) return 0.0;
  if (p.shape === 'constant') return p.target_speed_mps;
  if (p.shape === 'ramp_decel') {
    const rampUp = p.target_speed_mps / Math.max(p.accel_mps2, 1e-9);
    if (t < rampUp) return p.accel_mps2 * t;
    if (t < p.decel_start_s) return p.target_speed_mps;
    const decelT = t - p.decel_start_s;
    return Math.max(0.0, p.target_speed_mps - p.accel_mps2 * decelT);
  }
  const rampUp = p.target_speed_mps / Math.max(p.accel_mps2, 1e-9);
  if (t < rampUp) return p.accel_mps2 * t;
  return p.target_speed_mps;
}
