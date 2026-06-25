# Liquid Glass in SwiftUI

_Last updated: 2026-06-24_

Practical implementation guide for **Rainy** (SwiftUI, infinite-canvas productivity app, targeting macOS 27 "Golden Gate").

> **Availability:** the Liquid Glass API was introduced in **macOS/iOS 26.0 (2025)** and is **unchanged in macOS 27**. Golden Gate refines rendering, defaults, and adds a user translucency slider — not the developer API (see §9 and `macos-27-golden-gate.md`).

---

## 1. `glassEffect(_:in:)` — the core modifier

**Signature (Apple):**
```swift
nonisolated func glassEffect(
    _ glass: Glass = .regular,
    in shape: some Shape = DefaultGlassEffectShape()   // DefaultGlassEffectShape == Capsule
) -> some View
```
Availability: iOS/iPadOS/macOS/tvOS/watchOS/Mac Catalyst **26.0+**.

It renders a shape *behind* the view filled with the Liquid Glass material, then layers Liquid Glass's foreground effects *over* the view. The material fills the entire frame **including padding** — so apply padding **before** `.glassEffect()`.

```swift
Text("Hello, World!")
    .font(.title)
    .padding()
    .glassEffect()                                  // .regular, Capsule

Image(systemName: "star")
    .padding()
    .glassEffect(.regular, in: .rect(cornerRadius: 16))
```

> ⚠️ A third-party reference shows an `isEnabled: Bool = true` parameter; Apple's canonical doc does **not** list it. Use `.identity` (§2) for conditional disable instead.

---

## 2. The `Glass` type

```swift
struct Glass    // Equatable, Sendable — "configuration of the Liquid Glass material"

static var regular:  Glass   // default adaptive material — use for almost everything
static var clear:    Glass   // more transparent variant — narrow use (see §6)
static var identity: Glass   // no-op: renders as if no glass applied

func tint(_ color: Color?)  -> Glass         // returns a tinted copy
func interactive(_ isInteractive: Bool) -> Glass   // returns an interactive copy
```

In practice `tint` and `interactive` are chainable and commonly called via convenience forms (`interactive()` defaults to `true`):
```swift
.glassEffect(.clear.tint(.red))
.glassEffect(.regular.interactive())
.glassEffect(.regular.tint(.blue).interactive())    // chainable
```

> ⚠️ **Arity note:** Apple docs show `tint(_ color: Color?)` and `interactive(_ isInteractive: Bool)` (args). Many blogs/samples use parameterless `interactive()`. Both compile.

**Conditional disable — prefer `.identity` over removing the modifier:**
```swift
.glassEffect(isEnabled ? .regular : .identity)
```
`.identity` avoids layout/identity churn and keeps morph animations stable.

---

## 3. `GlassEffectContainer` — merging, morphing, performance

```swift
@MainActor @preconcurrency
init(spacing: CGFloat? = nil, @ViewBuilder content: () -> Content)
```
Availability: 26.0+. Extracts the glass shapes from its content and renders them in **one pass** so they can **merge and morph**, sharing a single sampling region.

**Why it matters:**
1. **Visual merging** — adjacent glass shapes blend into one fluid shape instead of separate panes.
2. **Performance** — glass sampling is expensive; the container samples the background **once** for all children instead of once per glass view (§7).

**`spacing` = morph threshold.** Shapes at/within `spacing` of each other blend/morph; beyond it they stay separate.

```swift
GlassEffectContainer(spacing: 20) {
    HStack(spacing: 20) {
        Image(systemName: "scribble").frame(width: 60, height: 60).glassEffect()
        Image(systemName: "eraser").frame(width: 60, height: 60).glassEffect()
    }
}
```

**Always wrap multiple glass elements in a container.**

---

## 4. Morphing transitions: `glassEffectID(_:in:)` + `@Namespace`

```swift
nonisolated func glassEffectID(
    _ id: (some Hashable & Sendable)?,
    in namespace: Namespace.ID
) -> some View
```
Availability: 26.0+. Gives a glass effect an identity so SwiftUI can **animate shapes into/out of each other** as views appear/disappear. Requires a `GlassEffectContainer` ancestor + the `glassEffect` modifier.

```swift
struct MorphView: View {
    @Namespace private var namespace
    @State private var expanded = false

    var body: some View {
        GlassEffectContainer(spacing: 20) {
            HStack {
                Image(systemName: "star")
                    .frame(width: 60, height: 60)
                    .glassEffect()
                    .glassEffectID("star", in: namespace)
                if expanded {
                    Image(systemName: "heart")
                        .frame(width: 60, height: 60)
                        .glassEffect()
                        .glassEffectID("heart", in: namespace)
                }
            }
        }
        .onTapGesture { withAnimation { expanded.toggle() } }
    }
}
```

