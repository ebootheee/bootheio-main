---
title: "3D Scan Meshes to Parametric CAD with Claude"
excerpt: "How I rebuilt a 30 mm molded dishwasher clip from a 3D scan, using Blender, FreeCAD and Claude to turn a blobby mesh into a clean parametric model that prints and fits."
publishedAt: "2026-10-28"
draft: false
tags: ["3d-printing", "3d-scanning", "cad", "freecad", "blender", "claude", "ai"]
categories: ["projects"]
---

## A $2 clip, a 30 mm problem

I 3D-printed a replacement for a broken dishwasher rack clip, and it fits and works like the original. Getting there took calipers, a 3D scanner, Blender, FreeCAD and Claude, and the scanner-plus-AI part is the bit worth writing up.

![The printed clip (white) next to the original Thermador clip (grey)](/media/scan-to-cad-dishwasher-clip/print-vs-original-side.webp)

The part is the tine clip: the pivot clip that holds the fold-down tines on the lower rack of a Thermador DWHD640JPR/93. One of mine snapped. You can order a replacement, but it's a tiny grey piece of plastic, I own a printer, and I wanted to know whether I could reproduce a molded part this small accurately.

This post covers why the part is hard, what didn't work, and the method that did. It ends with a step-by-step guide you can reuse on your own small parts.

## Why this part is hard

The clip is 30 mm long and has features under 1 mm, which is right at the limit of what you can measure by hand. Worse, nearly every surface that matters for fit is curved, angled or hidden inside.

- **It's tiny.** The whole part fits on a fingertip. The slits that let the side panels flex are about 1 mm wide.
- **It's a snap fit.** Two lips grab a 3.5 mm rack bar through a 2.4 mm throat. A few tenths of a millimetre decides whether it clicks, falls off or won't go on at all.
- **The shapes are organic.** It's injection molded, so there are tapered walls, domed bridges, fillets everywhere and a J hook that tapers in width. There's almost no flat face to rest a caliper jaw on.
- **The important geometry is inside.** The lips, the arches the bar passes through, and the chamfers under them can't be reached with calipers at all.
- **Guessing compounds.** Each feature is positioned relative to others. A 0.3 mm error at one end becomes a part that doesn't fit at the other.

## The toolkit

Nothing here is exotic, and the two big programs are free. The real change from my earlier attempts was letting Claude drive all of them from scripts.

| Tool | What it did |
| --- | --- |
| Digital calipers | The few dimensions you can actually trust: overall length, hook inside diameter, wire and bar diameters |
| Revopoint MetroX 3D scanner | Captured the original clip as a mesh: 44,277 vertices, 88,542 triangles, exported as PLY |
| Bambu Lab P1S | Printed the clip in ASA |
| Blender 5.2, run headless | Mesh cleanup, alignment, deviation maps and every render in this post |
| FreeCAD 1.1, run headless | The parametric model itself, written as a Python script, plus STEP and STL export |
| Python with numpy, scipy and matplotlib | Slicing, ray probes, height maps and the mirror-plane fit (FreeCAD ships with all three) |
| Claude Code (Claude Opus) | Wrote and ran every script, read the plots, proposed the geometry and iterated |

**How I printed it.** A snap fit this small breaks along its layer lines, so the print settings matter as much as the model. I printed in ASA, because a dishwasher is hot and wet and PLA would soften. Infill was 100%, since the walls are too thin for anything else to help. The part was tilted 45° on both the Z and Y axes, so the layers run diagonally through it rather than straight across the hook and flex panels. Afterwards I acetone vapor-smoothed it, which fuses the outer layers together and improves layer bonding as well as the finish.

One surprise: I'd half set up a Blender MCP connector so Claude could drive Blender's UI. It turned out not to matter. Running Blender headless from scripts was more repeatable, and every step left a script behind that I can rerun.

## Round one: calipers and photos

My first four versions came from calipers, photos next to a ruler, and educated guesses. They got the outline within half a millimetre, but they got the inside wrong in ways I couldn't see.

The v4 script tagged every dimension with where it came from: (M) measured with calipers, (P) scaled from photos, (G) guessed. That habit turned out to be useful later, because it showed exactly which numbers to distrust.

