---
title: "Dishwasher Tine Clip"
model_url: "/stls/dishwasher-tine-clip/dishwasher-tine-clip-v5.stl"
material: "matte"
color: "#e9e7e2"
height: "tall"
up: "z"
related_posts: ["scan-to-cad-dishwasher-clip"]
publishedAt: "2026-10-29"
---

A replacement for the pivot clip that holds the fold-down tines on the lower rack of a Thermador DWHD640JPR/93 dishwasher. This is v5, the final model from the post: rebuilt from a Revopoint MetroX scan of the original as a parametric FreeCAD model, and scored at 0.12 mm RMS against the scan.

The STL is one closed solid in millimetres, 29.58 × 12.14 × 15.99 mm, upright with Z up.

I printed mine on a Bambu Lab P1S in ASA at 100% infill, tilted 45° on the Z and Y axes so the layers run diagonally through the hook and flex panels, then acetone vapor-smoothed it. Don't use PLA: a dishwasher is hot enough to soften it.

The hook's inside diameter follows the scan, 5.03 mm, where my calipers read 5.3 mm. If it doesn't seat on your rack wire, change `HOOK_ID` in [the FreeCAD script](https://github.com/ebootheee/scan-to-cad/tree/main/examples/tine-clip) and rebuild.
