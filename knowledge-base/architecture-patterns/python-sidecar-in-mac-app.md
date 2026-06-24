# Python (FastMCP) Sidecar in a Mac App

_Last updated: 2026-06-24_

How to ship and run a Python FastMCP server as a stdio sidecar inside Rainy, a native macOS SwiftUI app (target macOS 27, Apple Silicon + Intel).

## TL;DR / Recommendation

**Bundle a relocatable standalone CPython (Astral's `python-build-standalone`, managed via `uv`) inside `Contents/Resources/`, pre-populate a venv with FastMCP + deps, launch it from Swift via `Process` over stdio pipes, and sign every nested binary with your Developer ID + hardened runtime + `--timestamp --options runtime`, then notarize with `notarytool` and staple.**

- **Distribution channel:** **Developer ID (direct)** is the realistic baseline. Mac App Store is *possible* but adds sandbox + Library Validation work and review risk — treat as a stretch goal.
- **Why standalone CPython over PyInstaller/Nuitka:** it is a real, relocatable interpreter + full stdlib (the same artifact `uv`/Mise/`rules_python` ship), without PyInstaller's onefile self-extraction that recurrently trips notarization ("no cdhash / completely unsigned", JIT-memory failures).
- **Do NOT rely on system Python.** macOS removed a usable `/usr/bin/python` in 12.3; the Xcode CLT Python is not on user machines, version is unpredictable, and you cannot sign/notarize code you do not own. Non-starter.

## 1. Bundling options for the Python runtime

| Option | What it is | Verdict |
|---|---|---|
| **`uv` + python-build-standalone** | Pre-built relocatable CPython tarballs fetched by `uv python install`; copy into `Contents/Resources`, install deps into a co-located venv. Real interpreter + full stdlib, you control the exact version, ~40–80 MB. Must fix some install names (`install_name_tool`) and sign each `.dylib`/`.so`. | **RECOMMENDED** |
| **Embedded Python.framework / BeeWare `Python-Apple-support`** | Framework-form CPython (`Python.xcframework`) in `Contents/Frameworks`, bundled venv. Framework layout is what codesign expects; proven through MAS (PythonKit + xcframework). ~100 MB. | Strong alternative, esp. if you also want in-process embedding via PythonKit. |
| **PyInstaller (onefile / onedir)** | Freezes app + interpreter. onefile self-extracts at runtime → JIT/unsigned-memory + notarization grief and "no cdhash" issues. onedir is better but fiddly. | Workable but more notarization pain. Avoid onefile. |
| **Nuitka** | Compiles Python to C. Smaller/faster startup but compilation complexity, still nested binaries to sign, less battle-tested for MCP packaging. | Niche; only if startup/size is critical. |
| **System Python** | Whatever is on the box. | **Do not use** — not present, unsignable, version chaos. |

### Building the standalone runtime with `uv`

```bash
# Pin and install a standalone CPython into the project
uv python install --managed-python 3.13

# Relocatable venv that uses copies (not symlinks) so it's bundle-safe
uv venv --relocatable --python 3.13 ./PythonRuntime/venv
uv pip install --python ./PythonRuntime/venv fastmcp <your deps>
```

The interpreter lives under `~/.local/share/uv/python/cpython-3.13.*-macos-aarch64-none/`. Copy that tree into the app, or use **`py-app-standalone`** (`uvx py-app-standalone <pkg>`) which automates the macOS relocation fixups: rewrites shebangs, runs `install_name_tool -id @executable_path/../lib/libpython3.13.dylib ...`, patches `_sysconfigdata__darwin_darwin.py`, and precompiles `.pyc`. Note: `py-app-standalone` does **not** sign/notarize — that is on you (§5).

Target bundle layout:

```
Rainy.app/Contents/
  MacOS/Rainy                         (Swift binary)
  Resources/python/                   (standalone CPython tree)
    bin/python3.13
    lib/libpython3.13.dylib
    lib/python3.13/...                (stdlib + site-packages/venv with FastMCP)
```

## 2. How `uv` + python-build-standalone work; signability

- `uv` does not build from source — it downloads pre-built CPython from `astral-sh/python-build-standalone` (same distributions Mise and `rules_python` use). Self-contained, portable, performant.
- **Relocatability:** designed to be relocatable, but on macOS `libpython*.dylib` and config files carry build-time absolute paths/install names. Fix with `install_name_tool` (IDs and `@executable_path`/`@rpath`) and by patching `_sysconfigdata`. Create venvs with `--relocatable` and copies, not symlinks.
- **Signing state:** downloaded builds are **not** signed with your identity and stdlib `.so` are not Team-ID signed. You **must re-sign every nested binary** before notarizing. There is no inherent blocker — they are ordinary Mach-O — but there are *many* of them (§5 pitfall #1).

> ⚠️ **Uncertain — verify at build time:** universal2 (arm64+x86_64) coverage. python-build-standalone historically shipped per-arch builds (issue #140). For Intel + Apple Silicon you likely ship two arch builds or merge wheels with `delocate-fuse`. Confirm current universal2 availability for your pinned version.

## 3. Launching & supervising the Python process from Swift

Use `Process` (NSTask) with explicit `executableURL`, args, environment, and three `Pipe`s. For MCP **stdio** transport: write JSON-RPC frames to the child's **stdin**, read responses from **stdout**, keep **stderr** separate for logs. **Never mix stderr into the stdio JSON stream** — it corrupts the transport.

```swift
import Foundation

final class PythonSidecar {
    private var process: Process?
    private let stdinPipe = Pipe()
    private let stdoutPipe = Pipe()
    private let stderrPipe = Pipe()

    private var pythonURL: URL {
        Bundle.main.resourceURL!.appendingPathComponent("python/bin/python3.13")
    }
    private var serverScriptURL: URL {
        Bundle.main.resourceURL!
            .appendingPathComponent("python/lib/python3.13/site-packages/myserver/__main__.py")
    }

    func start() throws {
        let proc = Process()
        proc.executableURL = pythonURL
        proc.arguments = [serverScriptURL.path]      // or ["-m", "myserver"]

        // Hermetic env: point Python at the bundled tree, no user site, unbuffered IO.
        var env = ProcessInfo.processInfo.environment
        let home = Bundle.main.resourceURL!.appendingPathComponent("python").path
        env["PYTHONHOME"] = home
        env["PYTHONNOUSERSITE"] = "1"
        env["PYTHONDONTWRITEBYTECODE"] = "1"
        env["PYTHONUNBUFFERED"] = "1"
        env["PATH"] = "\(home)/bin:/usr/bin:/bin"
        proc.environment = env

        proc.standardInput  = stdinPipe
        proc.standardOutput = stdoutPipe
        proc.standardError  = stderrPipe

        stdoutPipe.fileHandleForReading.readabilityHandler = { [weak self] h in
            let data = h.availableData
            guard !data.isEmpty else { return }
            self?.handleServerOutput(data)           // buffer + parse newline-delimited JSON-RPC
        }
        stderrPipe.fileHandleForReading.readabilityHandler = { h in
            let d = h.availableData
            if !d.isEmpty, let s = String(data: d, encoding: .utf8) { NSLog("[python] %@", s) }
        }

        proc.terminationHandler = { [weak self] p in
            NSLog("sidecar exited: status=\(p.terminationStatus) reason=\(p.terminationReason.rawValue)")
            self?.scheduleRelaunchIfNeeded(status: p.terminationStatus)
        }

        try proc.run()
        self.process = proc
    }

    func send(_ data: Data) { stdinPipe.fileHandleForWriting.write(data) } // append MCP framing/newline
    private func handleServerOutput(_ data: Data) { /* accumulate partial frames, parse JSON-RPC */ }
    private func scheduleRelaunchIfNeeded(status: Int32) { /* bounded exponential backoff */ }

    func stop() {
        stdoutPipe.fileHandleForReading.readabilityHandler = nil
        stderrPipe.fileHandleForReading.readabilityHandler = nil
        process?.terminate()                          // SIGTERM; escalate to kill if needed
    }
}
```

Supervision notes:
- **Termination:** use `terminationHandler` (status + reason) with bounded exponential-backoff relaunch; stop on repeated fast crashes (crash-loop guard).
- **Clean shutdown:** call `stop()` on app termination so you do not orphan the child. `terminate()` sends SIGTERM; trap it in the server for graceful MCP shutdown.
- **Backpressure:** `readabilityHandler` is fine for moderate volume; for high throughput move to a `DispatchIO` read loop with a frame-accumulating parser.
- Set `PYTHONHOME` to the bundled tree so the relocated interpreter finds its stdlib regardless of cwd.

## 4. App Sandbox implications

A sandboxed app **can** spawn an executable **inside its own bundle**; the child inherits the parent's sandbox (proven by BeeWare/Briefcase MAS apps). Constraints:
- Child must be inside the bundle and signed by the **same Team ID** (Library Validation).
- A spawned bundled binary inherits the sandbox automatically; you generally do not need `com.apple.security.inherit` unless using XPC-style helpers.

Entitlements that may be required:

| Entitlement | When needed |
|---|---|
| `com.apple.security.app-sandbox` | MAS (mandatory). Omit for Developer ID. |
| `com.apple.security.cs.allow-unsigned-executable-memory` | If any dep uses **ctypes/cffi** (e.g. `cryptography`) under Hardened Runtime. **Very common** with real Python deps. |
| `com.apple.security.cs.allow-jit` | Only if you actually allocate JIT/W^X memory (rare for MCP servers). Prefer **not** to add it. |
| `com.apple.security.cs.disable-library-validation` | If nested `.so`/`.dylib` are ad-hoc or signed by a different identity. **Avoid** by signing everything with your Team ID. |
| `com.apple.security.cs.allow-dyld-environment-variables` | If you must set `DYLD_*` (better: fix install names instead). |
| `com.apple.security.network.{server,client}` | Sandbox + networking. stdio MCP needs none; your tools might. |

**Tradeoff:** non-sandbox (Developer ID) is dramatically easier — often just Hardened Runtime + `allow-unsigned-executable-memory`. Sandbox (MAS) forces Team-ID signing of every nested binary (keep Library Validation on), file/network entitlements for what tools touch, plus App Review.

## 5. Code signing & notarization of the embedded runtime

A standalone CPython has **dozens of `.so` extension modules + `libpython*.dylib` + the `python3` executable**; the notary checks every Mach-O.

Rules:
- **Sign inside-out** (nested binaries first, app last). `--deep` is officially discouraged; in practice most working pipelines do a **per-file `codesign` loop** then sign the bundle.
- **Hardened Runtime mandatory** for notarization → `--options runtime`. **Secure timestamp mandatory** → `--timestamp`.
- Every nested binary must carry a cdhash + Team ID, else notary rejects.

Per-file signing loop:

```bash
APP="dist/Rainy.app"
ID="Developer ID Application: Your Name (TEAMID)"
ENT="entitlements.plist"

find "$APP/Contents/Resources/python" \
     \( -name "*.so" -o -name "*.dylib" -o -perm -u+x -type f \) -print0 |
while IFS= read -r -d '' f; do
  if file "$f" | grep -q Mach-O; then
    codesign --force --timestamp --options runtime \
             --entitlements "$ENT" --sign "$ID" "$f"
  fi
done

codesign --force --timestamp --options runtime \
         --entitlements "$ENT" --sign "$ID" "$APP"

codesign --verify --deep --strict --verbose=2 "$APP"
spctl --assess --type execute -vvv "$APP"      # expect: source=Notarized Developer ID
```

Developer ID `entitlements.plist` baseline (survives Python ctypes/cffi):

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
 "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>com.apple.security.cs.allow-unsigned-executable-memory</key><true/>
  <!-- add only if proven necessary:
  <key>com.apple.security.cs.disable-library-validation</key><true/>
  <key>com.apple.security.cs.allow-jit</key><true/>
  -->
</dict></plist>
```

Notarize + staple (use `notarytool`, not deprecated `altool`):

```bash
xcrun notarytool store-credentials "AC_NOTARY" \
  --apple-id "adrian@avlana.co" --team-id TEAMID --password "app-specific-pw"

# ditto preserves CPython's symlinks; plain `zip` corrupts them
ditto -c -k --sequesterRsrc --keepParent "$APP" Rainy.zip

xcrun notarytool submit Rainy.zip --keychain-profile "AC_NOTARY" --wait
xcrun notarytool log <submission-id> --keychain-profile "AC_NOTARY"   # on failure

xcrun stapler staple "$APP"      # staple the .app, not the zip
```

Common pitfalls (all confirmed in sources):
1. **Unsigned nested binary** (esp. `bin/python3` in `Resources/`) → notary rejects. Use the loop above.
2. **Ad-hoc signed `.so`** ("Sign to Run Locally") → fails unless you disable library validation. Re-sign with Team ID instead.
3. **`zip` corrupting symlinks** → use `ditto -c -k --sequesterRsrc --keepParent`.
4. **Hardened Runtime vs ctypes/cffi** → add `allow-unsigned-executable-memory` (`cryptography` pulls in cffi).
5. **PyInstaller onefile** → bootloader extraction & "no cdhash" → prefer standalone CPython.
6. **Unused extension modules** (`_tkinter`/Tcl) caused a real MAS rejection over deprecated/private API — **delete modules you don't use**.
7. Sign **inside-out** — signing the app before nested binaries invalidates the outer signature.

## 6. Developer ID vs Mac App Store

**Developer ID (direct) — RECOMMENDED.** No sandbox required. Hardened Runtime + notarization + the per-file signing loop suffices. May use `allow-unsigned-executable-memory` freely. Spawning your bundled interpreter is unrestricted.

**Mac App Store — possible but constrained.**
- **Guideline 2.5.2:** apps may not download/install/execute code — **BUT** "interpreted code may be used if all scripts, code, and interpreters are packaged in the Application and not downloaded." A fully bundled interpreter running bundled server code is **permitted**; runtime `pip install`/fetching code is **not**.
- Must be sandboxed, must keep Library Validation on → sign every nested binary with your Team ID (no ad-hoc, no `disable-library-validation`).
- Real rejections happen over private/deprecated APIs in stdlib extension modules — strip unused `.so`.
- Proven (PythonKit + `Python.xcframework` shipped to MAS), but review is judgment-heavy and an MCP "sidecar that runs arbitrary tools" may read like a code-execution engine. Expect scrutiny.

**Verdict:** Ship Developer ID first. Pursue MAS only if a business requirement demands it.

## Flagged uncertain / beta items
- **universal2 availability** for your pinned python-build-standalone version (issue #140) — verify at build; may need two arch builds or `delocate-fuse`.
- **macOS 27 specifics:** guidance is continuous with macOS 12–15; no macOS-27-specific notarization changes surfaced. Re-confirm Hardened Runtime entitlement names at ship time.
- **MCP/FastMCP churn:** pin versions. `fastmcp install stdio` emits `uv run` strings — useful reference, but the shipped app launches the interpreter directly from Swift.
- **`py-app-standalone`** is explicitly experimental and does no signing.

## Sources
- https://blog.glyph.im/2023/03/py-mac-app-for-real.html
- https://haim.dev/posts/2020-08-08-python-macos-app
- https://github.com/jlevy/py-app-standalone
- https://docs.astral.sh/uv/concepts/python-versions/
- https://gregoryszorc.com/docs/python-build-standalone/main/quirks.html
- https://medium.com/swift2go/embedding-python-interpreter-inside-a-macos-app-and-publish-to-app-store-successfully-309be9fb96a5
- https://github.com/r0ml/Caerbannog
- https://developer.apple.com/forums/thread/758567
- https://github.com/beeware/briefcase/issues/513
- https://briefcase.beeware.org/en/stable/reference/platforms/macOS/
- https://www.macstories.net/linked/apples-app-store-guidelines-now-allow-executable-code-in-educational-apps-and-developer-tools/
- https://github.com/PrefectHQ/fastmcp
- https://modelcontextprotocol.io/docs/develop/build-server
- https://www.outflank.nl/blog/2026/02/19/macos-jit-memory/
