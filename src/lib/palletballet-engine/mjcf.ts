/**
 * PalletConfig → MuJoCo MJCF (XML) string — port of `pallet_safety/mjcf_builder.py`.
 *
 * Output is byte-identical to the Python builder; `test/mjcf.test.ts` asserts
 * that against exported fixtures. Keep it that way — it is what lets the parity
 * harness attribute any trajectory difference to the engine rather than to the
 * model description.
 */

import { DEFAULT_PAIR, frictionCoefficient, type SurfacePair } from './friction.js';
import { pyFixed, pyRepr, xmlEscape } from './pyformat.js';
import { type PalletConfig, WrapType } from './types.js';

// (sliding, torsional, rolling) friction triple per MuJoCo convention.
const TORSION = 0.005;
const ROLLING = 0.0001;

// Wrap stiffness in N/m (qualitative scale; tuned in Phase C with real sims).
const WRAP_STIFFNESS: Record<WrapType, number> = {
  [WrapType.NONE]: 0.0,
  [WrapType.SHRINK]: 200.0,
  [WrapType.STRETCH]: 800.0,
  [WrapType.BANDED]: 5000.0,
};

export interface BuildMjcfOptions {
  surfacePair?: SurfacePair;
  /** (length, width) of the modeled conveyor section. */
  conveyorSizeM?: [number, number];
  /** When true the conveyor is a body with a velocity actuator. */
  actuatedConveyor?: boolean;
  /** Emit `<contact><exclude>` for every welded pair (experimental). */
  excludeWeldContacts?: boolean;
}

export function buildMjcf(config: PalletConfig, opts: BuildMjcfOptions = {}): string {
  const {
    surfacePair = DEFAULT_PAIR,
    conveyorSizeM = [10.0, 2.0],
    actuatedConveyor = true,
    excludeWeldContacts = false,
  } = opts;

  const [muS] = frictionCoefficient(
    config.body_temp_c, config.seconds_since_temp_change, surfacePair,
  );
  const fric = `${pyFixed(muS, 4)} ${pyRepr(TORSION)} ${pyRepr(ROLLING)}`;

  const [baseL, baseW, baseH] = config.base_dims_m;
  const baseZ = baseH / 2.0; // body origin sits at base CoM

  const itemBodies = config.items.map((item, i) => {
    const [il, iw, ih] = item.dims_m;
    const [ipx, ipy, ipz] = item.position;
    const bz = ipz + ih / 2.0; // body origin at geom center
    return (
      `    <body name="item_${i}" pos="${pyFixed(ipx, 5)} ${pyFixed(ipy, 5)} ${pyFixed(bz, 5)}" ` +
      `euler="0 0 ${pyRepr(item.orientation_deg)}">\n` +
      `      <freejoint name="item_${i}_joint"/>\n` +
      `      <geom name="item_${i}_geom" type="box" ` +
      `size="${pyFixed(il / 2, 5)} ${pyFixed(iw / 2, 5)} ${pyFixed(ih / 2, 5)}" ` +
      `mass="${pyRepr(item.weight_kg)}" friction="${fric}"/>\n` +
      `    </body>`
    );
  });

  const equalities: string[] = [];
  if (WRAP_STIFFNESS[config.wrap] > 0) {
    // Weld each item to the pallet base to model wrap tension.
    for (let i = 0; i < config.items.length; i++) {
      equalities.push(
        `    <weld body1="pallet_base" body2="item_${i}" ` +
        `solref="0.02 1" solimp="0.95 0.99 0.001"/>`,
      );
    }
  }

  const eqBlock = equalities.length
    ? `  <equality>\n${equalities.join('\n')}\n  </equality>\n`
    : '';

  let contactBlock = '';
  if (equalities.length && excludeWeldContacts) {
    const n = config.items.length;
    const excludes: string[] = [];
    for (let i = 0; i < n; i++) {
      excludes.push(`    <exclude body1="pallet_base" body2="item_${i}"/>`);
    }
    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        excludes.push(`    <exclude body1="item_${i}" body2="item_${j}"/>`);
      }
    }
    contactBlock = `  <contact>\n${excludes.join('\n')}\n  </contact>\n`;
  }

  const itemsBlock = itemBodies.join('\n');
  const notesComment = config.notes
    ? `  <!-- notes: ${xmlEscape(config.notes)} -->\n`
    : '';
  const metaComment =
    `  <!-- meta: surface_pair=${surfacePair[0]}/${surfacePair[1]} ` +
    `mu_s=${pyFixed(muS, 4)} -->\n`;

  let conveyorBlock: string;
  let actuatorBlock: string;
  if (actuatedConveyor) {
    // Conveyor is a body with a slide joint along +X driven by a velocity
    // actuator. Its top surface sits at z = 0 to keep pallet placement consistent.
    conveyorBlock =
      `    <body name="conveyor_body" pos="0 0 -0.05">\n` +
      `      <joint name="conveyor_slide" type="slide" axis="1 0 0" damping="0.0"/>\n` +
      `      <geom name="conveyor" type="box" size="${pyRepr(conveyorSizeM[0])} ${pyRepr(conveyorSizeM[1])} 0.05" ` +
      `mass="500" friction="${fric}" material="beltmat"/>\n` +
      `    </body>`;
    actuatorBlock =
      '  <actuator>\n' +
      '    <velocity name="conveyor_motor" joint="conveyor_slide" kv="10000"/>\n' +
      '  </actuator>\n';
  } else {
    conveyorBlock =
      `    <geom name="conveyor" type="plane" size="${pyRepr(conveyorSizeM[0])} ${pyRepr(conveyorSizeM[1])} 0.1" ` +
      `pos="0 0 0" friction="${fric}" material="beltmat"/>`;
    actuatorBlock = '';
  }

  return `<?xml version="1.0" encoding="UTF-8"?>
<mujoco model="${xmlEscape(config.pallet_id)}">
  <compiler angle="degree" coordinate="local"/>
  <option timestep="0.002" gravity="0 0 -9.81" integrator="implicitfast"/>
  <asset>
    <material name="palletmat" rgba="0.55 0.38 0.22 1"/>
    <material name="itemmat" rgba="0.78 0.65 0.45 1"/>
    <material name="beltmat" rgba="0.25 0.25 0.28 1"/>
  </asset>
  <worldbody>
    <light pos="0 0 4" dir="0 0 -1" diffuse="0.8 0.8 0.8"/>
${conveyorBlock}
    <body name="pallet_base" pos="0 0 ${pyFixed(baseZ, 5)}">
      <freejoint name="pallet_joint"/>
      <geom name="pallet_geom" type="box" size="${pyFixed(baseL / 2, 5)} ${pyFixed(baseW / 2, 5)} ${pyFixed(baseH / 2, 5)}" mass="${pyRepr(config.base_mass_kg)}" friction="${fric}" material="palletmat"/>
    </body>
${itemsBlock}
  </worldbody>
${eqBlock}${contactBlock}${actuatorBlock}${metaComment}${notesComment}</mujoco>
`;
}
