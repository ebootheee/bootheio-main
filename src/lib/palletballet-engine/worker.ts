/**
 * Web Worker entry point.
 *
 * Two reasons this exists rather than calling the engine directly:
 *
 *  1. A full envelope search is up to ~9 s of uninterruptible compute on a
 *     large pallet (p50 0.38 s, p99 5 s). On the UI thread that is a frozen
 *     page, so it runs here and reports progress as it bisects.
 *  2. It keeps the 2.5 MB (gzip) wasm off the critical path. Requests that are
 *     pure data — scenarios, a seeded random pallet — are answered without
 *     touching MuJoCo, so the download only happens when the user actually
 *     dispatches a pallet.
 *
 * Spawn it with `createEngineClient()` from `client.ts` rather than wiring the
 * message protocol by hand.
 */

import { EngineApi, withComputedFields } from './api.js';
import { Configurator } from './configurator.js';
import { MockRandomAdapter } from './mockRandom.js';
import { allScenarios, getScenario } from './scenarios.js';
import { loadMujocoModule } from './solver.js';
import { stackHeightM, totalMassKg } from './types.js';
import type { EngineRequest, EngineResponse } from './protocol.js';

let api: EngineApi | null = null;
let currentId = 0;

function post(msg: EngineResponse): void {
  (self as unknown as Worker).postMessage(msg);
}

/** Loads the wasm on first use. Only physics requests go through here. */
async function ensureApi(): Promise<EngineApi> {
  if (!api) {
    const mj = await loadMujocoModule();
    // Progress events carry the id of the request in flight; `analyze` is the
    // only long call and only one runs at a time in a worker.
    api = new EngineApi(mj, (done, estTotal) => {
      post({ type: 'progress', id: currentId, done, estTotal });
    });
  }
  return api;
}

self.onmessage = async (ev: MessageEvent<EngineRequest>) => {
  const req = ev.data;
  currentId = req.id;
  try {
    let result: unknown;
    switch (req.type) {
      // ---- data only: no wasm ----
      case 'scenarios':
        result = allScenarios().map((s) => ({
          slug: s.slug,
          name: s.name,
          tag: s.tag,
          description: s.description,
          expected_failure: s.expected_failure,
          item_count: s.pallet.items.length,
          total_mass_kg: totalMassKg(s.pallet),
          stack_height_m: stackHeightM(s.pallet),
        }));
        break;
      case 'scenario': {
        const s = getScenario(req.slug);
        result = { ...s, pallet: withComputedFields(s.pallet) };
        break;
      }
      case 'randomPallet':
        result = withComputedFields(
          new Configurator().build(new MockRandomAdapter(req.options).read()),
        );
        break;

      // ---- physics: loads the wasm ----
      case 'ping':
        await ensureApi();
        result = { ok: true };
        break;
      case 'solve':
        result = (await ensureApi()).solve(req.pallet, req.options);
        break;
      case 'analyze':
        result = (await ensureApi()).analyze(req.pallet);
        break;
      default: {
        const exhaustive: never = req;
        throw new Error(`unknown request ${JSON.stringify(exhaustive)}`);
      }
    }
    post({ type: 'result', id: req.id, result });
  } catch (e) {
    post({
      type: 'error',
      id: req.id,
      message: e instanceof Error ? e.message : String(e),
    });
  }
};

// The worker script is live; the wasm module still loads lazily.
post({ type: 'ready', id: 0 });
