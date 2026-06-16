---
title: "boothrflow Wave 6: what the bench actually found"
excerpt: "Wave 6 Phase 1 is complete. Nemotron and Qwen3 were evaluated, Assertive style was axed, and the default STT moved to base.en. The bench harness ran — and mostly told us to stay put. Here is why."
updatedAt: "2026-05-22T03:50:19.981Z"
draft: true
tags: []
---

# boothrflow Wave 6: what the bench actually found

The [first boothrflow post](/posts/boothrflow-local-first-voice-dictation) introduced the bench harness as a tool for answering model questions with data instead of vibes. Wave 6 Phase 1 was its first real test: evaluate Nemotron Speech Streaming, Parakeet TDT v3, and the new Qwen3 family against the production defaults, and swap in anything that wins.

The verdict was mostly "keep what you have." But the reasons are worth writing down.

## The STT picture

The default STT engine moved from `whisper:tiny.en` to `whisper:base.en` in May. That's a quiet change in a settings file, but it's the right call: `base.en` is ~80ms slower on Apple Silicon but gets named entities right — the Lysara capture that exposed `tiny.en`'s limits in the first post (`LISAR`, `pay` instead of `paste`) is correctly transcribed by `base.en` at ~850ms warm.

Parakeet TDT 0.6B v3 is in the matrix and has been benchmarked properly. The 13.5s number from the original post was a measurement artifact — the bench harness was running cold loads instead of warmup-then-decode. The real decode cost after warmup is around 470ms, which is in the same order of magnitude as the Whisper variants. But for English technical content, `base.en` still comes out ahead on transcript quality, and Parakeet's lack of streaming partials means there's no live-preview during dictation. It stays opt-in.

Nemotron Speech Streaming (NVIDIA, via sherpa-onnx's online recognizer) is now in the eval suite. It does emit streaming partials at 80–1120ms chunks — which is exactly what Parakeet is missing — but it didn't beat `base.en` on the technical-content captures either. It's in the matrix, not in the defaults.

ADR-009 laid out the intended target state: Parakeet TDT v3 as primary, `whisper-large-v3-turbo Q5` as fallback for non-English. The bench says that target state isn't earned yet. The default stays `base.en` until a streaming-capable engine clears it on quality.

## Qwen3 and the thinking-mode latency tax

This was the most interesting finding of the wave.

Qwen3 4B, 8B, and 1.7B all landed in the eval matrix. They're good models. But every variant ships with a "Hybrid Instruct/Thinking" architecture that bakes in a reasoning pass before the output starts. Even when you suppress thinking mode explicitly, the latency tax doesn't go away: 2–3× across the board.

For a chatbot or an agentic task runner, a 2–3× latency increase might be worth the quality gain. For a cleanup pass that runs while you finish speaking, it isn't — the whole reason the 7B default is tolerable is that the model is already warming up while your mouth is still moving. Add 2–3× and it crosses into perceptibly slow, regardless of output quality.

Qwen 2.5 7B stays as the default cleanup model. Qwen 2.5 1.5B stays as the fast-path fallback. Qwen3 stays on the watchlist.

## ADR-015: 7B is the default now, and the latency is fine

The earlier post mentioned 4–8s for 7B cleanup. That number was real, but it was cold — measured before Ollama's `keep_alive: 5m` was keeping the model and its KV cache resident across dictations.

With prompt-prefix caching warm, 7B cleanup on Apple Silicon lands at 350–400ms. That's about double the 1.5B baseline, but it's not perceptible in the flow: you've finished speaking, the STT decode is running, and the cleanup result lands before you'd naturally look up from the mic. ADR-015 documents the user-feedback loop that drove this decision directly:

> "the 7 billion parameter model for Qwen is a little bit better… but the latency is quite a bit longer, maybe double. But for cleanup, having 350–400 milliseconds is no big deal."

The escape hatch is still `BOOTHRFLOW_LLM_MODEL=qwen2.5:1.5b` for machines where 5GB on disk is a problem. The Settings panel (Wave 4b, still coming) will expose a picker. For now it's an env var.

## Assertive is gone

The style system shipped in Wave 6 Phase 0 with four modes: Raw, Light, Moderate, Assertive. Assertive retired less than two weeks later.

The failure mode wasn't subtle. Assertive invented portfolio details that weren't in the dictation. Not hallucinated proper nouns — that's an STT problem — but fabricated structured content from context the model inferred from the focused window. The prompt gave the model permission to "organize and structure aggressively" and on at least one dictation, it exercised that permission in the wrong direction: adding content rather than reshaping what was there.

That's a hard disqualification. Formatting that introduces false content is worse than no formatting.

Moderate got tightened at the same time: it's now strictly format-only — line breaks, basic list structure — with no paraphrasing. The structuring-aggressiveness axis now runs Raw → Light → Moderate, with Captain's Log still available as a sidechannel preset.

The underlying lesson is about small model instruction-following under permissive prompts. Light and Moderate both work fine on 1.5B because the instructions are simple ("clean up disfluencies, preserve wording"). Assertive required conditional reasoning — "structure only if the speaker gave you transitions" — and small models can't follow that reliably when the prompt also gives them broad permission to reshape content. The model's prior for "when in doubt, do more" wins over the conditional constraints.

## macOS: pill over full-screen apps

Minor but annoying: the dictation pill was disappearing when the focused app went full-screen. The overlay was a regular window and macOS parks regular windows on a separate Space during full-screen transitions.

The fix was converting the overlay to an `NSPanel` with `NSWindowCollectionBehaviorCanJoinAllSpaces | NSWindowCollectionBehaviorFullScreenAuxiliary` and bumping the window level to `NSStatusWindowLevel`. It now renders over full-screen apps, including during slide-in/slide-out animations, without interfering with Spaces.

## What's next

Wave 7 is production polish: GitHub Actions matrix build, macOS signing + notarization, auto-update via `tauri-plugin-updater`, Windows signing (Azure Trusted Signing), first-run onboarding wizard, and beta/stable channels. Signing and auto-update have to ship together — unsigned auto-update is broken UX because every update re-triggers Gatekeeper's "Open Anyway" prompt.

Wave 8 is connectors and UI: a `Connector` trait + Obsidian vault push + HTTP webhook + Slack incoming webhooks with voice-triggered routing, a full pill redesign with Liquid Glass vibrancy on macOS, and a `PRIVACY_AUDIT.md` that makes the privacy claim auditable rather than aspirational.

The bench harness is still running. If a Qwen3 variant ships a non-thinking mode, or if Nemotron streaming pulls ahead on technical content, the matrix will catch it. The defaults are the defaults until they're beaten — not upgraded by announcement.

Repo: [github.com/ebootheee/boothrflow](https://github.com/ebootheee/boothrflow)
