---
title: "We Put the Pallet Solver on Two RTX 5090s. The Physics Had Other Plans."
excerpt: "The promised GPU experiment: MuJoCo Warp runs our exact models at over a million steps per second — then fails the agreement study because of weld constraints that never stop ringing in fp32. The float64 solver keeps the last word."
publishedAt: "2026-07-09T18:00:00.000Z"
draft: false
tags: ["physics", "mujoco", "gpu", "cuda", "simulation"]
categories: ["projects"]
---

At the end of [the PalletBallet launch post](/posts/launching-palletballet) I promised an experiment: if [MuJoCo Warp](https://github.com/google-deepmind/mujoco_warp) — the GPU reimplementation of the exact engine this project runs — could reproduce our solver's verdicts, one consumer GPU could handle the simulations behind hundreds of simultaneous safety decisions.

I ran the experiment. It's a better story than a speedup chart.

## The setup

MJWarp batches thousands of copies of one model, and our hot loop is exactly that shape: one pallet, many conveyor profiles. Instead of the CPU's bisection feeling out one edge of the safety envelope, a single batched call maps the whole 512-cell speed × acceleration surface. Migration cost: nearly zero — MJWarp eats the same compiled models we already build, and the failure detectors are just numpy over the pose trace.

And it *flies*. On one RTX 5090, 8,192 parallel worlds run at 1.2 million physics steps per second — 66× a CPU core. Every feasibility box ticked.

## The gate

This thing outputs safety limits, so a new backend doesn't get believed — it gets audited: 307 pallets × 72 conveyor profiles on both backends, 22,104 simulation pairs, identical detector code.

Verdict agreement: **55%**.

The GPU called 84% of all cells unsafe; the CPU, 42%. Some pallets failed every cell — including profiles where the belt barely moves. A pallet that fails at zero speed isn't physics, it's a bug wearing a physics engine.

![CPU vs GPU unsafe-rate heatmaps over the profile grid](/palletballet/gpu-agreement-heatmaps.svg)

## The bisection

Nearly all disagreements were one failure mode — items shifting relative to each other — on *wrapped* pallets. Our stretch-wrap model welds every box to the pallet base. Pulling that thread:

- **Settling?** No — a longer settle window makes it *worse*. It's steady-state oscillation, not compaction.
- **The integrator?** No — classic MuJoCo with the same Euler integrator at fp64 shows ~0.5 mm of drift where MJWarp shows 20 mm. Same model, same math on paper. It's the constraint solve in fp32.
- **Item count?** Very much yes. The ring survives at 12 boxes and vanishes below about 8 — it needs a weld network coupled through box-box contacts.

The minimal reproduction is twelve welded boxes sitting on a static plane. No conveyor, no actuators, nothing moves. Or should.

```
classic mujoco (fp64/euler): max item drift 0.040 mm
mujoco_warp   (fp32/euler): max item drift 8.600 mm
```

![Item drift vs time: fp64 settles at microns, fp32 rings at millimeters](/palletballet/gpu-weld-drift.svg)

Two hundred times the drift, sustained forever, in a scene with no energy input. Our load-shift detector fires at 20 mm; a full 48-box pallet rings past it. That's the entire 55% explained. I've reported the reproduction upstream — mjwarp is beta software under heavy development, and this is exactly what beta programs are for.

## What survives

Everything except the timeline. The architecture I landed on — **the GPU maps, the CPU decides** — is right regardless: the GPU sweeps the full failure landscape, the fp64 solver re-verifies the boundary cells the published number rests on, and every limit that leaves the API keeps float64 provenance. On unwrapped pallets agreement was already 92%, with errors almost all on the safe side.

And the gate is now a script. When the next mujoco-warp release lands, one command and two hours of machine time re-answer the question.

## The scoreboard

The launch post promised that a single consumer GPU could handle hundreds of simultaneous safety-margin decisions, on premise, with complete redundancy.

Verdict: **not yet — and now I know why, to the millimeter.** The throughput is real. The batching fits perfectly. One constraint type misbehaves in fp32, it's isolated, and it's the kind of thing that gets fixed. Until then, the fp64 solver keeps the last word on every number — which, for a system that keeps half-ton pallets off warehouse floors, is where the last word belongs.

Everything's on the [`gpu-spike` branch](https://github.com/ebootheee/palletballet/tree/gpu-spike): the GPU module, the benchmarks, the agreement study, and `PLAN_GPU.md` with the lab-notebook version of this story.

*— Eric*
