/**
 * @palletballet/engine — the pallet-safety physics engine, client-side.
 *
 * The same MuJoCo the server runs (same version, same fp64), compiled to WASM,
 * with the surrounding engine logic ported from Python. One call gets you a
 * ready analyzer:
 *
 *     const engine = await createEngine();
 *     const { result } = engine.analyze(palletConfig);
 *
 * Loading the WASM module is the only async step; every solve after that is
 * synchronous. Run it in a Web Worker if you don't want to block the UI thread
 * — a 40-item pallet takes a few seconds of straight compute.
 */

export * from './types.js';
export * from './profile.js';
export * from './friction.js';
export * from './failures.js';
export * from './catalog.js';
export * from './configurator.js';
export * from './mockRandom.js';
export * from './scenarios.js';
export { buildMjcf, type BuildMjcfOptions } from './mjcf.js';
export { configFingerprint } from './fingerprint.js';
export { PyRandom } from './pyrandom.js';
export {
  EngineApi,
  withComputedFields,
  type ReplayData,
  type ReplayItem,
  type SafetyResponse,
  type ScenarioSummary,
  type SolveOptions,
  type SolveResponse,
} from './api.js';
export {
  EngineClient,
  createEngineClient,
  type EngineClientOptions,
  type ProgressFn,
} from './client.js';
export {
  buildModel,
  downsample,
  loadMujocoModule,
  simulate,
  type MjData,
  type MjModel,
  type MujocoModule,
  type SimulateOptions,
  type SimulationTrace,
} from './solver.js';
export {
  DEFAULT_SEARCH,
  ThresholdAnalyzer,
  estimatedSims,
  type AnalysisResult,
  type AnalyzerOptions,
  type SearchConfig,
  type SweepAxis,
  type SweepPoint,
} from './threshold.js';

import { loadMujocoModule, type MujocoModule } from './solver.js';
import { ThresholdAnalyzer, type AnalyzerOptions } from './threshold.js';

export interface Engine {
  /** The raw WASM module, for callers that want to drive MuJoCo directly. */
  readonly mujoco: MujocoModule;
  readonly analyzer: ThresholdAnalyzer;
  analyze: ThresholdAnalyzer['analyze'];
  dispose(): void;
}

/** Load MuJoCo (once per page) and return a ready-to-use analyzer. */
export async function createEngine(opts: AnalyzerOptions = {}): Promise<Engine> {
  const mujoco = await loadMujocoModule();
  const analyzer = new ThresholdAnalyzer(mujoco, opts);
  return {
    mujoco,
    analyzer,
    analyze: analyzer.analyze.bind(analyzer),
    dispose: () => analyzer.dispose(),
  };
}
