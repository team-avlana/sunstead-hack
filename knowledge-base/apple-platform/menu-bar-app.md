# Building a macOS Menu Bar App

_Last updated: 2026-06-24_

Implementation reference for Rainy's menu bar companion: a persistent status-bar item that
coexists with the main app window (home + canvas). Targets macOS 27 "Golden Gate" (SwiftUI),
backward-friendly to macOS 13+ where the SwiftUI API exists.

> Beta/uncertain flags appear inline as **[VERIFY on 27]**. macOS 27 is post-WWDC 2026; the
> SwiftUI scene APIs below are stable since macOS 13–15, but 26/27-specific rendering details
> (Liquid Glass menu bar styling) should be confirmed against the current SDK.

---

## 1. The two building blocks

| Approach | Use when |
|----------|----------|
| `MenuBarExtra` (SwiftUI scene) | Pure SwiftUI, declarative, you want a menu OR a small popover window. Default choice. |
| `NSStatusItem` (AppKit) | You need fine control: left/right-click discrimination, drag, custom button view, precise popover anchoring/sizing, `NSStatusItem` length, or you must run on a code path that fights the SwiftUI lifecycle. |

`MenuBarExtra` is available **macOS 13 (Ventura)+**. For Rainy on macOS 27 this is fine.

---

## 2. MenuBarExtra scene

Declared as a `Scene` in your `App` body — it can sit alongside `WindowGroup`/`Window`.

```swift
@main
struct RainyApp: App {
    @State private var model = AppModel()

    var body: some Scene {
        // Main app window (home + canvas)
        WindowGroup("Rainy", id: "main") {
            RootView().environment(model)
        }

        // Persistent menu bar item
        MenuBarExtra("Rainy", systemImage: "cloud.rain") {
            MenuBarContent().environment(model)
        }
        .menuBarExtraStyle(.window)   // or .menu (default)
    }
}
```

### Initializer shapes
```swift
// Text + SF Symbol
MenuBarExtra("Rainy", systemImage: "cloud.rain") { ... }
// Custom label view (image asset, dynamic content)
MenuBarExtra { content } label: { Image(.menuBarIcon) }
// Conditionally show/hide the item via a Bool binding
MenuBarExtra("Rainy", systemImage: "cloud.rain", isInserted: $showItem) { ... }
```
The `isInserted: Binding<Bool>` lets the user toggle the icon on/off (wire it to a Setting).

---

## 3. `.menu` vs `.window` style

`.menuBarExtraStyle(_:)` chooses the presentation:

- **`.menu` (default, `PullDownMenuBarExtraStyle`)** — renders as a native pull-down menu.
  Only menu-appropriate views survive: `Button`, `Toggle`, `Text`, `Divider`, `Menu`
  (submenus). **Custom button styles, sliders, images, and arbitrary layout are ignored**
  to match standard macOS menus. Best for command lists / quick toggles.

  ```swift
  MenuBarExtra("Rainy", systemImage: "cloud.rain") {
      Button("New Session") { model.newSession() }
      Toggle("Active", isOn: $model.isActive)
      Divider()
      Button("Quit") { NSApp.terminate(nil) }
          .keyboardShortcut("q")
  }
  // implicit .menu
  ```

- **`.window` (`WindowMenuBarExtraStyle`)** — renders a small popover-like chromeless window.
  Renders **any** SwiftUI content (sliders, charts, custom controls, scroll views). Best for
  Rainy's richer companion panel. Size it with `.frame` on the root content.

  ```swift
  MenuBarExtra("Rainy", systemImage: "cloud.rain") {
      MenuBarPanel()
          .frame(width: 320, height: 420)   // fixed; omit for content-driven sizing
  }
  .menuBarExtraStyle(.window)
  ```

Because a `.window`-style extra has no Dock/menu, give it its own Quit affordance:
```swift
.overlay(alignment: .topTrailing) {
    Button("Quit", systemImage: "xmark.circle.fill") { NSApp.terminate(nil) }
        .labelStyle(.iconOnly).buttonStyle(.plain).padding(6)
}
```

---

## 4. NSStatusItem (AppKit) when you need control

`MenuBarExtra` does not expose click-type discrimination, drag, or live anchoring. Drop to
AppKit via an `NSApplicationDelegateAdaptor`.

