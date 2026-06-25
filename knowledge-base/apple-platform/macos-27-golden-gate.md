# macOS 27 "Golden Gate"

_Last updated: 2026-06-24_

> **Beta status:** macOS 27 was announced at WWDC 2026 (keynote **June 8, 2026**) and is in developer/public beta as of this writing. Everything here is **pre-release and subject to change** before GM. Beta/uncertain items are flagged inline with ⚠️.

Reference doc for **Rainy** (SwiftUI, infinite-canvas productivity app) targeting macOS 27.

---

## 1. Release overview

| | |
|---|---|
| Marketing name | **macOS 27 "Golden Gate"** |
| Announced | June 8, 2026 (WWDC 2026 keynote) |
| Developer beta | June 8, 2026 |
| Public beta | July 2026 |
| Final release | **Fall 2026** — Apple framed it as "September"; outlets hedge Sept/Oct. ⚠️ Exact GM date not announced. |
| Point-version string | ⚠️ "27.0" is inferred (Xcode surfaces `27.0` as the SDK ceiling) but not explicitly confirmed in Apple release notes. |
| Price | Free upgrade for compatible Macs |

Positioned as a "Snow Leopard-style" stability/performance release. Headline non-developer features: redesigned conversational **Siri AI** (Apple Intelligence), Safari AI tab auto-grouping + "Notify Me" webpage-change alerts, and Liquid Glass refinements (§3).

**Performance claims (Apple):** ~30% faster app launch (pre-loading), faster Photos gallery population, **up to 80% faster AirDrop**.

⚠️ The richer Siri voice + advanced dictation reportedly require **M3 or better + ≥12 GB RAM**; baseline M1/M2 Macs run macOS 27 but not the full Siri feature set.

---

## 2. Hardware: Apple-silicon-only, Rosetta 2 sunset

**This is the single biggest compatibility fact: macOS 27 is the first macOS that runs on NO Intel Mac. x86_64 is fully dropped.**

- **Minimum Mac:** any **Apple silicon (M1 or newer)** — M1/M2/M3/M4/M5, plus the A18 Pro "MacBook Neo." Earliest model: Nov 2020 M1 MacBook Air. Four Intel Macs that ran macOS 26 Tahoe lose support.
- **Build host:** **Xcode 27 does not run on Intel Macs** — an Apple silicon Mac is required to develop for macOS 27.

### Rosetta 2 timeline (critical date)
- At **WWDC 2025**, Apple stated Rosetta would remain "for the next two major macOS releases — **through macOS 27**."
- **macOS 27 Golden Gate is the LAST release with full Rosetta 2** translation for general x86_64 apps.
- **macOS 28 (fall 2027):** general Intel-app translation **ends**. Apple keeps only a narrow Rosetta subset for older, unmaintained **games** depending on Intel-only frameworks. Reporting cites ~18,000+ Intel-only Mac apps affected.
- ⚠️ Secondary reporting says macOS 27 **auto-uninstalls** Rosetta 2 if it was installed under Tahoe, and 26.4/26.5 already warn when launching Intel-only apps. Verify against Apple docs before relying on this.

**For Rainy:** ship **arm64-native**. Audit every dependency, plug-in, and prebuilt binary for any x86_64-only component — there is no Rosetta safety net on the horizon.

---

## 3. Liquid Glass refinements: macOS 27 vs macOS 26 Tahoe

**The SwiftUI/AppKit Liquid Glass *API* is unchanged from 26.** Golden Gate refines rendering, defaults, and user controls — not developer signatures. (Full API guide: `liquid-glass-swiftui.md`.)

Already present in **macOS 26 Tahoe**:
- The Liquid Glass material system.
- A **binary** Accessibility → Display → **Reduce Transparency** toggle (opaque UI). ⚠️ Buggy in early Tahoe; fixed in 26.3.

**New in macOS 27:**
- **Translucency / tint slider** (System Settings → Appearance): a *graduated* control replacing the binary feel — from more opaque/tinted (better text legibility) toward clearer. ⚠️ Reports differ on whether an "ultra-clear" extreme exists; treat the exact range as unconfirmed.
- **Reworked material foundations** — more uniform refraction, diffuses complex background content more effectively, HDR used for depth.
- **Darkened edges + brighter specular highlights** for separation/depth.
- **Window-shadow changes** to distinguish active vs inactive windows.
- **Consistent/uniform corner radius across all apps** (incl. non-updated apps), backed by the concentricity API (§4). Corners are less dramatically rounded than Tahoe.
- **Uniform toolbars + edge-to-edge sidebars** (sidebars no longer float; sidebar icons regain color).

