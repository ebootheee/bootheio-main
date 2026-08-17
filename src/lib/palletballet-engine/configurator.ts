/**
 * RawInputs → PalletConfig — port of `pallet_safety/configurator.py`.
 *
 * Pure business logic: look up SKUs, compute item positions for the stack
 * pattern, assemble a PalletConfig. Stack-pattern positioning uses the pallet
 * footprint and the largest item dimension as the cell size, which keeps small
 * items centered in their cell rather than packed edge to edge.
 */

import { get as getTemplate, type ItemTemplate } from './catalog.js';
import {
  type EnvCondition,
  type Item,
  type PalletConfig,
  type Vec3,
  WrapType,
} from './types.js';

export enum StackPattern {
  COLUMN = 'column',
  BRICK = 'brick',
  PINWHEEL = 'pinwheel',
  IRREGULAR = 'irregular',
}

export interface VisionLayout {
  pattern: StackPattern;
  layers: number;
  items_per_layer: number;
  lean_angle_deg: number;
  max_overhang_m: number;
}

export interface RawInputs {
  barcode_skus: string[];
  vision: VisionLayout;
  env: EnvCondition;
  body_temp_c: number;
  seconds_since_temp_change: number;
  pallet_id: string;
  base_pallet_type: string;
}

export interface StackSpec {
  sku: string;
  grid_row: number;
  grid_col: number;
  height: number;
}

/**
 * Python's `round()` uses banker's rounding; `Math.round` rounds half up.
 * `_grid_dims` calls `round(n ** 0.5)`, where a mathematical tie can't occur
 * for integer n — but a float sqrt landing exactly on .5 would diverge, and
 * matching costs three lines.
 */
function pyRound(x: number): number {
  const floor = Math.floor(x);
  const frac = x - floor;
  if (frac > 0.5) return floor + 1;
  if (frac < 0.5) return floor;
  return floor % 2 === 0 ? floor : floor + 1;
}

export const DEFAULT_BASE_DIMS: Vec3 = [1.2, 0.8, 0.15];
export const DEFAULT_BASE_MASS_KG = 25.0;

// ---- StackSpec path (used to build the curated scenarios) ----

/** Smallest (rows, cols) grid such that every stack's item fits in one cell. */
export function computeGridShape(
  stacks: StackSpec[],
  baseDimsM: Vec3 = DEFAULT_BASE_DIMS,
  fallback: [number, number] = [2, 3],
): [number, number] {
  if (stacks.length === 0) return fallback;
  let maxL = -Infinity;
  let maxW = -Infinity;
  for (const s of stacks) {
    const d = getTemplate(s.sku).dims_m;
    maxL = Math.max(maxL, d[0]);
    maxW = Math.max(maxW, d[1]);
  }
  return [
    Math.max(1, Math.floor(baseDimsM[1] / maxW)),
    Math.max(1, Math.floor(baseDimsM[0] / maxL)),
  ];
}

export interface BuildFromStacksOptions {
  pallet_id: string;
  env: EnvCondition;
  body_temp_c: number;
  wrap?: WrapType;
  base_type?: string;
  base_dims_m?: Vec3;
  base_mass_kg?: number;
  grid_shape?: [number, number];
  seconds_since_temp_change?: number;
}

/**
 * Build a PalletConfig from a list of StackSpec: each stack is a homogeneous
 * column of items in one grid cell.
 *
 * `grid_shape` defaults to one auto-computed from the items' actual sizes,
 * which guarantees adjacent items can't start in penetration (MuJoCo would
 * violently expel them at sim start).
 */