![v4, the caliper-and-photo model, from six angles](/media/scan-to-cad-dishwasher-clip/v4-caliper-model.png)

When I later laid the scan over v4, the overall envelope was close: bounding boxes within about 0.4 mm. But 23% of the scan's points sat more than 0.5 mm from the model, and the misses were all things I couldn't have measured:

- The leg-end wall isn't a wall with a small slot. It's a bridge over an arch 9.1 mm tall that the rack bar passes through.
- The slits that free the flex panels are 5.3 mm tall, not the 8.5 mm I guessed.
- The "pivot bumps" I'd modelled from photos as raised rings with dimples don't exist. There are two low vertical ribs on each side instead.
- The snap isn't a keyhole seat. It's a pair of wedge-shaped lips with a V lead-in from below.
- The leg underside steps down near the box instead of running flat.

![Side slices of v4 (grey) against the scan (red). The leg underside, the panel shape and the slits all differ.](/media/scan-to-cad-dishwasher-clip/v4-vs-scan-slices.png)

That's the core problem with hand measurement on a part like this. You can measure what you can reach, but the fit depends on what you can't.

## Scanning and cleanup

The scan came out better than I expected: watertight, in millimetres, and detailed enough to show 1 mm slits and the ribs on the side walls. Cleanup was mostly about putting it in the right place.

![The cleaned scan of the original clip. Slits, ribs, lips and the J hook all come through.](/media/scan-to-cad-dishwasher-clip/scan-views.png)

Claude checked the raw mesh before touching it. There were no holes and no broken edges, just three floating specks of 4 to 48 vertices, which it deleted. The scan's length came out at 29.58 mm, against 30.0 mm on my calipers. More on that later.

Alignment took two passes:

1. **Rough alignment to v4.** The scan arrives at an arbitrary angle. Claude matched its principal axes to v4 in all 24 possible orientations, refined each with ICP (iterative closest point), and kept the best. That landed at 0.29 mm RMS, which is good enough to compare.
2. **Alignment to its own mirror plane.** This mattered more. Instead of trusting v4's frame, Claude reflected the scan onto itself and solved for the plane where left matches right. The scan had been sitting 1.25° off in yaw and 1.04° in roll. After correcting that, the two sides agree to 0.09 mm (median).

The second pass is the one I'd skip if I didn't know better. Without it, the left leg measures differently from the right, and you end up "faithfully" modelling an asymmetry that's really just how the part sat on the scanner.

## Measuring a mesh

A scan is 88,000 triangles, not a list of dimensions. Three simple tools turned it into numbers, and Claude used all three constantly.

- **Slices.** Cut the mesh with a plane and plot the outline on a 0.25 mm grid, with the CAD model overlaid. This is the fastest way to see what a feature really looks like. Most images in this post are slices.
- **Ray probes.** Fire a straight line through the mesh and report exactly where it crosses the surface. One probe across the snap lips at mid-height says the tips sit at y = ±1.2 mm, so the throat is 2.4 mm. Claude fired these in batches of 100 to 200 and averaged left against right.
- **Height maps.** Sweep probes over a whole face on a 0.2 mm grid and colour the result. This is how we found that the side walls have no pivot rings at all.

![Side-wall height map. The two bright vertical bands on each side are ribs 0.27 mm proud; the gaps are the slits.](/media/scan-to-cad-dishwasher-clip/side-wall-height-map.png)

The step that turns measurements into design is fitting simple shapes to the probe points. A few examples:

- The leg tip's underside fits a 4.3 mm radius to within about 0.1 mm at every probe.
- The slot in each leg is a 2.9 mm arc with a straight 60° flank tangent to it.
- The notch under the hook tip is a half-moon of radius 2.53 mm. Six probes across it land within 0.03 mm of that circle.

Once a set of points fits a radius that cleanly, you know it's a design feature, not noise.

## De-drafting: design intent, not a copy

The goal was never to copy the scan. A scan is a soft first draft of the part: every sharp edge is rounded, small features are blurred, and wear and scanner noise are baked in. De-drafting means recovering the clean design the mold maker started from.

