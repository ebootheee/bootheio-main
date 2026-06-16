---
title: "A 1-Inch Tube Mount for Starlink Mini"
excerpt: "A 3D-printable mount that clamps a Starlink Mini to any 1-inch (2.5cm) crossbar — vehicle cargo racks, roof rails, overlanding setups. Two variants: heat-press inserts for permanent installs, TPU grip inserts for tool-free service."
publishedAt: "2026-04-22T21:18:05.962Z"
updatedAt: "2026-05-22T03:04:57.055Z"
draft: false
tags: []
---

Starlink Mini is a great fit for mobile setups — overlanding, vanlife, work trucks — but the stock pole mount assumes you've got a flat surface to bolt to. Most vehicle rack systems use 1-inch round crossbars instead. I designed a 3D-printable clamp that bridges the gap.

The mount is now published on Cults3D: [**Starlink Mini 1-Inch (2.5cm) Tube Mount**](https://cults3d.com/en/3d-model/various/starlink-mini-1-inch-2-5cm-tube-mount)**.**



![Heat press + TPU inserts](/media/01KPVH9Q5R1T93AMKN74TYS4T9.webp)

![Mounted w/ Starllink Mini](/media/01KPVH8GSKF9QV2D30DWA8KXEM.webp)

## Design goals

I wanted three things:

- **Secure enough for off-road.** The clamp had to survive highway speeds, gravel washboard, and the occasional unexpected air. That ruled out anything relying on friction alone.
- **Works with the stock pole.** No modifying the dish or voiding anything — the clamp accepts the Starlink Mini's factory pole stub and uses the original mount bolt.
- **Two build paths.** Some people have a heat-set insert kit and want a bomb-proof permanent install. Others want something they can print and glue and forget about. Both are in the zip.

## The two variants

### Heat-press inserts (permanent)

The primary version uses brass heat-set threaded inserts. You need:

- 2× M5 threaded inserts + 35mm flat-head hex bolts (for the clamp halves)
- 1× M6 threaded insert (reuses the Starlink Mini's original mount bolt)

This is the version I run on my own rack. With ASA plastic and 4 perimeters, the clamp doesn't flex even when I grab the dish itself as a handle.

### TPU grips (tool-free)

The second variant is a two-piece clamp with TPU elastomer grip inserts glued into the inner clamping faces. The TPU provides vibration damping and a high-friction grip without needing extreme torque on the bolts. Good choice if you don't have heat-set inserts on hand, or if you want to be able to remove the mount quickly without stripping plastic threads.

The TPU grip pieces print vertically with no support.

## Printing specs

I recommend printing in **ASA** if you have it, or another material with solid heat deflection and UV resistance — this thing lives outside, often in direct sun, sometimes strapped to a dark-colored rack that gets hot enough to soften PLA by lunchtime.

Settings that worked for me:

- 0.2mm layer height
- 4 wall perimeters
- 30–40% infill
- No support on the TPU grip pieces (they print vertically)
- Standard support on the ASA clamp if your printer's overhangs are weak

## Design choices

The clamp constrains all three axes with a single bolt. The pole notch handles Z and X (it can't slide up/out of the clamp or rotate side-to-side), and the M6 bolt handles Y (rotation around the pole axis). That means you can loosen one bolt, aim the dish, and retighten — no fussing with multiple fasteners to adjust pointing.

## Getting the files

The `.3mf` files for both variants are on Cults3D. License is Creative Commons Attribution with an explicit no-AI-training clause. If you print it and it works for you, I'd love to see a photo.
