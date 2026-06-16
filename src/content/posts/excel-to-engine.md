---
title: "Excel-to-Engine: Turning 80MB Financial Models into a CLI Claude Can Navigate"
excerpt: "Large financial models don't fit in a context window. A Rust transpiler, a semantic manifest, and a Claude Code skill file turn them into something Claude can actually reason about — 10x faster, ~95% less context."
publishedAt: "2026-04-22T21:08:37.623Z"
updatedAt: "2026-04-22T21:10:08.323Z"
draft: false
tags: []
---

It's really hard to load large XLS financial models into Claude — particularly those with 100,000+ formulas. It's even harder to give Claude the skills to navigate these models in a way that's accurate and useful for quick scenario modeling in chat, or for transforming that model into other applications.

So I built **[excel-to-engine](https://github.com/ebootheee/excel-to-engine)** — a tool that transpiles and deconstructs large financial models (think 6M+ cells, 2M+ formulas, 80+MB) and wraps them in a CLI. The result is ~10x the speed and ~95% reduced context window and token usage with Claude. Claude Code is very good at navigating CLIs when it gets the proper context, so the repo ships with a comprehensive skill file. Tell Claude to `git clone` the repo, read the docs, and start turning your models into applications.

## The 60-second demo

```bash
# 1. Build the parser (one-time)
cd pipelines/rust && cargo build --release && cd ../..

# 2. Parse your model — handles everything: parse, manifest, auto-detect metrics
node cli/index.mjs init model.xlsx --output ./my-model/

# 3. Ask questions
node cli/index.mjs summary ./my-model/chunked/
node cli/index.mjs scenario ./my-model/chunked/ --exit-multiple 16 --revenue-adj techGP:-20%
node cli/index.mjs sensitivity ./my-model/chunked/ --vary exit-multiple:14-22:2 --vary exit-year:2028-2034:1 --metric grossIRR
```

That's it. The CLI auto-generates a model manifest (mapping EBITDA, IRR, carry, equity to the right cells), runs a smart refinement pass, and is ready for scenario analysis immediately.

## What Claude can actually ask

Once a model is parsed, Claude doesn't load the whole thing into context to answer questions — it queries the CLI. A sample of what that covers across the PE stakeholder chain:

- **Analyst / VP:** "What's IRR if exit multiple drops 2 turns?" → `ete scenario --exit-multiple X`
- **Partner:** "Attribution — why did IRR drop 5pp?" → `ete compare --attribution`
- **LP / IR:** "TVPI, DPI, RVPI, net IRR" → `ete query --name tvpi`
- **Portfolio CFO:** "What's FCF if rates go up 100bps?" → `ete eval <cell> --inputs '{"Assumptions!Rate": 0.08}'`
- **Audit:** "Where does totalCarry come from?" → `ete explain totalCarry`

Every agent-consumed output supports `--compact` — ~60% fewer tokens than `--format json`.

## Under the hood

There are two pipelines:

- A **Claude-skill-based engine** for simpler models. Fast to set up, great for quick one-offs.
- A **Rust transpiler** that recognizes and transpiles 60+ Excel functions. This is what lets the tool chew through 6M+ cells in reasonable time — it's calamine-based, roughly 10–50x faster than SheetJS.

When you run a scenario, the CLI doesn't re-execute the full engine (which can take 10+ minutes on large models). Instead it reads the base case from ground truth JSON, applies your adjustments to the annual P&amp;L, and recomputes the chain: exit EBITDA → terminal value → exit equity → MOIC → IRR → carry. Newton-Raphson for IRR, American/European waterfall for carry.

The CLI accepts JSON inputs for stringing together compound two-dimensional queries. There's also a full eval suite, including complex randomized evals that use a Claude API key to generate questions and interrogate your model directly — so you can verify accuracy on your own data rather than trusting benchmark numbers.

## Accuracy

A fresh Claude API session with zero knowledge of the engine answers 25 randomized financial questions per model. Across 9 real models spanning 15.5M cells:

- Fund model A (2 sheets, 5.7K cells): **25/25 (100%)**
- Fund model B (7 sheets, 96K cells): **25/25 (100%)**
- Platform model A (51 sheets, 1.8M cells): **25/25 (100%)**
- Platform model B (60 sheets, 1.8M cells): **25/25 (100%)**
- Corporate model A (20 sheets, 5.8M cells): **25/25 (100%)**
- Corporate model B (21 sheets, 6.1M cells): **24/25 (96%)**

Total: **149/150 (99.3%)**.

## Try it

It's a public repo:

```bash
git clone https://github.com/ebootheee/excel-to-engine.git
```

Point Claude Code at it, have it read `skill/SKILL.md` and the README, and start turning your models into applications. If you fix something along the way, tell Claude to open a PR.
