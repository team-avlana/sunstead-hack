# Speech Framework (On-Device Transcription)

_Last updated: 2026-06-24_

Practical reference for transcribing audio in Rainy: turning a creator video's audio track into text (captions, keyword analysis, searchable transcript), plus live dictation. Covers the modern **`SpeechAnalyzer` / `SpeechTranscriber`** API (new in 2025, iOS/macOS 26) and the older **`SFSpeechRecognizer`**.

## TL;DR for Rainy

- **Transcribing video audio on-device** → modern **`SpeechAnalyzer` + `SpeechTranscriber`** (iOS 26 / macOS 26). Purpose-built for **long-form** audio (lectures, meetings, full videos), fully on-device, fast (Apple claims ~2× Whisper Large v3 Turbo), with word-level time ranges.
- **Need to support macOS < 26** → fall back to **`SFSpeechRecognizer`** with `requiresOnDeviceRecognition = true`.
- Both are on-device (privacy-safe, no per-call cost). The new API is the one to build on; keep `SFSpeechRecognizer` only as a compatibility fallback.

## Modern API: `SpeechAnalyzer` + `SpeechTranscriber` (2025)

Introduced WWDC25 ("Bring advanced speech-to-text to your app with SpeechAnalyzer"). **Availability: iOS 26+, macOS 26+, iPadOS 26+, visionOS 26+. Not on watchOS.** *(Released 2025; treat any nuance below as verify-against-current-SDK.)*

### Architecture

- **`SpeechAnalyzer`** — the session/engine. You hand it audio and one or more analysis **modules**; it coordinates them.
- **Modules** (pick what you need):
  - **`SpeechTranscriber`** — long-form transcription (the main one for video audio).
  - **`DictationTranscriber`** — short-utterance / command-style; the closest equivalent to old `SFSpeechRecognizer` behavior.
  - **`SpeechDetector`** — voice-activity detection; must be paired with a transcriber.
- Results arrive as an **async stream** of attributed-text segments, each carrying timing and a `isFinal` (stable) vs volatile (interim) flag.

### Transcribing a video's audio file

```swift
import Speech
import AVFoundation

@available(macOS 26.0, iOS 26.0, *)
func transcribe(fileURL: URL, locale: Locale) async throws -> String {
    // 1. Build the transcriber module.
    let transcriber = SpeechTranscriber(
        locale: locale,
        transcriptionOptions: [],
        reportingOptions: [],            // [.volatileResults] for live interim text
        attributeOptions: [.audioTimeRange]   // per-segment timestamps
    )

    // 2. Make sure the language model is installed (see "Model management").
    try await ensureModel(for: transcriber, locale: locale)

    // 3. Create the analyzer with the module(s).
    let analyzer = SpeechAnalyzer(modules: [transcriber])

    // 4. Consume results concurrently while we feed audio.
    let resultTask = Task {
        var full = ""
        for try await result in transcriber.results {
            // result.text is AttributedString; concatenate finalized segments.
            full += String(result.text.characters)
        }
        return full
    }

    // 5. Feed the file and finish.
    let file = try AVAudioFile(forReading: fileURL)
    if let lastSample = try await analyzer.analyzeSequence(from: file) {
        try await analyzer.finalizeAndFinish(through: lastSample)
    } else {
        try await analyzer.finalizeAndFinishThroughEndOfInput()
    }

    return try await resultTask.value
}
```

