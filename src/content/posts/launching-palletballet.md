---
title: "PalletBallet: A Physics Solver You Can Lose a Game To"
excerpt: "Per-pallet conveyor speed governance with MuJoCo — a live 3D game on this site, a FastAPI you can curl, a batch runner that chews through 7 pallets a second, and the whole thing served off a home server through a Cloudflare Tunnel. Clone it, run it, point my game at your instance."
publishedAt: "2026-07-07T21:30:00.000Z"
draft: false
tags: ["physics", "mujoco", "fastapi", "self-hosting", "simulation"]
categories: ["projects"]
---

Opus 4.6 made me realize that I could transpose "what if" ideas somewhat easily into functional reality. Physics simulations in their many forms have always interested me -- the idea that math and code could, given enough parameters, emulate the real world is especially important in the fields that I work in (logistics, energy, and built environments). A friend pointed me in the direction of logistics automations and how friction coefficients in cold-storage (big refrigerated/frozen warehouses that touch virtually every perishable food good in the world) makes automation more complicated than traditional warehouses: transitional temperature changes, an innately hostile environment, and mixed palletization (many good types on one pallet) are just some of the physics challenges that means every pallet must be simulated and handled slightly differently.

Conveyor automation is just a big system of acceleration and speed. So, to make that system optimal, you must first solve the safe limits for both that speed and acceleration on an individual pallet basis. My question became: could Claude help me build a physics engine that could take a series of inputs (pallet type, goods, some machine vision data, etc.) and simulate individual pallet conveyor safety limits within a few 100ms and then feed those safety limits to the conveyor system?

## Overview

Cold-storage warehouses run pallets down conveyors at speeds chosen by a table. One number for everything: the perfectly wrapped dairy slab and the unwrapped, top-heavy tower of frozen meat both get 1.0 m/s. The first is being throttled for no reason. The second is being launched.

