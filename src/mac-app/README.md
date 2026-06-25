# mac-app

The native macOS shell (Swift / SwiftUI + **WKWebView**) that hosts `../canvas-ui` and launches/manages
the local services. See `../../docs/architecture.md` for its role.

**Before writing code, read:**
- `../../knowledge-base/architecture-patterns/webview-shell-and-data-path.md` — WKWebView packaging, the JS↔Swift bridge, custom URL scheme
- `../../knowledge-base/apple-platform/swiftui-macos-app-structure.md` — app/scene structure, Observation
- `../../knowledge-base/apple-platform/menu-bar-app.md` — `MenuBarExtra` + window, activation policy
- `../../knowledge-base/apple-platform/liquid-glass-swiftui.md` — glass on chrome only

**Targets:** macOS 27 / latest Xcode beta, Apple-silicon-only. Hosts the static `canvas-ui` export via a
custom `WKURLSchemeHandler`; in dev, loads `http://localhost:3000` from `next dev`.

_Xcode project not yet created — frontend-first per `../../docs/DECISIONS.md` D19/D26._