Notes:
- `analyzeSequence(from:)` accepts an `AVAudioFile` and drives the whole file through — ideal for batch transcription of a video's extracted audio track.
- `SpeechTranscriber` may require the audio in a specific format/sample rate. Query `transcriber.audioFormat` (the analyzer's best available format) and convert with `AVAudioConverter` if your file doesn't match. *(Flag: confirm exact property name against current SDK.)*
- Each result segment, with `.audioTimeRange` requested, carries a `CMTimeRange` — use it to build timestamped captions or align keywords to moments in the video.

### Live dictation / streaming input

For real-time mic input, feed an `AsyncStream` of audio buffers instead of a file:

```swift
let (inputSequence, inputBuilder) = AsyncStream<AnalyzerInput>.makeStream()
try await analyzer.start(inputSequence: inputSequence)

// From your AVAudioEngine tap, for each captured buffer:
inputBuilder.yield(AnalyzerInput(buffer: pcmBuffer))

// Read interim + final results:
for try await result in transcriber.results {
    if result.isFinal { /* stable text */ }
    else { /* volatile/interim text — update UI live */ }
}

// When done:
inputBuilder.finish()
try await analyzer.finalizeAndFinishThroughEndOfInput()
```

Enable interim updates with `reportingOptions: [.volatileResults]` so the UI can show text as the user speaks.

### Model management (download language assets)

The on-device language models are downloaded on demand, not bundled.

```swift
// What can this device transcribe, and what's already installed?
let supported = await SpeechTranscriber.supportedLocales
let installed = await SpeechTranscriber.installedLocales

func ensureModel(for module: SpeechTranscriber, locale: Locale) async throws {
    // Request installation of assets needed by the module(s).
    if let request = try await AssetInventory.assetInstallationRequest(supporting: [module]) {
        try await request.downloadAndInstall()
    }
}
```

- Models are shared system assets (managed via `AssetInventory`), so they don't bloat the app and are reused across apps.
- You may need to **reserve** a locale (`AssetInventory.reserve(locale:)`) to keep its model available; there's a cap on simultaneously reserved locales. *(Flag: verify reservation API + limits against current SDK.)*
- Check `supportedLocales` before offering a language; not every system locale is supported.

### Languages

Supports a growing set of locales (English, Spanish, French, German, Italian, Portuguese, Japanese, Korean, Chinese, and more — roughly the dictation-supported languages). `SpeechTranscriber.supportedLocales` is the source of truth at runtime. Language is selected per `SpeechTranscriber(locale:)`; automatic management handles model loading.

## Legacy API: `SFSpeechRecognizer`

Available since iOS 10 / macOS 10.15. Use when you must support **macOS/iOS < 26**. On-device recognition requires iOS 13+ / macOS 10.15+ and a supported locale.

```swift
import Speech

func transcribeLegacy(fileURL: URL) async throws -> String {
    let recognizer = SFSpeechRecognizer(locale: Locale(identifier: "en-US"))!
    guard recognizer.supportsOnDeviceRecognition else {
        throw NSError(domain: "Speech", code: -1)  // would otherwise hit the network
    }

    let request = SFSpeechURLRecognitionRequest(url: fileURL)
    request.requiresOnDeviceRecognition = true        // keep audio on device
    request.shouldReportPartialResults = false        // final transcript only

    return try await withCheckedThrowingContinuation { cont in
        recognizer.recognitionTask(with: request) { result, error in
            if let error { cont.resume(throwing: error); return }
            if let result, result.isFinal {
                cont.resume(returning: result.bestTranscription.formattedString)
            }
        }
    }
}
```

Permissions and limits:
- Call `SFSpeechRecognizer.requestAuthorization(_:)` and add **`NSSpeechRecognitionUsageDescription`** to Info.plist.
- For mic input, use `SFSpeechAudioBufferRecognitionRequest` and append `AVAudioPCMBuffer`s.
- **Known limits:** server-based (non-on-device) recognition historically caps audio at ~1 minute and is rate-limited per device per day. `requiresOnDeviceRecognition = true` avoids both but on-device accuracy is lower than the cloud path and noticeably lower than the new `SpeechTranscriber`. Long files are clunky with this API — it was designed for short utterances.

## Choosing for Rainy

| Need | Use |
|---|---|
| Transcribe full video audio (minutes to hours), on-device, accurate, with timestamps | `SpeechAnalyzer` + `SpeechTranscriber` (iOS/macOS 26) |
| Live dictation / mic with interim results | `SpeechAnalyzer` + `SpeechTranscriber` (`.volatileResults`) or `DictationTranscriber` |
| Voice-activity gating before transcribing | add `SpeechDetector` module |
| Support macOS/iOS older than 26 | `SFSpeechRecognizer` with `requiresOnDeviceRecognition = true` |

Recommendation: build on `SpeechAnalyzer`/`SpeechTranscriber` and branch to `SFSpeechRecognizer` only behind an `if #available(macOS 26, *)` check for older OS support. Both keep audio on-device — appropriate for creators' unreleased footage.

## Accuracy & limits notes

- New `SpeechTranscriber`: Apple reports ~2× faster than Whisper Large v3 Turbo, tuned for long-form and far-field/multi-speaker audio. Still no built-in **speaker diarization** (who-said-what) — you'd add that separately. *(Flag: verify diarization status against current SDK.)*
- Quality depends on clean audio. For video, extract the audio track (`AVAssetExportSession`/`AVAssetReader`) and downmix to mono if needed.
- First use of a new locale incurs a model download — handle the "downloading…" state in UI.
- All transcription here is **on-device**: no Anthropic/cloud calls, no per-minute cost, works offline.

## Sources

- Bring advanced speech-to-text to your app with SpeechAnalyzer — WWDC25: https://developer.apple.com/videos/play/wwdc2025/277/
- Bringing advanced speech-to-text capabilities to your app — Apple Developer Documentation: https://developer.apple.com/documentation/Speech/bringing-advanced-speech-to-text-capabilities-to-your-app
- SFSpeechRecognizer — Apple Developer Documentation: https://developer.apple.com/documentation/speech/sfspeechrecognizer
- WWDC25: The Next Evolution of Speech-to-Text using SpeechAnalyzer (arshtechpro, DEV): https://dev.to/arshtechpro/wwdc-2025-the-next-evolution-of-speech-to-text-using-speechanalyzer-6lo
- Apple's New Speech Framework: SpeechAnalyzer vs SFSpeechRecognizer (Blake Crosley): https://blakecrosley.com/blog/speech-framework-vs-sfspeechrecognizer
- On-Device Speech Transcription with Apple SpeechAnalyzer (Callstack): https://www.callstack.com/blog/on-device-speech-transcription-with-apple-speechanalyzer
- Hands-On: How Apple's New Speech APIs Outpace Whisper (MacStories): https://www.macstories.net/stories/hands-on-how-apples-new-speech-apis-outpace-whisper-for-lightning-fast-transcription/
