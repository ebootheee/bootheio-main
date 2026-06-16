---
title: "Lake Powell Water Forecasting"
excerpt: "An interactive forecasting tool for Lake Powell water levels — now with BOR-tier-aware release policies, DROA augmentation scenarios, and a forecast that tracks the Bureau of Reclamation's April 2026 Most Probable within 10 feet."
publishedAt: "2026-04-05T20:55:31.959Z"
updatedAt: "2026-04-22T21:17:52.241Z"
draft: false
tags: []
---

Lake Powell is the second-largest reservoir in the United States and a critical piece of water infrastructure for the American Southwest. Its water level determines power generation at Glen Canyon Dam, downstream flows to the Grand Canyon, and water allocations to Arizona, Nevada, and California.

I built an interactive forecasting tool that combines real-time USGS elevation data with NOAA snowpack measurements from 10 SNOTEL monitoring stations across the Upper Colorado River Basin. The app lets you explore how different snowpack scenarios and water release rates — including BOR's own emergency operating policies — affect the reservoir's trajectory.

## How it works

The forecasting model uses a mass-balance approach. Snowpack water equivalent is the primary predictor of spring inflows. A regression equation links snowpack to net storage gain with an R² of 0.899. The model converts between elevation and storage volume using Bureau of Reclamation lookup tables with linear interpolation between 20 reference points.

The regression output is now clamped to physically plausible bounds `[-1.5, +8.0]` MAF. Without the clamp, the raw regression predicted -4.3 MAF at April 2026's SWE of ~1,034 — physically implausible once BOR operating authorities constrain releases.

## Policy scenarios

Earlier versions of the tool assumed a fixed release multiplier, which is the simplest way to model the reservoir but doesn't reflect how Glen Canyon Dam actually operates under stress. In April 2026 I added three policy modes:

- **Fixed releases** — the historical default. Release multiplier stays constant across the forecast.
- **Auto-tier releases** — the multiplier is computed per-step from current elevation using BOR's 2007 Interim Guidelines and the 2024 SEIS Record of Decision Section 6(E) tier structure. The tiers are 1.10× above 3,575 ft → 1.00× above 3,525 → 0.95× above 3,500 → 0.80× above 3,490 → 0.67× below.
- **Emergency (April 2026)** — Auto-tier plus a 1 MAF DROA augmentation spread over 12 months, simulating upstream releases from Flaming Gorge, Blue Mesa, and Navajo per the 2019 Drought Response Operations Agreement.

The Emergency scenario exists because of a real event: on April 17, 2026, BOR issued an advisory invoking these authorities for the first time. The site now shows an advisory banner citing that announcement, and the methodology page has a new section explaining DROA, Section 6(E), and how the tool reconciles with BOR's published 24-Month Study.

## Data sources

USGS Water Services provides daily lake elevation readings going back three years. NOAA NCEI supplies current and historical snowpack water-equivalent data. A GitHub Actions job runs daily at 6 AM UTC to cache fresh data and generate forecast snapshots that can be used for backtesting accuracy. Snapshots land in `cache/forecasts/YYYY-MM-DD.json` so the control dataset accumulates real observations over time for regression refinement.

## Accuracy

Hindcast validation on 2020–2025 shows ±4-foot accuracy for typical operating years.

More importantly, the April 2026 update fixed a significant drought-regime failure. Previously, at SWE = 1,034 the base case projected dead pool (3,370 ft) by December 2026 — clearly wrong, since dead pool implies zero hydropower and no BOR operator would let that happen unchecked. BOR's Most Probable scenario from the April 17, 2026 24-Month Study (Model Run ID 3310) showed 3,471 ft at December.

With the physical SWE clamp and Auto-tier policy enabled, the model now matches BOR's December projection **within 10 feet** when driven by comparable inputs. The chart overlays BOR's 16-month Most Probable as a dashed reference line so you can see the comparison directly.

The test suite is now 60 tests, covering SWE regression bounds, tier-aware release multipliers, dynamic vs. static drawdown comparison, DROA augmentation, and BOR reconciliation.

Try the live app below. Adjust the snowpack and release rate sliders, or switch between the three policy scenarios, to see how different assumptions affect the forecast.