I gave Claude one rule mid-project: the model must be exactly symmetric, and any odd curve that comes from smoothing gets replaced with clean geometry. From there, we sorted every feature with a few tests:

- **Does it fit a simple shape?** A clean radius, line or angle is design. A curve that wobbles around one is smoothing, so model the shape it wobbles around.
- **Is it on both sides?** Real features repeat in the mirror. Something on one side only is wear or noise.
- **Does it matter for fit?** Molding draft and hairline rounds don't change how a print clips on, so they stay sharp and simple.

| The scan showed | Decision | Why |
| --- | --- | --- |
| Left and right legs measuring slightly differently | Average them; build one side and mirror it | The asymmetry came from how the part sat, not the part |
| A sloped plane under the leg end of each lip | Keep it as a lead-in chamfer with its own parameters | It's identical on both sides, so it's molded in |
| A groove in the lip tops that alternates sides | Average it out to a single sloped top | It's point-symmetric, not mirror-symmetric, so it's likely a molding artifact |
| About 2° of taper on the side walls | Model the walls vertical | Molding draft doesn't affect the fit of a print |
| Soft 1.6 mm round on the leg tops, 4 mm crowns on the bridges | Keep them as named fillet parameters | Consistent, sizeable and visible on the original |
| Every other edge slightly rounded | Leave it sharp | Scanner smoothing, below what matters |

The result is a FreeCAD script with about 80 named parameters, grouped by feature: legs, leg-end bridge, box, arches, flex panels and lips, ribs, hook. Each one is tagged (S) for scan or (M) for calipers, so I can always see where a number came from.

## Closing the loop: score every build

The single most useful thing in the project was a script that scores the CAD model against the scan after every change. It turned "looks about right" into a number, and the number told Claude where to look next.

The scorer measures the distance from every scan point to the CAD surface, and from the CAD surface back to the scan. It reports RMS error, the share of points within 0.2 and 0.3 mm, and the worst 1 mm cubes of the part ranked by error. That ranked list is the to-do list for the next pass.

![The scan-to-CAD loop: scan, clean and align, measure, fit shapes, write the model, build, score against the scan, then print. The worst regions feed the next pass.](/media/scan-to-cad-dishwasher-clip/scan-to-cad-loop.png)

The loop runs from measure to score as many times as it takes; four passes got this part to print quality.

| Pass | What changed | RMS error | Within 0.2 mm | Within 0.3 mm |
| --- | --- | --- | --- | --- |
| 1 | First full v5 build from probe measurements | 0.143 mm | 87% | 95% |
| 2 | Clipped the ribs, raised the hook straight off its wall, rounded panel corners and leg tops | 0.130 mm | 89% | 96% |
| 3 | Added the lip lead-in chamfer and rounds on the end walls and bridges | 0.124 mm | 90% | 97% |
| 4 | Split the two arch radii (2.1 and 2.35 mm), crowned the bridge, rounded the hook flank | 0.120 mm | 91% | 98% |

Not every pass was progress, and the slices caught what the score didn't:

- The first build came out as three separate solids, 25 mm tall. A mirror helper had flipped one side wall upside down instead of left to right. A bounding-box check found it in seconds.
- OpenCascade, FreeCAD's geometry kernel, refused two fillets. Claude replaced them with a rounded profile swept along the edge, which gives the same shape.
- One of those swept profiles was too shallow and quietly chopped the bottoms off the legs. The score barely moved, but the side slice made it obvious.

![The final scan coloured by distance from v5: grey is within a few hundredths, full red or blue is 0.4 mm](/media/scan-to-cad-dishwasher-clip/v5-deviation-map.png)

![Final side slices: v5 (grey) on the scan (red)](/media/scan-to-cad-dishwasher-clip/v5-side-slices.png)

What's left is mostly where the scan itself is soft: inside corners, the alternating groove on the lip tops, and edges I chose to leave sharp.

## The print

The printed clip went onto the rack and works like the original. In the photos, white is the print and grey is the original Thermador part.

![Top view: the printed clip (white) above the original (grey)](/media/scan-to-cad-dishwasher-clip/print-vs-original-top.webp)

When you test-fit a part like this, check three things:

