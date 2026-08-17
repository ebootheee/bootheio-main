/**
 * Curated demo scenarios — the canonical trust-building set.
 *
 * `src/data/scenarios.json` is generated from `pallet_safety/scenarios.py` by
 * `scripts/export_engine_data.py`, already built into PalletConfigs. They are
 * data, not logic: exporting them keeps the pallet a visitor topples in the
 * browser byte-identical to the one the API and the test suite use, without
 * re-porting `build_from_stacks` and hoping it stays in sync.
 */

import raw from './data/scenarios.json' with { type: 'json' };
import type { ConveyorProfile } from './profile.js';
import type { PalletConfig } from './types.js';

export interface Scenario {
  slug: string;
  name: string;
  tag: string;
  description: string;
  expected_failure: string;
  pallet: PalletConfig;
  suggested_profile: ConveyorProfile;
}

const SCENARIOS = raw as unknown as Scenario[];

export function allScenarios(): Scenario[] {
  return SCENARIOS;
}

export function scenarioSlugs(): string[] {
  return SCENARIOS.map((s) => s.slug);
}

export function getScenario(slug: string): Scenario {
  const s = SCENARIOS.find((x) => x.slug === slug);
  if (!s) {
    throw new Error(`unknown scenario '${slug}'; have ${scenarioSlugs().join(', ')}`);
  }
  return s;
}

export function getScenarioByName(name: string): Scenario {
  const s = SCENARIOS.find((x) => x.name === name);
  if (!s) throw new Error(`unknown scenario name '${name}'`);
  return s;
}
