# Writing Tools & App Intents for Rainy

_Last updated: 2026-06-24_

Implementation reference for integrating system **Writing Tools** into Rainy's text surfaces, and exposing Rainy's actions ("analyze this creator", "compare these videos", "add to canvas") to **Siri / Shortcuts / Spotlight** via **App Intents**.

Platform note: Writing Tools and the App Intents features below are macOS 15+ (Sequoia) and macOS 26+ ("Tahoe" — naming current as of WWDC25). Apple Intelligence-dependent features require a supported Apple silicon Mac with Apple Intelligence enabled. Anything tagged **[2026/beta]** below is from WWDC25 (iOS 26 / macOS 26) and should be re-verified against the shipping SDK before relying on it.

---

## PART A — Writing Tools

### What you get for free

System Writing Tools (Proofread, Rewrite — including tone variants Friendly/Professional/Concise — Summarize, Key Points, List, Table) appear automatically on **standard text views** with **no code**:

- SwiftUI `TextEditor` / `Text`, AppKit `NSTextView`, UIKit `UITextView`, and `WKWebView`.
- On macOS, Writing Tools surface in the **context menu** and the **Edit menu** when text is selected/editable.

For Rainy's SwiftUI surfaces, a plain `TextEditor` already participates. No opt-in flag is required.

### TextKit 2 is required for the inline experience

- `NSTextView` / `UITextView` must be backed by **TextKit 2** (`NSTextLayoutManager`) to get the *inline* rewrite/animation experience.
- A view still on **TextKit 1** (`NSLayoutManager`) falls back to a **panel-only** experience (results shown in a popover; user copies/applies manually).
- Gotcha: calling any legacy `NSLayoutManager` API on a text view silently migrates it back to TextKit 1 and degrades Writing Tools. Avoid touching `.layoutManager` on text views you want fully integrated.

### Opting in / out and tuning behavior

`NSTextView` / `UITextView` expose `writingToolsBehavior`:

```swift
textView.writingToolsBehavior = .complete  // full inline experience (alias: .default)
textView.writingToolsBehavior = .limited   // panel-only
textView.writingToolsBehavior = .none      // fully disabled
```

`WKWebView` defaults to `.limited`; opt up via its configuration:

```swift
webViewConfiguration.writingToolsBehavior = .complete
```

Constrain accepted formats with `writingToolsAllowedInputOptions` (`NSWritingToolsAllowedInputOptions` / `UIWritingToolsAllowedInputOptions`):

```swift
textView.writingToolsAllowedInputOptions = [.plainText, .richText, .table]
// default assumption is plainText + richText (no tables)
```

In SwiftUI, disable Writing Tools on a text surface with:

```swift
TextEditor(text: $notes)
    .writingToolsBehavior(.disabled)   // or .complete / .limited
```

### Pause app work during a Writing Tools session

Writing Tools mutates `textStorage` heavily while active. Pause iCloud/document sync, autosave, and your own text mutations during a session.

```swift
// NSTextViewDelegate (UITextViewDelegate mirrors these)
func textViewWritingToolsWillBegin(_ textView: NSTextView) {
    syncCoordinator.pause()      // stop document/canvas sync
}
func textViewWritingToolsDidEnd(_ textView: NSTextView) {
    syncCoordinator.resume()
}

// Guard ad-hoc work:
if !textView.isWritingToolsActive { performBackgroundReconcile() }
```

### Protect ranges Writing Tools should not touch

Useful in Rainy if a notes field embeds creator handles, URLs, code, or pinned quotes.

```swift
func textView(_ textView: NSTextView,
              writingToolsIgnoredRangesIn enclosingRange: NSRange) -> [NSRange] {
    let attr = textView.textStorage!.attributedSubstring(from: enclosingRange)
    return rangesForCreatorMentions(in: attr)  // your logic
}
```

`WKWebView` automatically ignores `<pre>` and `<blockquote>`.

### Custom text views (if Rainy rolls its own editor)

- **iOS/iPadOS:** adopt `UITextInteraction` to get Writing Tools in the callout bar for free. If you can't, adopt `UITextSelectionDisplayInteraction` + `UIEditMenuInteraction`.
- **macOS (AppKit):** conform to the services protocol so the system can read/write the selection. Override `validRequestor(forSendType:returnType:)` to vend `self` for `.string`/`.rtf`, then implement `writeSelection(to:types:)` (export selection) and `readSelection(from:)` (accept the rewritten text). The Writing Tools menu item then appears automatically.

See Apple's "Customizing Writing Tools behavior for AppKit views" for the full requestor contract.

