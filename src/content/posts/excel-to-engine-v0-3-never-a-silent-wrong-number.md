---
title: "excel-to-engine v0.3: Never a Silent Wrong Number"
excerpt: "The parser dependency was silently corrupting 30% of a 6M-cell financial model — and every test passed. v0.3.0 is the correctness campaign that found it: warm-ground-truth diagnostics, negative-controlled regressions, and an engine contract where the only forbidden failure mode is a plausible wrong number."
updatedAt: "2026-06-10T03:38:45.340Z"
draft: true
tags: []
---

A few months ago I wrote about [excel-to-engine](https://github.com/ebootheee/excel-to-engine) — a tool that transpiles big Excel financial models (6M+ cells, 2M+ formulas) into JavaScript engines and wraps them in a CLI that Claude can drive. That post was about _access_: getting a model too big for any context window into a form an AI assistant could navigate.

This release, **v0.3.0**, is about something harder: **trust**. Over the last few weeks the project went through a correctness campaign against a real ~6M-cell private equity model, and what it surfaced changed how I think about the whole problem. The short version: the scariest bugs in financial software are not crashes. They're plausible numbers.

## The bug that hid in 30% of a model

The campaign's centerpiece was a hunt for a `#DIV/0!` that kept zeroing out a fund's carry waterfall. The trail ended somewhere I didn't expect: the Excel _parser dependency_ had been silently corrupting **1,745,461 cells — 30% of the model** — for the entire life of the project.

Here's the mechanism, because it's a beautiful trap. An `.xlsx` file doesn't store every formula. When you fill a formula across a range, Excel stores one **shared formula** — the master — and every other cell just says "same as the master, offset by my position." The parser has to re-expand that, and the expansion must respect Excel's anchor semantics: `$AO17` keeps its column fixed when filled right; `L$7` keeps its row fixed when filled down.

The parser library's expansion routine was **`$`-blind** — a `$` split the reference into pieces during tokenization. The result:

- `$AO17` (column-absolute) was offset as if relative — **wrongly shifted** - `L$7` (row-anchored) never parsed as a reference at all — **wrongly frozen** - plain-relative and fully-absolute references both came out correct, _by accident_

That last line is why it survived so long. Most formulas use simple anchoring, so most numbers were right. The casualties were exactly the **mixed-anchor idioms** that financial models lean on — `AVERAGEIFS($AO17:$MC17, $AO$7:$MC$7, ">"&L$7, ...)`, lookup windows pinned to a date axis, ratio rows against fixed denominators. The capital-call schedule fed by those formulas drifted, the cash-flow row it aggregated went to zero, and the returns waterfall divided by it. The visible symptom was three sheets away from the cause.

## How you find a bug like that

You can't eyeball 6 million cells. The diagnostic that cracked it is the most useful idea in the project, and it's almost embarrassingly simple:

**Seed the engine with Excel's own answers, recompute once, and diff every write.**

Every conversion ships `_ground-truth.json` — the value Excel computed for every cell. A _faithful_ transpiled formula, given all of its inputs at their ground-truth values, must reproduce its own ground-truth output. There is no convergence to wait for, no cold-start transient to excuse it. One pass, seconds per sheet, and **every divergence is a transpiler defect by definition.**

The first run printed 9,819 divergences on the returns sheet, and the first rows of them carried a signature you could read like a fingerprint: `got(Y17) == GT(N17)`. Each cell held the value that belonged _eleven columns to its left_ — the exact fill offset of the shared-formula group. Column-shift, not math error. Parser, not transpiler.

## Why no test ever caught it

The project had a 78-case synthetic smoke suite that passed 100% throughout. It never stood a chance, and the reason is the kind of thing that should worry anyone who trusts their fixtures: the library used to _generate_ test workbooks (SheetJS) **never writes shared formulas** — it expands every formula into every cell. So every synthetic fixture exercised the parser's easy path, and the entire bug class was structurally invisible to the test suite.

The regression that now guards it had to be built by hand-zipping an `.xlsx` with real `<f t="shared">` XML elements. And per project discipline, the test had to go **red on the old parser with the exact predicted wrong values** before the fix counted — a negative control, so you know the test is actually wired to the failure and not just passing vacuously.

That discipline — _a fix doesn't exist until a test reproduces the bug it claims to fix_ — caught its own reward here: the fix was a dependency upgrade (the library had quietly fixed `$`-anchors upstream) plus hardening our own tokenizer against a sibling bug it shared (`LOG10` parsed as cell `LOG10` — column LOG, row 10 — instead of a function).

## Never a silent wrong number

The deeper theme of v0.3.0 is a design principle that sounds obvious and isn't: **a financial engine must never return a confident wrong number.** Plausible-but-wrong is strictly worse than visibly broken, because nobody re-checks a plausible number. The release enforces it in layers:

- **Excel's errors propagate like errors.** The old aggregate reducer pattern `(+x||0)` meant `=SUM(100, 0/0, 250)` returned **350** — it silently dropped the `#DIV/0!` and kept adding. Now division errors collapse to a NaN sentinel that flows through `SUM`/`SUMIFS`/`AVERAGE` the way `#DIV/0!` flows through Excel, and `IFERROR` catches it exactly where Excel would. - **Honest convergence.** Real models are circular — returns feed debt sizing feeds fees feeds returns. The engine iterates those clusters to a fixed point, tolerating transients (a divide-by-cold-zero that warms as the cluster solves is fine). But a cluster that does _not_ converge reports `converged: false` and **NaN-fills every cell it wrote**. Detectably unusable beats confidently stale. - **The measuring stick obeys the same rules.** The fast eval harness used to warm-seed clusters from ground truth and report ~100% accuracy on clusters the shipped engine refuses to trust. Now it applies the identical contract, in lockstep, down to converging on the same pass. If the accuracy number says 99%, that's the accuracy of what actually ships. - **Fidelity down to the quirks.** Dates are integer Excel day-serials including the phantom **February 29, 1900** (Excel inherited Lotus 1-2-3's leap-year bug and keeps it forever; a real sheet in the real model depends on it). XIRR uses Excel's 365-day year basis — the engine had 365.25, which put a polite, wrong drift in the fourth decimal of every IRR. Nobody would have caught that by looking.

## Did it work?

After the parser fix and a full rebuild, the warm-ground-truth diagnostic went from 9,819 divergences on the returns sheet to **one** (a cosmetic `CELL("filename")` label), and from 4.62 million divergent writes on the promote sheet to **30** (all cosmetic `TEXT()` formatting labels). **Zero numeric divergence** on the traced sheets. The carry total, every equity-class basis, and all fourteen IRR cells now reproduce Excel exactly.

Then, booking the release, I ran the same diagnostic over **all seventeen** sheets of the model's circular cluster — not just the two the investigation had traced. Pre-fix baseline: 1 of 17 sheets clean, ~5.9 million divergent values. Post-fix: **9 of 17 exactly clean** — the entire returns chain at zero — with the residual concentrated in a handful of operating sheets. And that residual had a _signature_: one date cell computing June 29 where Excel said June 30, and downstream sheets full of integer counts off by exactly one.

## Your engine's answers depended on your timezone

That signature took one look at the emitted code to explain, and it's my favorite bug of the campaign. The `YEAR`/`MONTH`/`DAY` lowerings converted Excel day-serials through a JavaScript `Date` and read them back with `.getMonth()` / `.getDate()` — which are **local-time** methods. UTC midnight of June 30, viewed from any machine west of Greenwich, is June 29 in the evening. So `DAY(June 30) = 29`, every date rebuilt via the common `DATE(YEAR(x), MONTH(x), DAY(x))` idiom landed one serial early, and every date-windowed `COUNTIFS` in its shadow shifted by a day.

Run the same engine on a server in London: correct answers. In Denver: subtly wrong ones. Nobody compares those two runs, which is exactly why this class of bug survives — and why the fix's regression test now runs the engine in _timezone-pinned child processes_ (one west of UTC, one east) with a probe asserting the hazard is actually present, so it discriminates even on a UTC CI runner.

The fix routed all three functions through the same pure-integer UTC serial math the other date helpers use. After it, the sweep read: **11 of 17 sheets exact, total divergence down 93.5%** — with the entire returns chain, every sheet a headline number lives on, at zero.

## The same-day sequel (v0.3.1)

The four sheets still off carried a third defect class — with every input at its exact Excel value, the transpiled expression computed a _different result_, meaning the formula we transpiled wasn't the formula in the workbook. That hunt ran the same evening, and it found three more roots:

- The parser had no rule for ranges with **computed endpoints** like `SUM(CF14:OFFSET(CF14,,-($F$12-2)))` — it stopped at the colon and silently returned the partial formula, dropping everything after, including whole trailing factors. (The fix came with a structural guarantee: a partial parse can never again pass as a formula — anything the parser can't fully consume is now a loud NaN.) - `YEARFRAC`'s default basis is a 30/360 day-count whose Excel implementation differs from the textbook standard in _rule order_ — pinning it took three iterations, each one corrected by the model's own ground truth. The middle iteration's test **passed while being wrong**, because it validated my hypothesis against itself instead of against Excel. Ground truth is the only oracle that counts. - `SUMIFS` with a _range_ as a criteria value (an array-formula idiom in the debt schedules) silently matched nothing.

Final tally, all 17 sheets: **5.9 million divergent values at the campaign's start, 266 at its end — 99.995% eliminated, 14 of 17 sheets bit-for-bit exact.** And the last 266? They're the floor: cells that gate `=0` against ground-truth values like **−0.0000000596** — half-ULP floating-point dust that Excel itself stores by accident. Matching those would mean reproducing Excel's exact floating-point operation order, which is a different sport. Documented, not chased.

One more thing worth saying about honesty: through the whole campaign, while sheets were wrong, the engine _knew something was wrong_ where it mattered — iterating the circular cluster with unfaithful formulas fails to converge, and the convergence machinery returns `converged: false` and NaN rather than confidently wrong returns. The contract built for division-by-zero ended up catching parser bugs' downstream blast. Layers.

## What else is in v0.3.0

- **`ete lite`** — when a consumer needs three outputs, don't ship a multi-MB engine. A four-tier ladder (closed-form → fitted surrogate → scoped cone → full engine) emits the smallest artifact that meets the precision budget, with signed provenance — and an honesty gate that force-escalates anything with a kink in it (a waterfall breakpoint approximated by a smooth curve is exactly the "plausible wrong number" this release exists to kill). - **A developer handoff contract** — `named-outputs.json` / `named-inputs.json` / `build-manifest.json` give downstream apps named, spot-checkable bindings ("`grossIRR` lives at this cell, base case is this value — fail your build if it isn't") instead of reverse-engineered cell addresses. - **Guided onboarding for non-programmers** — the README now leads with the "I'm an analyst, not a developer" path: convert, sanity-check against your spreadsheet, `ete verify`, and hand your developer a bundle with `INTEGRATION.md` and a runnable example. - **Scale machinery** — lazy sheet loading, scoped dependency cones (experimental), and compact dependency graphs that took `ete init` from OOM-killed to minutes on 200MB workbooks.

## Try it

```bash
git clone https://github.com/ebootheee/excel-to-engine.git
```

Point Claude Code at the repo, say _"I have a financial model at my-model.xlsx — convert it and walk me through what it found"_, and sanity-check what comes back. The full release notes are on the [v0.3.0 release page](https://github.com/ebootheee/excel-to-engine/releases/tag/v0.3.0).

And if you maintain software that parses other software's file formats: go write the test your fixture generator can't generate. That's where mine was hiding.
