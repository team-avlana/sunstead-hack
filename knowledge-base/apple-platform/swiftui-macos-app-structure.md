# Modern SwiftUI macOS App Structure

_Last updated: 2026-06-24_

Architecture reference for Rainy: a non-trivial native macOS app (SwiftUI, macOS 27 "Golden
Gate", post-WWDC 2026) with a main window (home + canvas), a Settings scene, and a menu bar
companion. Focus is current best practice as of mid-2026.

> **[VERIFY on 27]** Scene/Observation APIs below are stable since macOS 14–15. macOS 26/27
> add Liquid Glass material and refined window styling; reconfirm any cosmetic modifiers
> against the shipping 27 SDK.

---

## 1. App / Scene / Window vocabulary

```
App                      // @main entry, conforms to App protocol
 └─ body: some Scene      // a SceneBuilder
     ├─ WindowGroup       // user-creatable, multi-instance windows (documents, main UI)
     ├─ Window            // a single, unique window (max one instance)
     ├─ Settings          // the Preferences/Settings window (⌘,) — macOS only
     ├─ MenuBarExtra      // menu bar item (see menu-bar-app.md)
     └─ DocumentGroup     // document-based apps
```

- **`WindowGroup`** — use for windows the user can have several of, or that you open by `id`.
  Each new window gets fresh `@State`. Good default for a main UI window you may reopen.
- **`Window`** — a singleton window (e.g. a global inspector or canvas you only ever want one
  of). No new-window menu item, no duplication.
- **`Settings`** — declares the standard Settings window, wired to ⌘, automatically. Don't
  hand-roll a preferences window.

```swift
@main
struct RainyApp: App {
    @State private var model = AppModel()   // app-lifetime root state

    var body: some Scene {
        WindowGroup("Rainy", id: "main") {
            RootView()
                .environment(model)          // inject into the environment
        }
        .defaultSize(width: 1100, height: 720)
        .windowResizability(.contentSize)

        Settings {
            SettingsView().environment(model)
        }

        MenuBarExtra("Rainy", systemImage: "cloud.rain") { /* ... */ }
            .menuBarExtraStyle(.window)
    }
}
```

---

## 2. Observation framework — `@Observable` (current default)

Since macOS 14 / Swift 5.9 the **Observation** framework replaces `ObservableObject`.
For a 2026 app, use `@Observable` everywhere; reserve `ObservableObject` only for back-compat.

```swift
import Observation

@Observable
final class AppModel {
    var sessions: [Session] = []
    var selection: Session.ID?
    var isCanvasOpen = false
    // No @Published. All stored props are observed automatically.
    // Use @ObservationIgnored to opt a property out.
    @ObservationIgnored private var cache: [String: Data] = [:]
}
```

Why it matters: **fine-grained tracking**. A SwiftUI view re-renders only when a property it
*actually reads* changes — not on every object mutation (the old `ObservableObject` failure
mode). This is a real perf win for Rainy's canvas.

### Property-wrapper mapping (old → new)
| Role | ObservableObject era | Observation era |
|------|----------------------|-----------------|
| Own + create the model | `@StateObject var m = M()` | `@State private var m = M()` |
| Receive a passed model | `@ObservedObject var m` | plain `let m: M` (or `var`) |
| Inject app-wide | `.environmentObject(m)` | `.environment(m)` |
| Read from environment | `@EnvironmentObject var m` | `@Environment(M.self) var m` |
| Two-way binding into model | `$m.prop` | `@Bindable var m: M` → `$m.prop` |

```swift
struct RootView: View {
    @Environment(AppModel.self) private var model

    var body: some View {
        @Bindable var model = model            // local @Bindable to get bindings
        TextField("Title", text: $model.title) // $ works thanks to @Bindable
    }
}
```

- `@State` now owns *both* value types and `@Observable` reference types.
- `@Environment(Type.self)` reads an injected observable; crashes if not injected, so inject at
  the scene root.
- `@Bindable` produces `$`-bindings from an `@Observable` object (in a view or as a property).

---

## 3. `@Environment` for dependency injection

Inject app-wide services/models once at the scene root with `.environment(_:)`; read them
anywhere below with `@Environment(_.self)`. Also use the built-in environment values:

```swift
@Environment(\.openWindow)  private var openWindow
@Environment(\.dismissWindow) private var dismissWindow
@Environment(\.openURL)     private var openURL
@Environment(\.colorScheme) private var colorScheme
@Environment(\.scenePhase)  private var scenePhase
```

For custom values you can also define an `EnvironmentKey`, but for objects prefer
`.environment(model)` + `@Environment(Model.self)`.

---

## 4. Multi-window management

- **Open by id:** declare `WindowGroup(id:)` or `Window(id:)`, then:
  ```swift
  openWindow(id: "canvas")
  openWindow(id: "inspector", value: session.id)   // value-based, needs WindowGroup(for:)
  ```
- **Value-driven windows:** `WindowGroup(for: Session.ID.self) { id in CanvasView(id) }` opens
  one window per distinct value and reuses an existing one if already open.
- **Dismiss:** `@Environment(\.dismissWindow)` / `dismiss()`.
- **Scene-level config:** `.defaultSize`, `.defaultPosition`, `.windowResizability`,
  `.windowToolbarStyle`, `.defaultWindowPlacement` **[VERIFY on 27]**, `.commands { }` for menu
  bar commands, `.handlesExternalEvents` for URL/handoff routing.

---

## 5. Navigation — `NavigationSplitView`

The macOS-idiomatic shell is a two- or three-column split view (sidebar + content + detail).

```swift
struct RootView: View {
    @Environment(AppModel.self) private var model
    var body: some View {
        @Bindable var model = model
        NavigationSplitView {
            List(model.sessions, selection: $model.selection) { s in
                Text(s.title).tag(s.id)
            }
            .navigationSplitViewColumnWidth(min: 200, ideal: 240)
        } detail: {
            if let id = model.selection { CanvasView(sessionID: id) }
            else { ContentUnavailableView("Select a session", systemImage: "cloud.rain") }
        }
    }
}
```

- Drive selection with a binding to your `@Observable` model — keeps deep links/restoration easy.
- `NavigationStack` (with `navigationDestination`) for push-style flows within a column.
- `.navigationSplitViewStyle(.balanced)` / `.prominentDetail` to tune column behavior.
- `ContentUnavailableView` for empty states (macOS 14+).

---

## 6. Window styling & sizing

```swift
WindowGroup { RootView() }
    .defaultSize(width: 1100, height: 720)        // initial size
    .windowResizability(.contentSize)             // .automatic | .contentSize | .contentMinSize
    .windowStyle(.titleBar)                        // .titleBar | .hiddenTitleBar | .plain
    .windowToolbarStyle(.unified)                  // .automatic | .unified | .unifiedCompact | .expanded
```

- **Fixed-size window:** set a `.frame(width:height:)` on the root view + `.windowResizability(.contentSize)`.
- **Hidden title bar / immersive canvas:** `.windowStyle(.hiddenTitleBar)`.
- **Containers / backgrounds:** macOS 15 added `.containerBackground` and presentation-sizing
  modifiers. **[VERIFY on 27]** macOS 26/27 Liquid Glass affects default window/sidebar
  materials — verify any custom background against the SDK so you don't fight the glass.
- Per-scene `.commands { CommandGroup(...) }` to add/replace menu bar menu items.

---

## 7. Recommended project structure for a non-trivial app

A pragmatic, testable layout for Rainy (SwiftUI's `@Observable` flow is "effectively MVVM" —
you usually don't need a separate ViewModel layer; models + small services suffice):

```
Rainy/
├── RainyApp.swift            # @main, scenes, DI root (.environment)
├── AppDelegate.swift         # NSApplicationDelegateAdaptor: lifecycle, status item, sidecar
├── Models/                   # @Observable state + domain types
│   ├── AppModel.swift
│   └── Session.swift
├── Services/                 # I/O, persistence, networking, sidecar/process control
│   ├── Persistence.swift
│   └── EngineClient.swift
├── Features/                 # one folder per feature/screen
│   ├── Home/
│   │   ├── HomeView.swift
│   │   └── HomeModel.swift   # feature-scoped @Observable, only if it earns its keep
│   ├── Canvas/
│   └── MenuBar/
│       └── MenuBarPanel.swift
├── DesignSystem/             # shared views, styles, colors, modifiers
├── Settings/
│   └── SettingsView.swift
└── Resources/                # assets, Info.plist, entitlements
```

Guidelines:
- **One source of truth:** a root `@Observable AppModel` injected via `.environment`;
  feature models for local state only when complexity justifies them.
- **Keep views thin:** views read model properties and call methods; logic lives in models/services.
- **Services are protocol-fronted** for testability and to swap real vs. mock (e.g. the sidecar
  engine client).
- **Swift 6 concurrency:** annotate UI types `@MainActor`, isolate background work in actors /
  `Task`s; the project should compile under the Swift 6 language mode / strict concurrency.
- **Avoid heavy controllers/coordinators** unless navigation truly demands it — SwiftUI's
  scene + navigation APIs cover most of it. Add coordinators only for complex programmatic flows.

---

## 8. Quick best-practice checklist (2026)

- [ ] `@Observable` models; `@State` to own, `@Environment(_.self)` to read, `@Bindable` for bindings.
- [ ] No `ObservableObject` / `@Published` / `@EnvironmentObject` in new code.
- [ ] `WindowGroup(id:)` + `openWindow`/`dismissWindow` for multi-window; `Window` for singletons.
- [ ] `Settings { }` scene for preferences (not a hand-rolled window).
- [ ] `NavigationSplitView` for the main shell; `ContentUnavailableView` for empty states.
- [ ] `.defaultSize` + `.windowResizability` to control sizing.
- [ ] Swift 6 strict concurrency; `@MainActor` on UI, actors for background.
- [ ] Verify Liquid Glass / window material details against the macOS 27 SDK. **[VERIFY on 27]**

---

## Sources

- App — Apple Developer Documentation: https://developer.apple.com/documentation/swiftui/app
- Managing model data in your app — Apple Developer Documentation: https://developer.apple.com/documentation/SwiftUI/Managing-model-data-in-your-app
- Migrating from ObservableObject to the Observable macro — Apple Developer Documentation: https://developer.apple.com/documentation/swiftui/migrating-from-the-observable-object-protocol-to-the-observable-macro
- Observation — Apple Developer Documentation: https://developer.apple.com/documentation/observation
- NavigationSplitView — Apple Developer Documentation: https://developer.apple.com/documentation/swiftui/navigationsplitview
- WindowGroup — Apple Developer Documentation: https://developer.apple.com/documentation/swiftui/windowgroup
- Window Management with SwiftUI 4 — FlineDev: https://www.fline.dev/window-management-on-macos-with-swiftui-4/
- Customizing windows in SwiftUI — Swift with Majid: https://swiftwithmajid.com/2024/08/06/customizing-windows-in-swiftui/
- SwiftUI App Architecture for Solo Developers in 2026 — Emrld Labs: https://emrldlabs.com/blog/swiftui-app-architecture-for-solo-developers-in-2026/
- Presenting secondary windows on macOS with SwiftUI — SerialCoder.dev: https://serialcoder.dev/text-tutorials/swiftui/presenting-secondary-windows-on-macos-with-swiftui/