```swift
final class StatusController: NSObject {
    private var statusItem: NSStatusItem!
    private let popover = NSPopover()

    func install() {
        statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
        if let button = statusItem.button {
            button.image = NSImage(systemSymbolName: "cloud.rain", accessibilityDescription: "Rainy")
            button.action = #selector(toggle(_:))
            button.target = self
            button.sendAction(on: [.leftMouseUp, .rightMouseUp]) // detect click type
        }
        popover.behavior = .transient                 // auto-dismiss on outside click
        popover.contentViewController = NSHostingController(rootView: MenuBarPanel())
    }

    @objc private func toggle(_ sender: NSStatusBarButton) {
        let event = NSApp.currentEvent!
        if event.type == .rightMouseUp { showMenu(); return }
        if popover.isShown { popover.performClose(nil) }
        else { popover.show(relativeTo: sender.bounds, of: sender, preferredEdge: .minY) }
    }
}
```
Create the status item in `applicationDidFinishLaunching`, **not** in `init` — the status bar
isn't ready earlier. Hold a strong reference (it's not retained for you).

> **[VERIFY on 27]** On macOS 26 (Tahoe) the menu bar adopted Liquid Glass. Status item
> buttons render their template image into that material automatically; provide a
> **template** image (monochrome, `isTemplate = true`) so it tints correctly in light/dark
> and under the glass. Confirm exact metrics (~18pt icon height) against the 27 SDK.

---

## 5. Menu-bar-only (agent) apps: LSUIElement / activation policy

Two interchangeable ways to make the app a background agent with **no Dock icon and no
app-switcher entry**:

- **Info.plist:** `LSUIElement = YES` (Xcode target → Info → "Application is agent (UIElement)").
  This is static: the app launches as `.accessory`.
- **Runtime:** `NSApp.setActivationPolicy(.accessory)` — dynamic, can be toggled later.

Activation policies:
| Policy | Dock icon | Menu bar (app menu) | Use |
|--------|-----------|---------------------|-----|
| `.regular` | yes | yes | normal app |
| `.accessory` | no | no | menu-bar / agent |
| `.prohibited` | no | no | fully headless |

Caveat: when launched as `.accessory`/`LSUIElement`, the app does **not** auto-activate.
Only call `NSApp.activate(ignoringOtherApps: true)` in response to a real user click (opening
the panel / main window), never on launch.

---

## 6. The Rainy case: one app with BOTH a main window AND a menu bar item

This is the important pattern. You want:
- a real main window (home + canvas) that behaves like a normal app when open, and
- a persistent menu bar item that survives after the window closes.

### Strategy: dynamic activation policy
Do **not** set `LSUIElement = YES` (that would suppress the Dock icon even while the window is
open). Instead launch `.regular` and demote to `.accessory` when no windows are visible, so
Rainy keeps living as a menu bar agent.

```swift
@main
struct RainyApp: App {
    @NSApplicationDelegateAdaptor(AppDelegate.self) var appDelegate
    @State private var model = AppModel()

    var body: some Scene {
        WindowGroup("Rainy", id: "main") {
            RootView().environment(model)
        }
        .windowResizability(.contentSize)

        MenuBarExtra("Rainy", systemImage: "cloud.rain") {
            MenuBarPanel(openMain: { appDelegate.showMainWindow() })
                .environment(model)
                .frame(width: 320, height: 420)
        }
        .menuBarExtraStyle(.window)

        Settings { SettingsView().environment(model) }
    }
}

final class AppDelegate: NSObject, NSApplicationDelegate {
    // Keep running as an agent after the last window closes.
    func applicationShouldTerminateWhenLastWindowClosed(_ s: NSApplication) -> Bool { false }

    func applicationDidFinishLaunching(_ n: Notification) {
        // Start as accessory; promote when a window is actually shown.
        NSApp.setActivationPolicy(.accessory)
    }

    @MainActor func showMainWindow() {
        NSApp.setActivationPolicy(.regular)        // bring back Dock icon + app menu
        NSApp.activate(ignoringOtherApps: true)
        // Reopen the SwiftUI window by id:
        EnvironmentValues().openWindow.callAsFunction(id: "main") // see note
    }
}
```

Notes / gotchas:
- `openWindow` is an `@Environment(\.openWindow)` action — call it from inside a SwiftUI view
  (e.g. the menu bar panel button) rather than the delegate. The delegate variant above is a
  shorthand; in practice pass an `openWindow` closure down from a SwiftUI view, or post a
  notification the root view observes.