⚠️ **Uncertain:** the exact interaction between the new slider and the existing Reduce Transparency accessibility toggle (whether Reduce Transparency overrides/pins the slider) is not clearly documented.

**For Rainy:** users can now dial system-wide translucency. **Test your glass chrome for legibility across the whole range**, especially at the opaque/tinted end, and lean on `.containerConcentric` corner radii (§4) which Golden Gate enforces more uniformly.

---

## 4. SwiftUI / AppKit capabilities relevant to an infinite-canvas app

⚠️ API names below come from WWDC26 session notes and beta-SDK coverage; names can change before GM. **No dedicated "infinite canvas" API was announced** — the relevant pieces are new scroll/container/rendering/text work.

### SwiftUI (2026 SDK)
- **Rendering rewrite over a direct Metal abstraction** — complex/long lists reported at **120 fps**. `LazyVStack`/`LazyHStack` gain **size estimation + prefetching** (directly relevant to large canvases/long lists).
- **Reordering:** `reorderable()` modifier and `reorderContainer(for:isEnabled:move:)` — drag-to-reorder in *any* container (stacks, grids, custom layouts).
- **`@ContentBuilder`** macro unifies the type-specific result builders (`@ViewBuilder` et al.); builders no longer require contents to conform to `View`.
- **`@State` is now a macro** (lazy init; applies to Observable types) rather than a property wrapper.
- **`Text` + `TextRenderer`** — custom-drawn canvas labels.
- **Navigation:** `CrossFadeNavigationTransition`, `AnyNavigationTransition` eraser.
- **Document apps:** new `ReadableDocument` / `WritableDocument` protocols (async read/write + progress) replacing `FileDocument`/`ReferenceFileDocument`; the document is a reference type marked `@Observable`. New `DocumentGroup` initializers (editing-only apps, custom pre-open UI, direct document-URL access).
- **`AsyncImage`:** HTTP caching, `URLRequest` initializers, `asyncImageURLSession(_:)`.

### AppKit (macOS 27) — from "Modernize your AppKit app" (WWDC26 session 289)
- **Concentricity API (drives the uniform corners):**
  - `NSView.cornerConfiguration` / `NSViewCornerConfiguration`
  - `NSViewCornerRadius.containerConcentric(_:)` — derives radius from the container, with a minimum.
  - `NSViewCornerConfiguration.uniformCorners(radius:)`
- **`NSTextSelectionManager` (new in 27):** full text selection in **custom views** — bidirectional selection, drag-and-drop, toggling. Useful for editable text nodes on a canvas.
- **Liquid Glass (mostly automatic):** hard-edge `NSScrollEdgeEffectStyle` near free-floating text (e.g. window titles); sidebars extend to window edges; bordered toolbar items over sidebars adopt glass; new interactive glass "bounce" recommended for buttons/controls.
- **Window management:** `NSWindow.preventsApplicationTerminationWhenModal` (default `true`; set `false` on non-critical sheets), `NSWindowRestoration` state-restoration flow, `NSStatusItemExpandedInterfaceSession`/`Delegate` for custom status-item keyboard focus.

> ⚠️ **Canvas caveat:** the long-standing gap in customizing `ScrollView` gesture/scroll behavior is reportedly **still not fully addressed** in 27. For a truly custom infinite canvas you may still need AppKit `NSScrollView` or a custom Metal/`Canvas` surface rather than pure SwiftUI `ScrollView`. Unverified for 27 — validate early.

---

## 5. Toolchain: Xcode 27, SDK, Swift, deployment targets

| | |
|---|---|
| IDE | **Xcode 27** (Beta 2 live as of this writing) |
| Swift | **Swift 6.4** |
| Bundled SDKs | iOS / iPadOS / tvOS / **macOS** / visionOS 27 |
| Runs on | **macOS Tahoe 26.4+** and **Apple silicon only** (Xcode 27 does not run on Intel) |
| Deployment floor | Dropped macOS 10.13–10.15; effective floor **Monterey 12** for Apple-silicon apps. SDK ceiling shown as **27.0**. |

**To target macOS 27, Rainy must:**
1. Build with **Xcode 27** on an Apple silicon Mac running Tahoe 26.4+.
2. Build against the **macOS 27 / 2026 SDK**; set the deployment target.
3. Ship **arm64-native**; audit x86_64-only dependencies (no Rosetta beyond 27).
4. Optionally adopt the concentricity / Liquid Glass APIs (§3–4) for uniform corners and the new glass behavior — much of it applies automatically on recompile.