**Related:**
- `glassEffectTransition(_:)` — custom transition behavior for the glass effect.
- `glassEffectUnion(id:namespace:)` — **fuses** multiple glass views that share the same `id`, **shape, and variant** into a *single* continuous shape (e.g. a grouped control cluster). Different from `glassEffectID`, which tracks distinct identities for morphing.
  ```swift
  @MainActor @preconcurrency
  func glassEffectUnion(id: (some Hashable & Sendable)?, namespace: Namespace.ID) -> some View
  ```

---

## 5. `.interactive()`

Makes glass respond to touch/pointer with system motion — a **scale/bounce and fluid, gel-like reaction** that follows the gesture and reacts to the content behind it. Use for tappable/draggable glass controls; omit for static surfaces.

```swift
.glassEffect(.regular.interactive())
```

---

## 6. Apple HIG rules

From WWDC25 "Meet Liquid Glass" (219) and "Get to know the new design system" (356):

- **Functional / navigation layer ONLY.** Glass floats *above* content (tab bars, toolbars, sidebars, controls, sheets). **Never apply it to the content layer** (lists, tables, text bodies, media).
- **No glass-on-glass.** Don't stack/nest glass on glass — sampling glass over glass is muddy and illegible. Keep a single glass layer over real content.
- **Be judicious with tint.** Tint only to emphasize a **primary** action — not decoratively. Let content shine through.
- **`.regular` vs `.clear`:**
  - **`.regular`** — default for almost everything; adaptive and legible over arbitrary content.
  - **`.clear`** — only when ALL hold: (1) it sits over media-rich/bright content, (2) that content isn't harmed by a dimming layer, and (3) foreground content over the glass is bold/bright enough to stay legible. Otherwise use `.regular`.
- **Concentricity / corner radius.** Nest shapes with shared centers; a concentric child derives its radius by subtracting its padding from the parent's. Use:
  ```swift
  RoundedRectangle(cornerRadius: .containerConcentric)
  ```
- **Adopt standard components** — standard SwiftUI/AppKit controls pick up glass automatically; prefer them over hand-rolled glass.
- **Accessibility is automatic** — Reduce Transparency → frostier/opaque; Increase Contrast → starker borders; Reduce Motion → calmer animations. No code changes required.

---

## 7. Performance at scale (matters for an infinite canvas)

- **Glass sampling is expensive.** Each independent `.glassEffect()` samples and refracts the background behind it; N independent glass views = N sampling passes → higher GPU/CPU, battery, heat. (One widely-cited third-party iPhone benchmark claimed ~13% vs ~1% battery delta — ⚠️ unverified number, but the *direction* is real.)
- **`GlassEffectContainer` is the primary optimization** — batches all children into **one** sampling region. Always use it for multiple glass elements.
- **Canvas/scrolling:** keep glass on the **floating navigation chrome**, not on each scrolling cell or canvas node. Glass on many `List`/`LazyVStack` rows multiplies cost per visible row *and* violates the content-layer rule.
- **Conditional disable via `.identity`** (not add/remove) to avoid layout recomputation and identity churn.
- Limit continuous glass animations; profile on ~3-year-old hardware.

**For Rainy specifically:** apply glass to the toolbar / floating palettes / inspector chrome that hover over the canvas — **never to the canvas content or to individual nodes**. Group all chrome glass under as few `GlassEffectContainer`s as practical.

---

## 8. Pitfalls & migration notes

- **From `.ultraThinMaterial` / `UIBlurEffect`:** the conceptual replacement for floating-chrome blur is `.glassEffect(.regular, in:)`. Don't blanket-replace — materials on *content backgrounds* should usually just be **removed** (content gets no glass).
  ```swift
  // Old:  .background(.ultraThinMaterial)
  // New:  .glassEffect(.regular, in: .rect(cornerRadius: 16))
  ```
- **⚠️ Automatic adoption on SDK bump:** compiling against the 26/27 SDK makes standard **toolbar items, buttons, tab bars, navigation** adopt Liquid Glass with no opt-in. Toolbar items get a shared grouped glass background; `ToolbarItemPlacement` now affects *appearance* too (e.g. `.confirmationAction` → `.glassProminent` button style). **Audit your chrome after recompiling.**
- **`backgroundExtensionEffect()`** (WWDC25 / iOS 26) — extends content *behind* sidebars/inspectors/toolbars by mirroring + blurring it for continuity under the chrome. Used parameterless; common in a `NavigationSplitView` detail column:
  ```swift
  Image(recipe.imageName)
      .resizable().scaledToFill()
      .backgroundExtensionEffect()
  ```
  ⚠️ Exact signature/availability not fully published — confirm in Xcode quick-help.