**[PalletBallet](https://boothe.io/palletballet)** replaces the table with physics. Describe a pallet — geometry, masses, wrap, temperature — and it runs a batch of MuJoCo simulations to answer a narrow question: *what conveyor motion can this specific pallet survive, right now?* Out comes a speed limit, an acceleration limit, the failure mode that would otherwise govern, and a full 6-DoF replay of the moment it would have gone over.

Before reading any further, go play with it: **[boothe.io/palletballet](https://boothe.io/palletballet)**. You get the speed and acceleration dials before the solver shows its answer. Every dispatch is a live simulation on my home server — the 3D replay you watch is the physics engine's own pose trace, not an animation. Wreck a pallet, watch it in quarter-speed slow motion, then see the envelope you should have dialed.

This post is the technical tour: the physics model, the failure detectors, the envelope search, the full API with copy-paste `curl` for everything, the batch runner, and how to run the whole stack yourself — including pointing *my* game page at *your* clone.

Source: **[github.com/ebootheee/palletballet](https://github.com/ebootheee/palletballet)**

## The shape of the system

Everything converges on one Pydantic contract and flows through one pipeline:

```text
Scanner / WMS / manual stack builder / random adapter
        |
        v
    RawInputs ──► Configurator ──► PalletConfig
                                       |
                     +─────────────────+─────────────────+
                     |                 |                 |
                     v                 v                 v
              MJCF builder      /solve (one run)   /safety/analyze
              (MuJoCo XML)      → failure + replay → envelope search
                                                       |
                                                       v
                                                  SafetyResult
```

`PalletConfig` is the center of gravity. It's a validated, JSON-serializable description of a pallet: base dimensions and mass, a list of items (each with SKU, weight, dims, fragility, position, orientation), wrap type, thermal environment, and body temperature. Computed fields give you the total mass, the composite center of mass, stack height, and overhang for free. Every entry point — the operator console, the HTTP API, the batch runner, the web game — speaks this one type.

## The physics: pallets are MJCF documents

Each pallet becomes a MuJoCo scene via a small builder (~140 lines). The important decisions:

**Every item is a free body.** No fixed joints, no simplified "one rigid load" assumption. Each carton gets a `freejoint`, so it can slide, tip, and tumble independently — which is exactly what unwrapped loads do:

```xml
<body name="item_3" pos="0.15 -0.20 0.49">
  <freejoint name="item_3_joint"/>
  <geom name="item_3_geom" type="box" size="0.175 0.125 0.06"
        mass="6.0" friction="0.2705 0.005 0.0001"/>
</body>
```

**Wrap is a constraint, not a rigid merge.** Shrink, stretch, and banded wrap become MuJoCo `<equality>` welds between each item and the pallet base, with compliance tuned per wrap type. `WrapType.NONE` emits nothing — gravity and friction are all that holds the load. This is why the "tall unwrapped tower" scenario in the game comes apart so photogenically.

**The conveyor is a velocity-actuated body.** The belt is a giant box on a slide joint driven by a velocity servo, so a conveyor profile (ramp to target, hold, decelerate) is just a control signal over time. Belt-to-pallet slip falls out of the contact solver for free.

**Friction comes from a temperature model.** This is the cold-chain part, and it's the detail I care most about:

![Friction coefficient vs pallet temperature, showing the frost-melt dip near 0 °C](/palletballet/friction-curve.svg)

The friction module interpolates a calibration table per surface pair (`wood_pallet/rubber_belt`, plastic variants, etc.) and applies a *transition penalty* when a pallet is near 0 °C shortly after a thermal change — the frost-melt regime, where a film of melting frost between the pallet and the belt drops μ by roughly a third. Anyone who has watched a pallet come out of a −25 °C room onto a warm dock knows this regime. A static speed table doesn't.

## Four ways to die on a conveyor

The solver records a full trace — pallet pose, every item's pose, belt state — at every 2 ms physics step. Failure detection is then pure post-processing over the trace, one detector per mode:

| Mode | Detector | Default threshold |
|---|---|---|
| `tip_over` | pallet tilt off world-vertical | 8° |
| `top_item_slide` | any item's displacement in the *pallet frame* | 5 cm |
| `load_shift` | max change in item-to-item pairwise distances | 2 cm |
| `pallet_slip` | ∫belt velocity − pallet displacement | 30 cm |

`first_failure()` returns the earliest event across all four. The distinction between `top_item_slide` (one item moving relative to the pallet) and `load_shift` (the load rearranging internally) matters operationally: the first means re-wrap the top layer, the second means the stacking pattern is wrong.

Because detectors run on the trace instead of inside the sim loop, adding a new failure mode is a ~15-line function, and the same trace that produced the verdict becomes the replay you watch in the game.

## The envelope search: bisection with a model cache

`/safety/analyze` answers "what's the *maximum* safe speed and acceleration?" with a bisection search along each axis, assuming failure is monotone in speed/accel (true for friction-driven slip and inertia-driven tips; resonance is out of scope and documented as such).

The two performance tricks that make it interactive:

1. **Compile once, simulate many.** The MJCF → `MjModel` compile is the expensive part. The analyzer caches compiled models by config fingerprint, so the 5–8 sims of a search reuse one model.
2. **Fail fast.** Each probe sim aborts the instant the pallet crosses the tip threshold or an item slides past the limit — a clearly-failing run costs a fraction of its nominal duration.

Real numbers from the machine serving the live demo (Ryzen 9, single request):

```text
POST /solve   (one profile, with full replay)   ~70–200 ms
POST /safety/analyze (5–8 sims, bisection)      ~400–800 ms
POST /safety/analyze (cache hit)                ~1 ms
```

Results are cached by a SHA-256 fingerprint of the physically-relevant config fields, so analyzing the same pallet twice is free — you can see this live in the game's API console, where a second dispatch of the same scenario shows `0 sims · cached`.

## The API, endpoint by endpoint

Everything below is live at `https://palletballet-api.boothe.io` (rate-limited at the edge; be reasonable). The interactive docs are at [/docs](https://palletballet-api.boothe.io/docs).

**Get the curated scenarios** — the exact pallets the game and the operator console use, one trust-building baseline and four engineered failures plus a randomized scanner payload:

```bash
curl -s https://palletballet-api.boothe.io/scenarios | jq -r '.[].slug'
# stable-dairy-slab, frozen-meat-sprint, tall-unwrapped-tower, ...

curl -s https://palletballet-api.boothe.io/scenarios/tall-unwrapped-tower | jq .pallet
```

**Generate a random pallet** through the same adapter path a real camera/WMS integration would use:

```bash
curl -s -X POST https://palletballet-api.boothe.io/pallet/random \
  -H 'content-type: application/json' \
  -d '{"seed": 23, "anomaly_rate": 0.25, "min_layers": 2, "max_layers": 5}'
```

**Run one conveyor profile and get the replay.** `include_replay: true` attaches per-frame world poses (position + `wxyz` quaternion) for the pallet and every item, plus integrated belt displacement — everything a renderer needs, ~60–100 KB at 30 Hz:

```bash
PALLET=$(curl -s https://palletballet-api.boothe.io/scenarios/tall-unwrapped-tower | jq .pallet)
curl -s -X POST https://palletballet-api.boothe.io/solve \
  -H 'content-type: application/json' \
  -d "{\"pallet\": $PALLET,
       \"profile\": {\"target_speed_mps\": 2.0, \"accel_mps2\": 6.0, \"duration_s\": 1.5},
       \"include_replay\": true}" | jq .failure
# { "mode": "top_item_slide", "time_s": 0.242, ... }
```

**Compute the safe envelope:**

```bash
echo "$PALLET" | curl -s -X POST https://palletballet-api.boothe.io/safety/analyze \
  -H 'content-type: application/json' -d @- | jq .result
# max_speed_mps, max_accel_mps2, dominant_failure_mode, margin, confidence, config_hash
```

**Batch a list of pallets** — the cache is shared across the batch, so duplicates cost ~nothing:

```bash
curl -s -X POST https://palletballet-api.boothe.io/safety/batch \
  -H 'content-type: application/json' \
  -d "[$PALLET, $PALLET]" | jq 'map(.sims_run)'
# [8, 0]  ← the second one was free
```

There are also endpoints for the SKU catalog, the friction model (`/friction/curve` gives you the chart above as data), raw MJCF export if you want to load a pallet in the MuJoCo viewer, and config validation. The game's collapsible "API traffic" console shows each of these being called with a copy-as-curl button — the page *is* the API documentation, demonstrated.

## Batching: 400 pallets, 53 seconds, one chart I didn't expect

The repo ships `scripts/batch_study.py`, a ~80-line batch runner that fans pallets across worker processes, each owning its own analyzer (so model caches never contend). On a 16-core Ryzen it does about **7.5 pallets/second** — 400 random pallets, 1,254 MuJoCo simulations, 53 seconds wall:

```bash
uv run python scripts/batch_study.py --n 400 --workers 14 --out study.json
```

What governs, when something does:

![Failure mode distribution across 400 random pallets](/palletballet/batch-modes.svg)

And the distribution of the solver's max-safe-speed answers, which is the chart that surprised me:

![Distribution of max safe speed across 400 random pallets — strongly bimodal](/palletballet/batch-speeds.svg)

I expected a bell curve centered somewhere around 1 m/s. Instead it's starkly bimodal: **242 of 400 pallets are comfortable at the 2.0 m/s search ceiling, 131 are unsafe at *any* speed** (they fail even at the 0.1 m/s search floor — their problem is load construction, not velocity), and only 27 live in the boundary band in between.

That reframes what per-pallet governance is *for*:

- For the 60% at the ceiling, the fixed 1.0 m/s table is pure throughput tax — they could run twice as fast.
- For the 33% that fail at any speed, no speed limit saves them. The right output isn't a slower zone, it's a **reject-and-rewrap signal** before they ever enter the conveyor — which the API's dominant-failure-mode field gives you directly (86 of those 131 are `load_shift`: bad stacking, not bad driving).
- The 7% in the middle is where the speed dial actually decides the outcome — and where a physics answer beats a table by the widest margin.

One number is a search artifact worth knowing about: `SearchConfig` bounds the sweep at 2.0 m/s and 5.0 m/s² because that's the realistic conveyor range; "at the ceiling" means "safe throughout the operating range," not "infinitely stable."

## The web game: replaying MuJoCo in three.js

The [demo page](https://boothe.io/palletballet) renders the solver's trace in a three.js scene. Two implementation notes for anyone building something similar:

**Coordinate frames.** MuJoCo is Z-up with quaternions in `(w, x, y, z)`; three.js is Y-up with `(x, y, z, w)`. Rather than converting every pose, the scene puts all bodies inside one parent `Group` rotated −90° about X. Children then use raw MuJoCo positions and reordered quaternions unmodified, and per-frame playback is just lerp on positions + slerp on quaternions between the 30 Hz trace frames.

**The replay is the API response.** There is no game physics in the browser. `POST /solve` with `include_replay: true` returns the downsampled pose history; the client interpolates between frames, scrolls the belt texture by the integrated belt displacement the API provides, and drops to quarter speed around the failure timestamp. If the replay looks like the physics, that's because it *is* the physics.

The scoring layer on top is simple by design: the envelope search runs concurrently with your dispatch, gets revealed only after the replay ends, and your points are the fraction of the solver's max speed you dared to use — survive at 85%+ of the ceiling and you're "dialed in," crash and you're buying yogurt.

## Run it yourself (and play against your own instance)

The whole stack is a single container:

```bash
git clone https://github.com/ebootheee/palletballet.git
cd palletballet

# Local dev: API on :8000 + Streamlit operator console on :8501
uv sync && uv run python scripts/start_dev.py

# Or the same container the live demo runs:
docker build -t palletballet . && docker run -p 8000:8000 palletballet
```

Here's the part I like: the live demo page accepts an `?api=` override, and the API's default CORS allowlist includes `boothe.io`. Which means once your local instance is up:

```text
https://boothe.io/palletballet?api=http://localhost:8000
```

…is my game UI playing against **your** solver, on your machine, with zero configuration. Every dial, replay, and envelope reveal now exercises your clone.

### The hosting story

The production wiring is deliberately boring and fully described in `infra/`:

- **GitHub Actions** builds the image on every push to `main` and pushes it to GHCR.
- **Watchtower** on the home server polls every 5 minutes and swaps the container.
- **Cloudflare Tunnel** (`cloudflared` sidecar) publishes `:8000` as `palletballet-api.boothe.io` — no open ports, no reverse proxy config, WAF rate-limiting at the edge.
- This page is Astro on Cloudflare Workers, calling the tunnel over CORS.

Push to main → live in under six minutes, on hardware I can physically kick.

## What I'd build next

- **Real inputs.** The `RawInputs` contract was designed for a depth-camera + barcode adapter; the mock random adapter proves the path. A cheap overhead camera and a segmentation model would close the loop.
- **Deceleration and cornering.** The solver already sweeps decel and reports lateral-g tolerance; the interesting production question is zone-to-zone handoff profiles.
- **Calibration.** The friction table and wrap stiffnesses are literature-plausible starting points. A day of instrumented runs on a real line would turn them into measurements — the code paths are already parameterized for it.

The system is a demo of a shape I keep coming back to: a physics engine behind a typed API, a search on top of the simulation, and a UI whose only job is to make you *believe* the numbers by letting you fail interactively. If you build something on the API, or beat an S-grade shift, I want to hear about it.

*— Eric*