- To demote back to `.accessory` when the last window closes, observe
  `NSWindow.willCloseNotification` (or track open windows) and call
  `NSApp.setActivationPolicy(.accessory)`.
- `applicationShouldTerminateWhenLastWindowClosed → false` is what keeps the process (and thus
  the menu bar item) alive when the window is gone.

### Alternative: always-regular
If you're fine with Rainy always showing a Dock icon, skip the policy juggling entirely: just
declare `WindowGroup` + `MenuBarExtra` and set `applicationShouldTerminateWhenLastWindowClosed`
to `false`. Simpler, fewer edge cases; you lose the "pure agent when idle" look.

---

## 7. Lifecycle & keeping a sidecar/background process alive

The menu bar item lives as long as the **process** lives, so "keep the menu bar alive" ==
"keep the process alive":

1. `applicationShouldTerminateWhenLastWindowClosed → false` (above). This is the core lever.
2. If Rainy spawns a **sidecar/helper process** (e.g. a local engine, watcher, or render
   worker), manage it explicitly:
   - **In-process work:** run on a Swift Concurrency `Task` / actor owned by an `@Observable`
     model held by the `App` (lives for the app's lifetime). Use a long-lived `Task` and
     cancel on `applicationWillTerminate`.
   - **Separate executable:** launch with `Process` (`/usr/bin/env`), keep a strong reference,
     set `terminationHandler` to relaunch on crash, and tear it down in
     `applicationWillTerminate`. Guard against double-launch.
   - **Survive logout / auto-launch at login:** register a login item via
     **`SMAppService.mainApp` / `SMAppService.daemon` / `.agent`** (ServiceManagement,
     macOS 13+). For a true always-on background service independent of the GUI app, ship an
     `SMAppService.daemon` (LaunchDaemon) or `.agent` (LaunchAgent) and have the menu bar app
     talk to it over XPC. **[VERIFY on 27]** SMAppService API surface is stable since 13;
     reconfirm entitlement/bundle-layout requirements on the 27 SDK.
3. Don't rely on a window or popover to host the work — both can be deallocated.

---

## 8. Quick checklist for Rainy

- [ ] `WindowGroup(id: "main")` for home + canvas; `MenuBarExtra(... ).menuBarExtraStyle(.window)`.
- [ ] `NSApplicationDelegateAdaptor` with `applicationShouldTerminateWhenLastWindowClosed = false`.
- [ ] Launch `.accessory`, promote to `.regular` on `showMainWindow`, demote on last close.
- [ ] Template menu bar icon (`isTemplate = true`) for Liquid Glass tinting **[VERIFY on 27]**.
- [ ] `NSApp.activate(ignoringOtherApps:)` only on explicit user action.
- [ ] Quit button inside the `.window`-style panel.
- [ ] Sidecar via `Process` + relaunch handler, or `SMAppService` daemon/agent + XPC.

---

## Sources

- MenuBarExtra — Apple Developer Documentation: https://developer.apple.com/documentation/SwiftUI/MenuBarExtra
- MenuBarExtraStyle — Apple Developer Documentation: https://developer.apple.com/documentation/swiftui/menubarextrastyle
- NSStatusItem — Apple Developer Documentation: https://developer.apple.com/documentation/appkit/nsstatusitem
- NSStatusBar — Apple Developer Documentation: https://developer.apple.com/documentation/appkit/nsstatusbar
- SMAppService — Apple Developer Documentation: https://developer.apple.com/documentation/servicemanagement/smappservice
- Build a macOS menu bar utility in SwiftUI — Nil Coalescing: https://nilcoalescing.com/blog/BuildAMacOSMenuBarUtilityInSwiftUI/
- Create a mac menu bar app in SwiftUI with MenuBarExtra — Sarunw: https://sarunw.com/posts/swiftui-menu-bar-app/
- SwiftUI Menu Bar App With a Floating Window: Best Practices — Fazm: https://fazm.ai/blog/swiftui-menu-bar-app-floating-window-best-practices
- A menu bar only macOS app using AppKit — Pol Piella: https://www.polpiella.dev/a-menu-bar-only-macos-app-using-appkit/
- Hands-on: building a Menu Bar experience with SwiftUI — Cindori: https://cindori.com/developer/hands-on-menu-bar
