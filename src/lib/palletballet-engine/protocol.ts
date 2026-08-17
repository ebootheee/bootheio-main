/** Message protocol between `client.ts` (main thread) and `worker.ts`. */

import type { SolveOptions } from './api.js';
import type { MockRandomOptions } from './mockRandom.js';
import type { PalletConfig } from './types.js';

export type EngineRequest =
  | { type: 'ping'; id: number }
  | { type: 'scenarios'; id: number }
  | { type: 'scenario'; id: number; slug: string }
  | { type: 'randomPallet'; id: number; options: MockRandomOptions }
  | { type: 'solve'; id: number; pallet: PalletConfig; options: SolveOptions }
  | { type: 'analyze'; id: number; pallet: PalletConfig };

export type EngineResponse =
  | { type: 'ready'; id: number }
  | { type: 'progress'; id: number; done: number; estTotal: number }
  | { type: 'result'; id: number; result: unknown }
  | { type: 'error'; id: number; message: string };
