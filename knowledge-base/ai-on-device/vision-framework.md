# Vision Framework

_Last updated: 2026-06-24_

Practical reference for using Apple's **Vision** framework in Rainy to analyze creator thumbnails and video frames: reading text overlays (OCR), classifying image content, finding the focal subject (saliency), detecting faces, and detecting objects/animals.

## TL;DR for Rainy

- **OCR on thumbnails** → `RecognizeTextRequest` (modern Swift API). For dense/structured text (lists, tables, multi-column), `RecognizeDocumentsRequest` (new in 2025).
- **Focal subject** → `GenerateAttentionBasedSaliencyImageRequest` (where the eye is drawn) or `GenerateObjectnessBasedSaliencyImageRequest` (foreground objects).
- **Faces** → `DetectFaceRectanglesRequest`, plus `DetectFaceLandmarksRequest` for eyes/mouth/pose.
- **Scene/content labels** → `ClassifyImageRequest`.
- **Similarity / dedup** → `GenerateImageFeaturePrintRequest`.
- Same request objects run on **still images (thumbnails)** and **video frames (`CVPixelBuffer`)** with no API changes.

## Two API generations (important)

Vision has two parallel APIs. **Use the modern Swift API for new code.**

1. **Modern Swift API** (iOS 18 / macOS 15, Aqua 26 in 2025+): value-type request structs like `RecognizeTextRequest`, async `perform(on:)`, typed observations (`RecognizedTextObservation`). Built for Swift Concurrency / Swift 6. Introduced WWDC24 ("Discover Swift enhancements in the Vision framework").
2. **Legacy API** (iOS 11+): class-based `VNRecognizeTextRequest`, `VNImageRequestHandler`, completion handlers, `request.results as? [VNRecognizedTextObservation]`. Still supported; needed if you must deploy below iOS 18 / macOS 15.

> Below, all primary samples use the **modern** API. A legacy fallback is shown at the end.

## OCR / Text recognition — `RecognizeTextRequest`

Core use case: reading text overlays baked into a thumbnail.

```swift
import Vision

func recognizeText(in image: CGImage) async throws -> [String] {
    var request = RecognizeTextRequest()
    request.recognitionLevel = .accurate          // .accurate (neural) vs .fast
    request.usesLanguageCorrection = true         // helps real words, can hurt brand/slang
    request.recognitionLanguages = [Locale.Language(identifier: "en-US")]
    // Optional: request.minimumTextHeightFraction = 0.02  // skip tiny noise

    // perform(on:) is async and returns typed observations directly — no handler needed.
    let observations: [RecognizedTextObservation] = try await request.perform(on: image)

    return observations.compactMap { obs in
        // topCandidates(_:) returns ranked candidates; .string is the text,
        // .confidence is 0...1. You can also ask the candidate for its bounding box.
        obs.topCandidates(1).first?.string
    }
}
```

Key points for Rainy:
- **Location of each line:** `RecognizedTextObservation` has a normalized `boundingBox`. To get the precise box of a substring, use `candidate.boundingBox(for: range)` on a `RecognizedText` candidate. Useful for "is the headline text in the top third?"
- **`.accurate`** is the right default for thumbnails (stylized fonts, gradients). `.fast` only for high-volume frame sweeps where you can tolerate misses.
- **`usesLanguageCorrection`**: turn **off** when reading short stylized titles, handles, hashtags, or numbers (e.g. "$5000", "iPhone16") where correction mangles tokens.
- `recognitionLevel` and `recognitionLanguages` exist on both API generations.

### Structured documents — `RecognizeDocumentsRequest` (new, 2025)

Introduced WWDC25 ("Read documents using the Vision framework"). Parses **structure**, not just raw lines: groups text into paragraphs, and detects tables (cells grouped into rows), lists, and data detectors (phone numbers, URLs, emails). Recognizes ~26 languages.

```swift
let request = RecognizeDocumentsRequest()
let observations = try await request.perform(on: image)
// Returns a DocumentObservation exposing .document with paragraphs, lists, tables, etc.
```

