/**
 * Canonical domain types — the TypeScript mirror of `pallet_safety/models.py`.
 *
 * Coordinate convention:
 *   Origin is the center of the BOTTOM face of the pallet base.
 *   +X = belt-travel direction, +Y = lateral, +Z = up.
 *   Item.position is the center of the item's bottom face, in pallet coords.
 *
 * Pydantic validation has no direct equivalent here; `validatePalletConfig`
 * enforces the same constraints the Python `Field(...)` declarations do, so a
 * config rejected by the API is also rejected in the browser.
 */

export type Vec3 = [number, number, number];

export enum EnvCondition {
  FROZEN = 'frozen',
  REFRIGERATED = 'refrigerated',
  THAWED = 'thawed',
  TRANSITIONING = 'transitioning',
}

export enum FragilityClass {
  RIGID = 'rigid',
  SEMI_RIGID = 'semi_rigid',
  DEFORMABLE = 'deformable',
}

export enum WrapType {
  NONE = 'none',
  SHRINK = 'shrink',
  STRETCH = 'stretch',
  BANDED = 'banded',
}

export enum FailureMode {
  NO_FAILURE = 'no_failure',
  TIP_OVER = 'tip_over',
  TOP_ITEM_SLIDE = 'top_item_slide',
  PALLET_SLIP = 'pallet_slip',
  LOAD_SHIFT = 'load_shift',
}

export interface Item {
  sku: string;
  /** 0 < weight_kg <= 500 */
  weight_kg: number;
  /** (length, width, height) in meters, all > 0 */
  dims_m: Vec3;
  fragility: FragilityClass;
  /** center of bottom face in pallet coords */
  position: Vec3;
  /** -180 <= orientation_deg <= 180 */
  orientation_deg: number;
}

export interface PalletConfig {
  pallet_id: string;
  base_pallet_type: string;
  base_dims_m: Vec3;
  /** 0 < base_mass_kg <= 100 */
  base_mass_kg: number;
  items: Item[];
  wrap: WrapType;
  env: EnvCondition;
  /** -40 <= body_temp_c <= 40 */
  body_temp_c: number;
  seconds_since_temp_change: number;
  notes?: string | null;
}

export interface SafetyResult {
  pallet_id: string;
  max_speed_mps: number;
  max_accel_mps2: number;
  max_decel_mps2: number;
  max_lateral_g: number;
  dominant_failure_mode: FailureMode;
  margin_pct: number;
  confidence: number;
  sim_runtime_ms: number;
  config_hash: string;
}

/** Defaults matching the Python model's field defaults. */
export const ITEM_DEFAULTS = {
  fragility: FragilityClass.RIGID,
  orientation_deg: 0.0,
} as const;

export const PALLET_DEFAULTS = {
  base_pallet_type: 'EUR',
  base_dims_m: [1.2, 0.8, 0.15] as Vec3,
  base_mass_kg: 25.0,
  wrap: WrapType.STRETCH,
  seconds_since_temp_change: 3600.0,
} as const;

// ---- derived quantities (the Python @computed_field properties) ----

/** Geometric center of an item, assuming uniform density. */
export function centerOfMass(item: Item): Vec3 {
  const [x, y, z] = item.position;
  return [x, y, z + item.dims_m[2] / 2.0];
}

export function totalMassKg(config: PalletConfig): number {
  let m = config.base_mass_kg;
  for (const i of config.items) m += i.weight_kg;
  return m;
}

/** Mass-weighted center of mass of (base + all items). */
export function compositeComM(config: PalletConfig): Vec3 {
  const bz = config.base_dims_m[2] / 2.0;
  let mTotal = config.base_mass_kg;
  let cx = 0.0;
  let cy = 0.0;
  let cz = config.base_mass_kg * bz;
  for (const item of config.items) {
    const [ix, iy, iz] = centerOfMass(item);
    cx += item.weight_kg * ix;
    cy += item.weight_kg * iy;
    cz += item.weight_kg * iz;
    mTotal += item.weight_kg;
  }
  return [cx / mTotal, cy / mTotal, cz / mTotal];
}

/** Top of the highest item (or pallet top if there are no items). */
export function stackHeightM(config: PalletConfig): number {
  if (config.items.length === 0) return config.base_dims_m[2];
  let h = -Infinity;
  for (const i of config.items) h = Math.max(h, i.position[2] + i.dims_m[2]);
  return h;
}

/** Max horizontal distance any item extends beyond the pallet edge. */
export function overhangM(config: PalletConfig): number {
  const halfL = config.base_dims_m[0] / 2.0;
  const halfW = config.base_dims_m[1] / 2.0;
  let maxOverhang = 0.0;
  for (const item of config.items) {
    const [ix, iy] = item.position;
    const [il, iw] = item.dims_m;
    maxOverhang = Math.max(
      maxOverhang,
      Math.abs(ix) + il / 2.0 - halfL,
      Math.abs(iy) + iw / 2.0 - halfW,
    );
  }
  return maxOverhang;
}

// ---- validation (mirrors the pydantic Field constraints) ----

export class ValidationError extends Error {}

function assert(cond: boolean, msg: string): asserts cond {
  if (!cond) throw new ValidationError(msg);
}

/** Mirrors `PalletConfig.items`' `max_length` on the Python side. */
export const MAX_ITEMS = 200;

export function validatePalletConfig(config: PalletConfig): PalletConfig {
  assert(!!config.pallet_id, 'pallet_id is required');
  assert(config.items.length <= MAX_ITEMS,
    `items has at most ${MAX_ITEMS} entries, got ${config.items.length}`);
  assert(config.base_mass_kg > 0 && config.base_mass_kg <= 100,
    'base_mass_kg must be in (0, 100]');
  assert(config.body_temp_c >= -40 && config.body_temp_c <= 40,
    'body_temp_c must be in [-40, 40]');
  assert(config.seconds_since_temp_change >= 0,
    'seconds_since_temp_change must be >= 0');
  for (const [i, item] of config.items.entries()) {
    assert(item.weight_kg > 0 && item.weight_kg <= 500,
      `items[${i}].weight_kg must be in (0, 500]`);
    assert(item.orientation_deg >= -180 && item.orientation_deg <= 180,
      `items[${i}].orientation_deg must be in [-180, 180]`);
    for (const v of [...item.dims_m, ...item.position]) {
      assert(!Number.isNaN(v), `items[${i}] Vec3 components cannot be NaN`);
    }
    for (const d of item.dims_m) {
      assert(d > 0, `items[${i}].dims_m components must be positive`);
    }
  }
  return config;
}