> ⚠️ **Recompiling restyles your chrome.** Building against the 26/27 SDK makes standard toolbar items, buttons, tab bars, and navigation **automatically adopt Liquid Glass** with no opt-in. Audit toolbars/buttons after an SDK bump. (Details in `liquid-glass-swiftui.md` §8.)

---

## 6. Confirmed vs uncertain — quick reference

**Confirmed (Apple keynote/docs):** name "Golden Gate"; June 8 2026 announce; Apple-silicon-only; full Rosetta support ends after macOS 27; Liquid Glass translucency slider; Siri AI; Swift 6.4; Xcode 27 with the 27 SDKs requiring Tahoe 26.4 + Apple silicon; concentricity / `NSViewCornerConfiguration` API.

**⚠️ Uncertain / secondary-sourced — verify before relying on:**
- Exact GM date (September vs fall 2026) and the "27.0" point-version string.
- macOS 27 auto-uninstalling Rosetta 2.
- Exact slider ↔ Reduce Transparency interaction; whether an "ultra-clear" slider extreme exists.
- macOS 28 retaining a Rosetta-for-games subset.
- `ScrollView` gesture customization still unsolved in 27.
- All beta API names (`reorderable()`, `@ContentBuilder`, `ReadableDocument`, `NSTextSelectionManager` additions) may rename before GM.

---

## Sources

**Apple (primary):**
- Xcode 27 release notes — https://developer.apple.com/documentation/xcode-release-notes/xcode-27-release-notes
- AppKit updates — https://developer.apple.com/documentation/updates/appkit
- "Modernize your AppKit app," WWDC26 session 289 — https://developer.apple.com/videos/play/wwdc2026/289/
- NSWindow — https://developer.apple.com/documentation/appkit/nswindow

**News / dev blogs:**
- MacRumors — Apple announces macOS 27 Golden Gate — https://www.macrumors.com/2026/06/08/apple-announces-macos-golden-gate/
- MacRumors — macOS 27 last to support Intel apps via Rosetta 2 — https://www.macrumors.com/2026/06/10/macos-golden-gate-last-to-support-intel-apps/
- MacRumors — which apps stop working after Golden Gate — https://www.macrumors.com/2026/06/12/macos-golden-gate-rosetta-support/
- MacRumors — how Liquid Glass is changing in iOS 27 — https://www.macrumors.com/2026/06/10/how-liquid-glass-is-changing-in-ios-27/
- MacRumors roundup — macOS 27 — https://www.macrumors.com/roundup/macos-27/
- AppleInsider — how/when macOS stops supporting Intel apps — https://appleinsider.com/articles/26/06/12/how-and-when-macos-will-finally-stop-support-for-intel-apps
- TechRadar — macOS 27 Golden Gate, everything you need to know — https://www.techradar.com/computing/mac-os/macos-27-golden-gate-announced-at-wwdc-2026-heres-everything-you-need-to-know
- Macworld — macOS 27 Golden Gate guide — https://www.macworld.com/article/3139330/macos-27-mac-features-siri-apple-intelligence-release-date-compatibility.html
- Macworld — macOS 27 compatibility / which Macs — https://www.macworld.com/article/673697/what-version-of-macos-can-my-mac-run.html
- Michael Tsai — Xcode 27 Announced — https://mjtsai.com/blog/2026/06/09/xcode-27-announced/
- Michael Tsai — SwiftUI in appleOS 27 — https://mjtsai.com/blog/2026/06/19/swiftui-in-appleos-27/
- Swift Programming — What's New in Xcode 27 — https://swiftprogramming.com/whats-new-xcode-27/
- BleepingSwift — deployment target range in Xcode 27 — https://bleepingswift.com/blog/deployment-target-supported-range-xcode-27
- OSXDaily — Reduce Transparency in macOS Tahoe (26.3 fix) — https://osxdaily.com/2026/02/13/reduce-transparency-works-again-in-macos-tahoe-26-3/
- TechTimes — Rosetta 2 end of support / macOS 28 — https://www.techtimes.com/articles/317445/20260530/rosetta-2-end-support-macos-28-will-break-18000-intel-apps-2027.htm
- 9to5Mac — macOS 27 Golden Gate changes Tahoe critics will appreciate — https://9to5mac.com/2026/06/09/macos-27-golden-gate-includes-these-changes-that-tahoe-critics-will-appreciate/
