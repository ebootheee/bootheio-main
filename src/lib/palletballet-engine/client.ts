/**
 * Main-thread client for the worker-hosted engine.
 *
 * Mirrors the HTTP client it replaces: same method names, same response shapes,
 * still promise-based. The differences that matter to a caller are that there
 * is no network and that `analyze` reports progress, because it is seconds of
 * real compute rather than a request.
 *
 *     const engine = createEngineClient();
 *     const scenarios = await engine.scenarios();
 *     const safety = await engine.analyze(pallet, (done, total) => …);
 */

import type {
  SafetyResponse,
  ScenarioSummary,
  SolveOptions,
  SolveResponse,
} from './api.js';
import type { MockRandomOptions } from './mockRandom.js';
import type { EngineRequest, EngineResponse } from './protocol.js';
import type { Scenario } from './scenarios.js';
import type { PalletConfig } from './types.js';

export type ProgressFn = (done: number, estTotal: number) => void;

/**
 * `Omit` over a union collapses to the keys the members share, so a plain
 * `Omit<EngineRequest, 'id'>` would lose `slug`/`pallet`/`options`. Distribute
 * it across the union members instead.
 */
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;
type RequestBody = DistributiveOmit<EngineRequest, 'id'>;

interface Pending {
  resolve: (v: any) => void;
  reject: (e: Error) => void;
  onProgress?: ProgressFn;
}

export interface EngineClientOptions {
  /** Supply the Worker yourself (e.g. `new EngineWorker()` from `?worker`). */
  worker?: Worker;
  /** Override the worker URL, for a host that serves it from a fixed path. */
  workerUrl?: URL;
  /** Called once the worker script is live (before the wasm has loaded). */
  onReady?: () => void;
}

/**
 * Bundlers detect workers by pattern-matching `new Worker(new URL(...,
 * import.meta.url))` in the source. It has to be written inline, exactly like
 * this — assigning the URL to a variable first makes the reference invisible
 * to static analysis, and the worker chunk (and with it the wasm asset) never
 * gets emitted. The `.ts` specifier is deliberate: this package ships source.
 */
function spawnDefaultWorker(): Worker {
  return new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });
}

export class EngineClient {
  private worker: Worker;
  private pending = new Map<number, Pending>();
  private nextId = 1;
  private readyPromise: Promise<void>;

  constructor(opts: EngineClientOptions = {}) {
    this.worker = opts.worker
      ?? (opts.workerUrl
        ? new Worker(opts.workerUrl, { type: 'module' })
        : spawnDefaultWorker());

    let resolveReady!: () => void;
    this.readyPromise = new Promise<void>((r) => { resolveReady = r; });

    this.worker.onmessage = (ev: MessageEvent<EngineResponse>) => {
      const msg = ev.data;
      if (msg.type === 'ready') {
        opts.onReady?.();
        resolveReady();
        return;
      }
      const p = this.pending.get(msg.id);
      if (!p) return;
      if (msg.type === 'progress') {
        p.onProgress?.(msg.done, msg.estTotal);
        return;
      }
      this.pending.delete(msg.id);
      if (msg.type === 'error') p.reject(new Error(msg.message));
      else p.resolve(msg.result);
    };

    this.worker.onerror = (ev) => {
      const err = new Error(`engine worker failed: ${ev.message}`);
      for (const [, p] of this.pending) p.reject(err);
      this.pending.clear();
    };
  }

  /** Resolves when the worker script is live. Loading the wasm is lazy. */
  ready(): Promise<void> {
    return this.readyPromise;
  }

  private send<T>(req: RequestBody, onProgress?: ProgressFn): Promise<T> {
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve, reject, onProgress });
      this.worker.postMessage({ ...req, id } as EngineRequest);
    });
  }

  /** Force the wasm module to load now, so the first real call isn't slower. */
  warmUp(): Promise<{ ok: boolean }> {
    return this.send({ type: 'ping' });
  }

  scenarios(): Promise<ScenarioSummary[]> {
    return this.send({ type: 'scenarios' });
  }

  scenario(slug: string): Promise<Scenario> {
    return this.send({ type: 'scenario', slug });
  }

  randomPallet(options: MockRandomOptions): Promise<PalletConfig> {
    return this.send({ type: 'randomPallet', options });
  }

  solve(pallet: PalletConfig, options: SolveOptions): Promise<SolveResponse> {
    return this.send({ type: 'solve', pallet, options });
  }

  analyze(pallet: PalletConfig, onProgress?: ProgressFn): Promise<SafetyResponse> {
    return this.send({ type: 'analyze', pallet }, onProgress);
  }

  terminate(): void {
    this.worker.terminate();
    this.pending.clear();
  }
}

export function createEngineClient(opts: EngineClientOptions = {}): EngineClient {
  return new EngineClient(opts);
}