export function buildFromStacks(
  stacks: StackSpec[],
  opts: BuildFromStacksOptions,
): PalletConfig {
  const baseDimsM = opts.base_dims_m ?? DEFAULT_BASE_DIMS;
  const [rows, cols] = opts.grid_shape ?? computeGridShape(stacks, baseDimsM);
  const cellL = baseDimsM[0] / cols;
  const cellW = baseDimsM[1] / rows;
  const items: Item[] = [];
  const occupied = new Set<string>();

  for (const spec of stacks) {
    const tpl = getTemplate(spec.sku);
    // Skip stacks outside the auto-sized grid or landing on a taken cell —
    // both guarantee items never start overlapping.
    if (spec.grid_row >= rows || spec.grid_col >= cols) continue;
    const key = `${spec.grid_row},${spec.grid_col}`;
    if (occupied.has(key)) continue;
    occupied.add(key);
    const x = -baseDimsM[0] / 2.0 + (spec.grid_col + 0.5) * cellL;
    const y = -baseDimsM[1] / 2.0 + (spec.grid_row + 0.5) * cellW;
    let z = baseDimsM[2];
    for (let i = 0; i < spec.height; i++) {
      items.push({
        sku: tpl.sku,
        weight_kg: tpl.weight_kg,
        dims_m: tpl.dims_m,
        fragility: tpl.fragility,
        position: [x, y, z],
        orientation_deg: 0.0,
      });
      z += tpl.dims_m[2];
    }
  }

  return {
    pallet_id: opts.pallet_id,
    base_pallet_type: opts.base_type ?? 'EUR',
    base_dims_m: baseDimsM,
    base_mass_kg: opts.base_mass_kg ?? DEFAULT_BASE_MASS_KG,
    items,
    wrap: opts.wrap ?? WrapType.STRETCH,
    env: opts.env,
    body_temp_c: opts.body_temp_c,
    seconds_since_temp_change: opts.seconds_since_temp_change ?? 3600.0,
  };
}

// ---- RawInputs path (used by the random adapter and real vision input) ----

export interface ConfiguratorOptions {
  basePalletDimsM?: Vec3;
  basePalletMassKg?: number;
  defaultWrap?: WrapType;
}

export class Configurator {
  readonly basePalletDimsM: Vec3;
  readonly basePalletMassKg: number;
  readonly defaultWrap: WrapType;

  constructor(opts: ConfiguratorOptions = {}) {
    this.basePalletDimsM = opts.basePalletDimsM ?? DEFAULT_BASE_DIMS;
    this.basePalletMassKg = opts.basePalletMassKg ?? DEFAULT_BASE_MASS_KG;
    this.defaultWrap = opts.defaultWrap ?? WrapType.STRETCH;
  }

  build(raw: RawInputs): PalletConfig {
    return {
      pallet_id: raw.pallet_id,
      base_pallet_type: raw.base_pallet_type,
      base_dims_m: this.basePalletDimsM,
      base_mass_kg: this.basePalletMassKg,
      items: this.layOutItems(raw.vision, raw.barcode_skus),
      wrap: this.defaultWrap,
      env: raw.env,
      body_temp_c: raw.body_temp_c,
      seconds_since_temp_change: raw.seconds_since_temp_change,
    };
  }

  // ---- layout logic ----

  private layOutItems(vision: VisionLayout, skus: string[]): Item[] {
    if (skus.length === 0) return [];
    const layers = vision.layers;
    const perLayer = vision.items_per_layer;
    const expected = layers * perLayer;

    // Tolerate over/under-supplied SKUs by repeating then clamping, exactly as
    // `(skus * (1 + expected // max(1, len(skus))))[:expected]` does.
    const repeats = 1 + Math.floor(expected / Math.max(1, skus.length));
    const actual: string[] = [];
    for (let r = 0; r < repeats && actual.length < expected; r++) {
      for (const s of skus) {
        if (actual.length >= expected) break;
        actual.push(s);
      }
    }

    const items: Item[] = [];
    let zCursor = this.basePalletDimsM[2]; // start atop the pallet base
    for (let layerIdx = 0; layerIdx < layers; layerIdx++) {
      const layerSkus = actual.slice(layerIdx * perLayer, (layerIdx + 1) * perLayer);
      const [layerItems, layerHeight] = this.layOutLayer(
        layerSkus, layerIdx, vision, zCursor,
      );
      items.push(...layerItems);
      zCursor += layerHeight;
    }
    return items;
  }