### 2025/2026 notes

- The behavior/format/delegate APIs above are stable since macOS 15 / iOS 18.
- **[2026/beta]** WWDC25 sessions emphasize that as Apple Intelligence expands, custom editors should prefer TextKit 2 and the services-requestor path so they inherit future affordances automatically. No major *new* Writing Tools API surface was introduced for custom views at WWDC25 — the bigger 2026 investment is on the App Intents / Apple Intelligence side (Part B). Re-verify if Rainy ships a bespoke canvas text editor.

---

## PART B — App Intents

App Intents (pure Swift, replaces SiriKit) is the single way to expose Rainy actions to **Siri, Shortcuts, Spotlight (incl. Spotlight on Mac), the Action Button, Widgets, and Apple Intelligence**. The recommended pattern: model your data as `AppEntity`, your verbs as `AppIntent`, and surface the headline ones via an `AppShortcutsProvider`.

### 1. Entities — Rainy's "nouns"

```swift
import AppIntents

struct CreatorEntity: AppEntity {
    let id: String
    let name: String
    let platform: String

    static var typeDisplayRepresentation: TypeDisplayRepresentation { "Creator" }
    var displayRepresentation: DisplayRepresentation {
        DisplayRepresentation(title: "\(name)", subtitle: "\(platform)")
    }
    static var defaultQuery = CreatorQuery()
}

struct CreatorQuery: EntityQuery {
    func entities(for ids: [String]) async throws -> [CreatorEntity] {
        await RainyStore.shared.creators(ids: ids)
    }
    func suggestedEntities() async throws -> [CreatorEntity] {
        await RainyStore.shared.recentCreators()
    }
}
```

For free-text matching in Siri/Shortcuts, conform the query to `EntityStringQuery` and implement `entities(matching string:)`.

### 2. Intents — Rainy's "verbs"

```swift
struct AnalyzeCreatorIntent: AppIntent {
    static var title: LocalizedStringResource = "Analyze Creator"
    static var description = IntentDescription(
        "Run Rainy's analysis on a creator and summarize the result.",
        categoryName: "Analysis",
        searchKeywords: ["analyze", "creator", "stats", "audit"]
    )

    @Parameter(title: "Creator")
    var creator: CreatorEntity

    func perform() async throws -> some IntentResult & ProvidesDialog & ShowsSnippetView {
        let report = try await RainyEngine.analyze(creator)
        return .result(
            dialog: "\(creator.name) scored \(report.score). \(report.headline)",
            view: AnalysisSnippet(report: report)   // SwiftUI view
        )
    }
}
```

Patterns for Rainy's other actions:

- **"compare these videos"** — `@Parameter var videos: [VideoEntity]` (array parameter); validate count in `perform()` and `throw` an `AppIntent` error with a helpful dialog if < 2.
- **"add to canvas"** — an intent that mutates app state. Make it foreground-aware (below) so it can open and reveal the canvas, and consider `UndoableIntent` **[2026/beta]** so the add can be undone with a 3-finger swipe.

Return-value helpers worth knowing: `ReturnsValue<T>` (chainable output in Shortcuts), `ProvidesDialog` (spoken/printed response), `OpensIntent`, and `ShowsSnippetView`.

### 3. App Shortcuts — zero-setup phrases

`AppShortcutsProvider` is auto-discovered (one per app target). These phrases work in Siri immediately and the shortcuts appear in Spotlight without the user opening the Shortcuts app. **Every phrase must include `\(.applicationName)`.**

```swift
struct RainyShortcuts: AppShortcutsProvider {
    static var appShortcuts: [AppShortcut] {
        AppShortcut(
            intent: AnalyzeCreatorIntent(),
            phrases: [
                "Analyze \(\.$creator) in \(.applicationName)",
                "Run \(.applicationName) analysis on \(\.$creator)",
                "Analyze this creator with \(.applicationName)"
            ],
            shortTitle: "Analyze Creator",
            systemImageName: "chart.bar.doc.horizontal"
        )
        AppShortcut(
            intent: AddToCanvasIntent(),
            phrases: ["Add to my \(.applicationName) canvas"],
            shortTitle: "Add to Canvas",
            systemImageName: "rectangle.stack.badge.plus"
        )
    }
}
```

Best practices: keep the provider to your ~10 highest-value intents; give multiple natural phrasings per shortcut; call `updateAppShortcutParameters()` after the entity set changes so Siri re-learns suggestions.

### 4. Foreground vs. background, and revealing UI

