/**
 * SKU catalog — port of `pallet_safety/catalog.py`.
 *
 * `src/data/sku_catalog.json` is generated from `data/sku_catalog.csv` by
 * `scripts/export_engine_data.py`, as an **ordered array**. That ordering is
 * load-bearing: `byEnv()` returns templates in catalog order and the result is
 * fed to `PyRandom.choice()`, so re-sorting the catalog would hand the same
 * seed a different SKU.
 */

import raw from './data/sku_catalog.json' with { type: 'json' };
import { EnvCondition, FragilityClass, type Vec3 } from './types.js';

export interface ItemTemplate {
  sku: string;
  name: string;
  weight_kg: number;
  dims_m: Vec3;
  fragility: FragilityClass;
  category: string;
  default_env: EnvCondition;
}

const TEMPLATES: ItemTemplate[] = (raw as any[]).map((r) => ({
  sku: r.sku,
  name: r.name,
  weight_kg: r.weight_kg,
  dims_m: r.dims_m as Vec3,
  fragility: r.fragility as FragilityClass,
  category: r.category,
  default_env: r.default_env as EnvCondition,
}));

const BY_SKU = new Map(TEMPLATES.map((t) => [t.sku, t]));

export function get(sku: string): ItemTemplate {
  const t = BY_SKU.get(sku);
  if (!t) throw new Error(`unknown SKU: ${sku}`);
  return t;
}

/** Sorted, matching Python's `sorted(load_catalog().keys())`. */
export function allSkus(): string[] {
  return [...BY_SKU.keys()].sort();
}

/** Catalog order, NOT sorted — see the note at the top of this file. */
export function byEnv(env: EnvCondition): ItemTemplate[] {
  return TEMPLATES.filter((t) => t.default_env === env);
}

export function byCategory(category: string): ItemTemplate[] {
  return TEMPLATES.filter((t) => t.category === category);
}

export function allTemplates(): ItemTemplate[] {
  return TEMPLATES;
}