For Rainy this is mostly relevant if a thumbnail/frame contains a list or tabular overlay; for plain title text, `RecognizeTextRequest` is simpler and faster. *(Flag: exact result-type accessors for `RecognizeDocumentsRequest` are still settling — verify against the WWDC25 session and current SDK headers.)*

## Image classification — `ClassifyImageRequest`

Returns scene/content labels for an image (e.g. "outdoor", "food", "person"). Good for tagging what a thumbnail depicts.

```swift
let request = ClassifyImageRequest()
let observations = try await request.perform(on: image)  // [ClassificationObservation]

let labels = observations
    .filter { $0.confidence > 0.1 }
    .map { ($0.identifier, $0.confidence) }   // identifier: String, confidence: 0...1
```

- `ClassificationObservation` exposes `identifier` (label) and `confidence` (0.0–1.0).
- The legacy `VNClassifyImageRequest` exposed `hasMinimumRecall(_:forIdentifier:)` / `hasMinimumPrecision(_:forIdentifier:)` helpers to threshold by a target precision/recall — useful when you want a tuned cutoff rather than a raw confidence number. *(Flag: confirm whether equivalent helpers are surfaced on the modern `ClassificationObservation` in your target SDK.)*
- **Not available in the iOS Simulator** (throws an "espresso context" error) — test classification/feature-print/saliency on a real device.

## Saliency / focal subject

Two requests, both returning a `SaliencyImageObservation` containing a low-res heat map plus salient bounding regions:

- **`GenerateAttentionBasedSaliencyImageRequest`** — models *where a human eye is drawn* (attention). Best for "what's the focal point of this thumbnail?"
- **`GenerateObjectnessBasedSaliencyImageRequest`** — highlights *foreground objects* vs background. Best for "find the main subject to crop around."

```swift
let request = GenerateAttentionBasedSaliencyImageRequest()
let observation = try await request.perform(on: image)   // SaliencyImageObservation

// Salient regions as normalized bounding boxes (origin lower-left):
let regions = observation.salientObjects   // [normalized rects]
// observation also exposes the raw heat-map pixel buffer for overlay/visualization.
```

Rainy uses: detect whether the focal subject is centered/off-center, auto-crop to the attention region, or score "visual clarity" of a thumbnail.

## Face detection

```swift
// Rectangles only (fast) — counts faces, finds their boxes.
let faceRequest = DetectFaceRectanglesRequest()
let faces = try await faceRequest.perform(on: image, orientation: .downMirrored)
// [FaceObservation]; each has .boundingBox (normalized) and .confidence (0...1)

let faceRects = faces
    .filter { $0.confidence > 0.7 }
    .map { $0.boundingBox.cgRect }
```

- **`DetectFaceRectanglesRequest`** → `FaceObservation` with `boundingBox` (normalized) and `confidence`. The newer `FaceObservation` also surfaces pose (`roll`, `yaw`, `pitch`) and a `calculateFaceCaptureQuality`-style quality signal.
- **`DetectFaceLandmarksRequest`** → adds landmark geometry (eyes, nose, mouth, contour) for expression/eye-line analysis. Heavier; run only when you need detail.
- **Coordinate system gotcha:** Vision's origin is **lower-left**, normalized 0–1. SwiftUI/UIKit are upper-left. Multiply by image size and flip Y, or pass `orientation: .downMirrored` to align with a top-left system (as above).

## Object / animal detection

- **`DetectAnimalsRequest`** (legacy `VNRecognizeAnimalsRequest`) → recognizes cats and dogs with bounding boxes; returns `RecognizedObjectObservation`-style results with labels + confidence. Useful for pet-content thumbnails.
- **General object detection / human body** → `DetectHumanRectanglesRequest` (people boxes), `DetectHumanBodyPoseRequest` (skeleton). For arbitrary object categories beyond animals/people, Vision does **not** ship a general object detector — use a **Core ML** model (e.g. a YOLO/`MLModel`) wrapped in a `CoreMLRequest` / legacy `VNCoreMLRequest`.
- **Feature prints** — `GenerateImageFeaturePrintRequest` returns a `FeaturePrintObservation` you can compare with `computeDistance(_:to:)` to measure image similarity. Good for de-duplicating near-identical frames or clustering thumbnails by visual style.