For "add to canvas" you want the app to come forward and navigate. **[2026/beta]** WWDC25 introduced declarative modes and view-driven navigation:

```swift
struct AddToCanvasIntent: AppIntent {
    static var title: LocalizedStringResource = "Add to Canvas"
    static let supportedModes: IntentModes = [.foreground(.dynamic)]
    @Parameter var item: VideoEntity

    func perform() async throws -> some IntentResult {
        if systemContext.currentMode.canContinueInForeground {
            try await continueInForeground(alwaysConfirm: false)
        }
        await RainyStore.shared.addToCanvas(item)
        return .result()
    }
}
```

`TargetContentProvidingIntent` + the SwiftUI `.onAppIntentExecution(_:)` modifier **[2026/beta]** lets the intent stay UI-free while a view handles the actual navigation/state change — the cleaner architecture for "add to canvas".

### 5. Interactive snippets and visual results **[2026/beta]**

WWDC25 added `SnippetIntent` — a self-contained intent whose `perform()` returns a SwiftUI view that can re-run itself, so results shown in Spotlight/Siri/Shortcuts can contain **live buttons and updating content** (e.g., a Rainy analysis card with a "Re-run" or "Open in Rainy" button, or a side-by-side video comparison snippet).

```swift
struct AnalysisSnippetIntent: SnippetIntent {
    @Parameter var creator: CreatorEntity
    func perform() async throws -> some IntentResult & ShowsSnippetView {
        let report = try await RainyEngine.analyze(creator)
        return .result(view: AnalysisSnippet(report: report))
    }
}
```

Two flavors: **result** snippets (info only; "Done") and **confirmation** snippets (require an action before completing). Design guidance: large glanceable text, generous spacing, `ContainerRelativeShape` for responsive margins, animate updates with `contentTransition`.

### 6. Spotlight on Mac + Apple Intelligence hooks **[2026/beta]**

- `IndexedEntity` with `@Property(indexingKey:)` makes Rainy creators/videos appear and run as actions directly from **Spotlight on Mac**.
- `@ComputedProperty` (derive from source of truth, no duplication) and `@DeferredProperty` (lazy/async-loaded, e.g. an expensive freshness/score lookup) reduce entity hydration cost.
- `IntentValueQuery` + Visual Intelligence schemas, `@AppIntent(schema:)`, `requestChoice(between:dialog:view:)` for multi-option prompts, and `userActivity { $0.appEntityIdentifier = ... }` to expose on-screen entities to Siri/ChatGPT.
- App Intents can now live in a Swift package via `AppIntentsPackage` — good for sharing Rainy's intent definitions across app + extensions.

### Best practices checklist

- Model entities once; reuse across every intent and shortcut.
- Mark intents `static var isDiscoverable` appropriately; donate frequently-used ones so the system can predict them.
- Localize `title`, parameter titles, and `IntentDescription`; add `searchKeywords` for Spotlight.
- Make `perform()` resilient and idempotent; throw descriptive errors (they become spoken dialog).
- Keep heavy work off the main actor; only annotate UI-producing snippet bodies with `@MainActor`.
- Test every phrase with Siri and verify Spotlight/Shortcuts surfacing before shipping.

---

## Sources

- [Get started with Writing Tools — WWDC24](https://developer.apple.com/videos/play/wwdc2024/10168/)
- [Customizing Writing Tools behavior for AppKit views — Apple Developer Documentation](https://developer.apple.com/documentation/appkit/customizing-writing-tools-behavior-for-system-views)
- [NSTextView — Apple Developer Documentation](https://developer.apple.com/documentation/appkit/nstextview)
- [UITextView — Apple Developer Documentation](https://developer.apple.com/documentation/uikit/uitextview)
- [Apple Intelligence — Get Started (Apple Developer)](https://developer.apple.com/apple-intelligence/get-started/)
- [App Intents — Apple Developer Documentation](https://developer.apple.com/documentation/appintents)
- [App Shortcuts — Apple Developer Documentation](https://developer.apple.com/documentation/appintents/app-shortcuts)
- [Accelerating app interactions with App Intents — Apple Developer Documentation](https://developer.apple.com/documentation/AppIntents/AcceleratingAppInteractionsWithAppIntents)
- [Get to know App Intents — WWDC25](https://developer.apple.com/videos/play/wwdc2025/244/)
- [Explore new advances in App Intents — WWDC25](https://developer.apple.com/videos/play/wwdc2025/275/)
- [Design interactive snippets — WWDC25](https://developer.apple.com/videos/play/wwdc2025/281/)