  private layOutLayer(
    skus: string[], layerIdx: number, vision: VisionLayout, zBase: number,
  ): [Item[], number] {
    const templates: ItemTemplate[] = skus.map(getTemplate);
    if (templates.length === 0) return [[], 0];

    // Natural cell size = max item dim across this layer, per axis.
    let natL = -Infinity;
    let natW = -Infinity;
    let layerHeight = -Infinity;
    for (const t of templates) {
      natL = Math.max(natL, t.dims_m[0]);
      natW = Math.max(natW, t.dims_m[1]);
      layerHeight = Math.max(layerHeight, t.dims_m[2]);
    }

    // Bound the cell size to the pallet footprint so the grid can't span past
    // the base. Brick shifts odd layers by cell_l/2, so reserve that half-cell.
    const [cols, rows] = this.gridDims(templates.length, vision.pattern);
    const effectiveCols = cols + (vision.pattern === StackPattern.BRICK ? 0.5 : 0.0);
    const maxL = this.basePalletDimsM[0] / Math.max(effectiveCols, 1.0);
    const maxW = this.basePalletDimsM[1] / Math.max(rows, 1);
    const cellL = Math.min(natL, maxL);
    const cellW = Math.min(natW, maxW);

    const positions = this.cellPositions(
      templates.length, vision.pattern, layerIdx, cellL, cellW, cols, rows,
    );

    // Lean and overhang are anomalies applied on top of the grid.
    const leanOffsetX = (vision.lean_angle_deg / 8.0) * 0.05 * (layerIdx + 1);
    const overhangOffsetX = layerIdx === vision.layers - 1 ? vision.max_overhang_m : 0.0;

    const items: Item[] = templates.map((tpl, i) => ({
      sku: tpl.sku,
      weight_kg: tpl.weight_kg,
      dims_m: tpl.dims_m,
      fragility: tpl.fragility,
      position: [
        positions[i][0] + leanOffsetX + overhangOffsetX,
        positions[i][1],
        zBase,
      ] as Vec3,
      orientation_deg: this.orientation(vision.pattern, layerIdx),
    }));
    return [items, layerHeight];
  }

  /** (cols, rows) for n items. Column stacks everything in one cell. */
  private gridDims(n: number, pattern: StackPattern): [number, number] {
    if (n <= 1 || pattern === StackPattern.COLUMN) return [1, 1];
    const cols = Math.max(1, pyRound(Math.sqrt(n)));
    const rows = Math.floor((n + cols - 1) / cols);
    return [cols, rows];
  }

  private cellPositions(
    n: number, pattern: StackPattern, layerIdx: number,
    cellL: number, cellW: number, cols: number, rows: number,
  ): Array<[number, number]> {
    if (n === 0) return [];
    if (pattern === StackPattern.COLUMN) {
      return Array.from({ length: n }, () => [0.0, 0.0] as [number, number]);
    }
    const xOffsetPerLayer =
      pattern === StackPattern.BRICK && layerIdx % 2 === 1 ? cellL / 2.0 : 0.0;
    const x0 = (-cellL * (cols - 1)) / 2.0 + xOffsetPerLayer;
    const y0 = (-cellW * (rows - 1)) / 2.0;
    const out: Array<[number, number]> = [];
    for (let i = 0; i < n; i++) {
      out.push([x0 + (i % cols) * cellL, y0 + Math.floor(i / cols) * cellW]);
    }
    return out;
  }

  private orientation(pattern: StackPattern, layerIdx: number): number {
    return pattern === StackPattern.PINWHEEL && layerIdx % 2 === 1 ? 90.0 : 0.0;
  }
}