## Running on still images vs. video frames

The request objects are identical; only the **input** differs. With the modern API, `perform(on:)` accepts many input types (a `CGImage`, `CIImage`, `CVPixelBuffer`, `CMSampleBuffer`, URL, `Data`, etc.).

```swift
// Thumbnail (still image)
let observations = try await request.perform(on: cgImage)

// Video frame from AVFoundation (CVPixelBuffer / CMSampleBuffer)
let frameObservations = try await request.perform(on: pixelBuffer, orientation: .up)
```

Frame-sweep guidance for Rainy:
- Extract frames with `AVAssetImageGenerator` (precise timestamps) or pull buffers via `AVAssetReader` for throughput.
- **Don't OCR every frame.** Sample (e.g. 1–2 fps) or run cheap saliency/classification first and only OCR frames likely to hold text.
- Reuse a single request struct across frames; create one `Task`/actor and run requests with `async let` to parallelize, but cap concurrency to avoid memory spikes on long videos.
- Vision is **fully on-device** — no network, no per-call cost — so it's safe to run at volume; the limiter is CPU/Neural Engine time.

## Legacy fallback (deploy below iOS 18 / macOS 15)

```swift
import Vision

let request = VNRecognizeTextRequest { req, error in
    guard let results = req.results as? [VNRecognizedTextObservation] else { return }
    let lines = results.compactMap { $0.topCandidates(1).first?.string }
    // ... use lines
}
request.recognitionLevel = .accurate
request.usesLanguageCorrection = true

let handler = VNImageRequestHandler(cgImage: cgImage, options: [:])
try handler.perform([request])
```

The same `VNImageRequestHandler(cvPixelBuffer:)` initializer handles video frames in the legacy API.

## Availability summary

| Request | Min OS (modern Swift API) |
|---|---|
| `RecognizeTextRequest`, `ClassifyImageRequest`, `DetectFaceRectanglesRequest`, saliency, feature print | iOS 18 / macOS 15 (Xcode 16+) |
| `RecognizeDocumentsRequest`, `DetectCameraLensSmudgeRequest` | iOS 26 / macOS 26 (WWDC25) — *beta-era, verify* |
| Legacy `VN*` equivalents | iOS 11–13+ depending on request |

Notes / flags:
- Modern Vision classification, saliency, and feature-print requests **do not run in the iOS Simulator** — test on device.
- 2025/2026 request names and result accessors (especially `RecognizeDocumentsRequest`) may still shift; confirm against the installed SDK headers before shipping.

## Sources

- Discover Swift enhancements in the Vision framework — WWDC24: https://developer.apple.com/videos/play/wwdc2024/10163/
- Read documents using the Vision framework — WWDC25: https://developer.apple.com/videos/play/wwdc2025/272/
- RecognizeTextRequest — Apple Developer Documentation: https://developer.apple.com/documentation/vision/recognizetextrequest
- Vision — Apple Developer Documentation: https://developer.apple.com/documentation/vision
- Locating and displaying recognized text — Apple Developer: https://developer.apple.com/documentation/Vision/locating-and-displaying-recognized-text
- Detecting text in images with the Vision framework (Daniel Saidi, 2026): https://danielsaidi.com/blog/2026/01/10/detecting-text-in-images-with-the-vision-framework
- Classifying image content with the Vision framework (Create with Swift): https://www.createwithswift.com/classifying-image-content-with-the-vision-framework/
- Detecting faces in images with the Vision framework (Create with Swift): https://www.createwithswift.com/detecting-faces-in-images-with-the-vision-framework/
- iOS Vision Framework — Swift API Enhancements from WWDC24 (ZhgChgLi): https://en.zhgchg.li/posts/kkday-tech-blog/ios-vision-framework-explore-swift-api-enhancements-from-wwdc-24-session-755509180ca8/