- **Common mistakes:** glass on content; glass-on-glass nesting; forgetting `GlassEffectContainer` (loses morphing + tanks performance); over-tinting; padding *after* glass (material won't cover the padding); `glassEffectID` without an enclosing container.

---

## 9. macOS 27 "Golden Gate" notes

**The SwiftUI API surface is unchanged** — same `glassEffect` / `Glass` / `GlassEffectContainer` / `glassEffectID` (all still 26.0+). Golden Gate changes rendering and adds a **user translucency/tint slider** (System Settings → Appearance) that dials glass from more opaque/tinted toward clearer, system-wide.

**Actionable for developers:** no API migration 26→27. But because users can now choose translucency, **verify your glass chrome stays legible across the slider range**, and rely on `.containerConcentric` radii (Golden Gate enforces uniform corners more strictly). See `macos-27-golden-gate.md` §3.

> ⚠️ macOS 27 is in beta as of 2026-06-24; Golden Gate specifics are subject to change.

---

## Sources

**Apple (canonical):**
- glassEffect(_:in:) — https://developer.apple.com/documentation/swiftui/view/glasseffect(_:in:)
- Glass — https://developer.apple.com/documentation/swiftui/glass
- GlassEffectContainer — https://developer.apple.com/documentation/swiftui/glasseffectcontainer
- glassEffectID(_:in:) — https://developer.apple.com/documentation/swiftui/view/glasseffectid(_:in:)
- glassEffectUnion(id:namespace:) — https://developer.apple.com/documentation/swiftui/view/glasseffectunion(id:namespace:)
- Applying Liquid Glass to custom views — https://developer.apple.com/documentation/SwiftUI/Applying-Liquid-Glass-to-custom-views
- Landmarks: background extension effect — https://developer.apple.com/documentation/SwiftUI/Landmarks-Applying-a-background-extension-effect
- Landmarks: refining system glass in toolbars — https://developer.apple.com/documentation/SwiftUI/Landmarks-Refining-the-system-provided-glass-effect-in-toolbars
- WWDC25 219 — Meet Liquid Glass — https://developer.apple.com/videos/play/wwdc2025/219/
- WWDC25 356 — Get to know the new design system — https://developer.apple.com/videos/play/wwdc2025/356/
- WWDC25 256 — What's new in SwiftUI — https://developer.apple.com/videos/play/wwdc2025/256/
- macOS 27 release notes — https://developer.apple.com/documentation/macos-release-notes/macos-27-release-notes

**Dev blogs / references:**
- Swift with Majid — Glassifying custom SwiftUI views — https://swiftwithmajid.com/2025/07/16/glassifying-custom-swiftui-views/
- Swift with Majid — Glassifying views in groups — https://swiftwithmajid.com/2025/07/23/glassifying-custom-swiftui-views-groups/
- Swift with Majid — Glassifying toolbars — https://swiftwithmajid.com/2025/07/01/glassifying-toolbars-in-swiftui/
- conorluddy/LiquidGlassReference — https://github.com/conorluddy/LiquidGlassReference
- Create with Swift — morphing with glassEffectID — https://www.createwithswift.com/morphing-glass-effect-elements-into-one-another-with-glasseffectid/
- DEV — Understanding GlassEffectContainer — https://dev.to/arshtechpro/understanding-glasseffectcontainer-in-ios-26-2n8p
- SerialCoder — transforming glass views with glassEffectID — https://serialcoder.dev/text-tutorials/swiftui/transforming-glass-views-with-the-glasseffectid-modifier-in-swiftui/
- Nil Coalescing — backgroundExtensionEffect — https://nilcoalescing.com/blog/BackgroundExtensionEffectInSwiftUI/

**macOS 27 Golden Gate:**
- MacRumors — how Liquid Glass is changing — https://www.macrumors.com/2026/06/09/macos-golden-gate-liquid-glass/
- 9to5Mac — Golden Gate changes Tahoe critics will appreciate — https://9to5mac.com/2026/06/09/macos-27-golden-gate-includes-these-changes-that-tahoe-critics-will-appreciate/
- Wccftech — macOS 27 Golden Gate preview — https://wccftech.com/macos-27-golden-gate-preview-announced-at-wwdc-2026/

### Key flags / uncertainties
1. `tint`/`interactive` arity: Apple shows args; blogs use parameterless. Both compile.
2. `isEnabled:` on `glassEffect` appears only in a third-party ref — use `.identity` instead.
3. `backgroundExtensionEffect()` exact signature/availability not fully published.
4. ~13% battery figure (§7) is unverified third-party; the qualitative cost point is sound.
5. macOS 27 Golden Gate is beta; §9 items subject to change.
