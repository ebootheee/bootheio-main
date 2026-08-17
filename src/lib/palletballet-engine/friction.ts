/**
 * Temperature-dependent friction model — port of `pallet_safety/friction.py`.
 *
 * `src/data/friction_table.json` is a copy of the repo's `data/friction_table.json`
 * so the package is self-contained in a browser bundle. `test/friction.test.ts`
 * asserts the two files are byte-identical, so a change on the Python side that
 * isn't mirrored here fails the suite rather than silently changing physics.
 */

import table from './data/friction_table.json' with { type: 'json' };

export type SurfacePair = [string, string];

export const DEFAULT_PAIR: SurfacePair = ['wood_pallet', 'rubber_belt'];

interface ControlPoint { temp_c: number; mu_s: number; mu_d: number }

const pairs = table.surface_pairs as Record<string, { control_points: ControlPoint[] }>;
const penalty = table.transition_penalty as unknown as {
  danger_zone_temp_c: [number, number];
  min_multiplier: number;
  recovery_seconds: number;
};

function key(pair: SurfacePair): string {
  return `${pair[0]}/${pair[1]}`;
}

/**
 * `np.interp` semantics: linear between control points, clamped to the first
 * and last values outside the table's range (NOT extrapolated).
 */
function interp(x: number, xs: number[], ys: number[]): number {
  const n = xs.length;
  if (x <= xs[0]) return ys[0];
  if (x >= xs[n - 1]) return ys[n - 1];
  let hi = 1;
  while (hi < n - 1 && xs[hi] < x) hi++;
  const lo = hi - 1;
  const span = xs[hi] - xs[lo];
  if (span === 0) return ys[lo];
  return ys[lo] + ((x - xs[lo]) / span) * (ys[hi] - ys[lo]);
}

/** Steady-state (mu_s, mu_d) at the given temperature, no transition effect. */
export function steadyStateMu(
  tempC: number,
  surfacePair: SurfacePair = DEFAULT_PAIR,
): [number, number] {
  const k = key(surfacePair);
  const entry = pairs[k];
  if (!entry) {
    throw new Error(`unknown surface pair '${k}'; have ${Object.keys(pairs).join(', ')}`);
  }
  const pts = entry.control_points;
  const temps = pts.map((p) => p.temp_c);
  return [
    interp(tempC, temps, pts.map((p) => p.mu_s)),
    interp(tempC, temps, pts.map((p) => p.mu_d)),
  ];
}

/**
 * Multiplier in (0, 1] capturing frost-melt friction loss. 1.0 outside the
 * danger zone or after recovery; drops toward `min_multiplier` at the zone
 * center with zero recovery time.
 */
export function transitionPenalty(tempC: number, secondsSinceTempChange: number): number {
  const [lo, hi] = penalty.danger_zone_temp_c;
  if (tempC < lo || tempC > hi) return 1.0;
  const center = (lo + hi) / 2.0;
  const halfWidth = (hi - lo) / 2.0;
  const zoneFactor = 1.0 - Math.abs(tempC - center) / halfWidth;
  const recoveryFactor = Math.max(0.0, 1.0 - secondsSinceTempChange / penalty.recovery_seconds);
  const severity = zoneFactor * recoveryFactor;
  return 1.0 - severity * (1.0 - penalty.min_multiplier);
}

/** (mu_static, mu_dynamic) including the transition-zone penalty. */
export function frictionCoefficient(
  bodyTempC: number,
  secondsSinceTempChange = 3600.0,
  surfacePair: SurfacePair = DEFAULT_PAIR,
): [number, number] {
  const [muS, muD] = steadyStateMu(bodyTempC, surfacePair);
  const mult = transitionPenalty(bodyTempC, secondsSinceTempChange);
  return [muS * mult, muD * mult];
}

export function availableSurfacePairs(): SurfacePair[] {
  return Object.keys(pairs).map((k) => k.split('/') as SurfacePair);
}