- **Does it snap on, and does it stay on?** A throat that's too tight cracks the flex panels. One that's too loose lets the clip walk off the bar.
- **Does the hook seat on the wire?** This is where the scan and my calipers disagree, so it's the first place to look if the fit is off.
- **Does it flex without whitening or cracking?** Layer bonding is the weak point of a printed snap fit. That's why this one was tilted, printed solid and vapor-smoothed.

If something's off, it's one named parameter to change and one script to rerun.

## How to do this on your own part

This recipe works for small, mostly prismatic molded parts: clips, brackets, knobs, latches. You can ask Claude to do each step, and each one leaves a script behind.

Everything from this project is on GitHub at [ebootheee/scan-to-cad](https://github.com/ebootheee/scan-to-cad): the measuring and scoring scripts, the cleaned scan, both models, and a Claude Code skill that walks Claude through these steps.

1. **Measure what you can first.** Get the overall size, any hole or wire diameters, and the mating parts, like the bar or wire the clip grabs. Tag every number with where it came from.
2. **Scan the part and export in millimetres.** PLY or STL both work. Ask Claude to check the mesh is watertight and to delete stray islands.
3. **Align it.** Do a rough fit to your best guess, or to the part's principal axes. If the part is symmetric, find its mirror plane and put it at y = 0.
4. **Measure the mesh.** Use slices for shape, ray probes for exact numbers, and height maps to find small features on faces. Average left and right.
5. **Fit simple shapes.** Radii, lines, angles and planes. If the points fit cleanly, it's design. If they wobble, it's smoothing.
6. **Write the model as a script** with named parameters, grouped by feature and tagged by source. Build one side and mirror it.
7. **Score every build.** Track RMS, the share of points within 0.2 and 0.3 mm, and the worst regions. Look at slices too, because a score can hide a bad cut.
8. **Settle conflicts before printing.** Mine: the scan says the hook's inside diameter is 5.03 mm and the overall length 29.58 mm, while calipers said 5.3 and 30.0. Decide which to trust, and keep it to one parameter so it's easy to change.
9. **Print for layer strength.** Use a heat-tolerant material like ASA at 100% infill, and tilt the part so no hook or flex panel bends straight across the layer lines. I used 45° on the Z and Y axes. Vapor smoothing afterwards fuses the outer layers and makes the part tougher.

The prompts that steered this project were short. These three did most of the work:

- "Clean up the model, or export it so we can build a parametric model that maps exactly to the clip, without the weird artifacts that come from 3D scanning."
- "The whole model should be symmetrical. If there are funny curves from smoothing, fix them."
- "Build v5 to match the scan exactly, including the lips, arches and slits. Keep the parameters named and grouped like v4."

## What I learned about AI and physical design

The biggest lesson: Claude did the parts that made the project tedious, and I kept the parts that need judgement. That split is what made this fast.

- **AI is great at the grind.** Claude wrote the slicing tool, fired probes in batches of 100 to 200, and rebuilt and rescored the model on every pass. I never touched a spreadsheet or a sketch constraint.
- **It notices things.** The vertical ribs, the lead-in chamfer under the lips and the 1.25° tilt in the scan all came out of Claude reading its own plots, not from me pointing at them.
- **You set the rules, it applies them consistently.** "Make it symmetric" and "fix smoothing curves" were one-line instructions. Claude then applied them to every feature and showed its reasoning in a table I could check.
- **Numbers beat eyeballing, but look anyway.** The deviation score drove every pass. It still missed a cut that chopped the legs off, which a single slice made obvious.
- **Scripts beat clicks.** Every step left a script behind: cleanup, alignment, slicing, scoring, the model itself. I can rerun the whole chain on the next part.
- **The CAD kernel is the weak link, not the AI.** OpenCascade refused two fillets. The fix was a different construction, not a better prompt.
- **Calipers still matter.** The scan and my calipers disagree on two dimensions, and the scan can't tell me which is right. Hand measurements are the check on the scan, and the scan is the check on them.

Next, I want an optimizer that tunes every parameter against the scan automatically, region by region. That would turn the hand-tuning passes into one unattended run. Beyond that, the same pipeline wrapped in a simple tool could get any scanner owner from mesh to editable CAD.

