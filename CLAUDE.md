@AGENTS.md

# windsurf-commander-ultra

Expo SDK 57 iOS app. Standing constraint, always: **working on this repo (`windsurf-commander-ultra`) and its linked package `commander-core`. Never touch `windsurf-native`** (a separate, read-only production app at `/Users/robwilson/Downloads/files-claude-download/windsurf-native`) under any circumstances, even if the working directory environment context points there.

## Repo structure

- `windsurf-commander-ultra` — the Expo app (screens, services, native modules).
- `commander-core` — shared package, linked via `file:../commander-core` in `package.json`. Holds data repositories, the AI/prompt pipeline, auth. Import as `@commandersuite/core`.
- JS-only changes to `commander-core` are picked up live by Metro — no native rebuild needed, just redeploy the app bundle (see below).
- Device: `00008130-00164CE80AFA001C`, bundle id `com.anonymous.windsurf-commander-ultra`.

## Native rebuild — after a macOS/Xcode update

If `npx expo run:ios` fails or the app crashes on launch after a macOS
upgrade, check for these in order — all three were real, all three hit
in the same session after a macOS Darwin 25→27 jump:

1. **`node: Bad CPU type in executable`** — `node` on PATH resolves to a
   stale x86_64 install (`/usr/local/bin`, old Intel Homebrew prefix)
   with no Rosetta to run it. Fix: `brew install node` (arm64 Homebrew,
   `/opt/homebrew`), not `softwareupdate --install-rosetta`. Xcode's build
   phases don't inherit your interactive shell's PATH, so `command -v
   node` inside a build script can still resolve to the wrong binary even
   after your shell is fixed — set `ios/.xcode.env.local` explicitly:
   `export NODE_BINARY=/opt/homebrew/bin/node` (not `$(command -v node)`).
2. **Provisioning profile / code signature errors** on `xcrun devicectl
   device process launch` — needs a manual on-device step: **Settings →
   General → VPN & Device Management → [developer profile] → Trust**.
   Can't be done from the CLI.
3. **`EXC_BREAKPOINT` in `___UIApplicationEvaluateRuntimeIssueForNoSceneLifecycleAdoption_block_invoke`
   crash on launch**, only on a very new iOS version (27+ as of this
   writing) — that iOS version hard-crashes any app with no `UIScene`
   lifecycle adoption at all (previously just a warning). An Expo SDK
   patch bump alone does **not** fix this if the app predates it. Real
   fix, already shipped by Expo (`node_modules/expo/ios/AppDelegates/
   ExpoAppSceneDelegate.swift`) but not wired into an already-generated
   `ios/` project:
   - `AppDelegate.swift`: add `ExpoReactNativeFactoryProvider` conformance
     to the class declaration (the existing `window`/`reactNativeFactory`
     properties already satisfy it), add `application(_:
     configurationForConnecting:options:)` (no `override` — `ExpoAppDelegate`
     doesn't implement it, this is fresh protocol conformance) returning
     `UISceneConfiguration(...).delegateClass = ExpoAppSceneDelegate.self`.
   - Remove the manual `window = UIWindow(...); factory.startReactNative(...)`
     call from `didFinishLaunchingWithOptions` — the scene delegate now
     owns window creation; leaving both starts React Native twice.
   - Add `UIApplicationSceneManifest` / `UIApplicationSupportsMultipleScenes:
     false` to `app.json`'s `ios.infoPlist` (for the next real `prebuild`)
     **and** directly to `ios/windsurfcommanderultra/Info.plist` via
     `PlistBuddy` (a plain `expo run:ios` does not re-sync `infoPlist`
     from `app.json` — that only happens on an actual `prebuild`, and
     `prebuild --clean` is what we're trying to avoid — see below).
   - After any pod-affecting change (Expo/RN version bump, Podfile edit),
     `pod install` alone may fail with "you've changed the version of X,
     run `pod update X`" for each individually-mismatched pod — faster to
     just run `pod update --no-repo-update` (all pods) once.

None of this needed `npx expo prebuild --clean` — direct edits to the
already-generated `ios/` project were enough, avoiding the risk of losing
the custom GoPro SDK pbxproj fix that a clean prebuild regenerates from
scratch.

## Deploying a JS-only change

```bash
curl -s "http://localhost:8081/index.bundle?platform=ios&dev=false&minify=false" -o /tmp/bundle_check.js -w "HTTP %{http_code}\n"
PID=$(xcrun devicectl device info processes --device 00008130-00164CE80AFA001C 2>&1 | grep -i windsurfcommanderultra | awk '{print $1}' | head -1)
if [ -n "$PID" ]; then xcrun devicectl device process terminate --device 00008130-00164CE80AFA001C --pid "$PID" 2>&1 | tail -3; fi
sleep 2
xcrun devicectl device process launch --device 00008130-00164CE80AFA001C com.anonymous.windsurf-commander-ultra
```

**Important**: `devicectl device process launch` on an already-running app just foregrounds it — it does **not** reload the JS bundle. You must terminate the process first, or the change silently never takes effect (confirmed via `[LocalAI] module evaluated at ...` timestamp logs staying stale across "successful" launches). If the device is locked, launch fails with a clear "Locked" error — ask the user to unlock and retry, don't assume it's a code problem.

Never terminate/relaunch while something long-running is genuinely in flight (e.g. a video import/conversion) — check `xcrun devicectl device info files ...` or logs first if unsure whether something's still working.

Verify JS syntax before every deploy:
```bash
node -e "require('./node_modules/@babel/parser').parse(require('fs').readFileSync('<file>','utf8'),{sourceType:'module',plugins:['jsx']}); console.log('OK')"
```

Metro logs are captured to `/tmp/metro-hnsw.log` (`npx expo start --dev-client 2>&1 | tee /tmp/metro-hnsw.log`) — `grep`/`tail` it instead of guessing at runtime behavior. **Log timestamps are UTC** (`toISOString()`), not local BST — convert before comparing against wall-clock time or you'll misjudge how long something's been running.

To inspect files on the device without a full USB copy (Mac disk is often tight), use:
```bash
xcrun devicectl device info files --device 00008130-00164CE80AFA001C --domain-type appDataContainer --domain-identifier com.anonymous.windsurf-commander-ultra
```
This lists every file with live size + mtime — good for confirming a long-running native operation (video conversion, etc.) is actually still writing, without transferring gigabytes over `devicectl device copy from`.

## Schema gotchas (commander-core, SQLite)

`sessions` has **no** `board_name`, `sail_name`, `fin_name`, or `wind_speed` columns. Gear only exists via `sessions.gear_combo_id → gear_combos → equipment` (board/sail/fin each an `equipment` row, joined three times). Wind/weather lives in `weather_cache`, joined by `date`, not stored per-session. Any task brief (including ones written by a past Claude session) that assumes a flat `sessions.board_name` or similar is wrong — verify against `commander-core/src/data/database/schema.js` before writing SQL.

`equipment` and `gear_combos` frequently have near-duplicate rows from historical CSV/FIT imports (same physical item, differing brand/name spelling or missing fields) — the existing dedup migration only matches on exact `(type, name, brand)`, so don't assume a "duplicate" is a bug; confirm before merging/deleting.

## AI prompt pipeline (`commander-core/src/ai/`)

- `PromptBuilder.js` — builds the full grounded system prompt from live SQLite data. `LocalAI.js` — wraps it in Llama 3.2's chat template and calls `llama.rn`.
- `N_CTX = 3072` is a hard-won number — **4096 fails to load** on this device (native OOM). Don't raise it without re-testing from scratch.
- `MAX_PROMPT_CHARS = (N_CTX - MAX_TOKENS) * 2.0` — the prompt gets silently head+tail-spliced (`truncatePrompt()` in `LocalAI.js`) if it exceeds this. `RECENT SESSIONS` is reliably the section that gets dropped first (it's assembled late in the prompt). A `console.warn` fires in `PromptBuilder.js` when the built prompt exceeds ~3500 estimated tokens or 5500 chars — check Metro logs for it after any change that adds prompt content.
- Every task that "expand the AI's context" adds real prompt bulk. This has repeatedly caused real accuracy regressions (the model answering a completely different question, or wrapping a correct answer in irrelevant preamble) even when the specific fact needed survived truncation — it's a genuine small-model capacity issue at high prompt density, not just a truncation bug. Treat further additions with real caution; consider trimming something else first.
- `TEMPERATURE` (0.5, was 0.7) affects answer consistency more than prompt content does in some cases — a repeated wrong-vs-right answer on the *same* prompt was a temperature/sampling issue, not a data issue.
- Always ground gear text as `Board: X | Sail: Y | Fin: Z` (explicit labels) — a `+`-joined format previously caused the model to call a fin a "sail" despite correct underlying data. This has recurred in more than one place (`buildGearList`, `buildSessionsContext`, key-facts `pbGear` line) — check all of them when touching gear formatting.
- `CoachingService.generateCoaching()` (per-video-session report) must go through `buildSystemPrompt()`, same as `answerQuestion()` — it was previously using a terse, windsurfing-unaware stub prompt and produced a genuinely different-sport (cycling) coaching report as a result.

## Video analysis pipeline

- `.360` file → GPMF binary extraction (`gpmfExtractor.js`, via a hidden WebView) reads the **tail** of the file for the embedded GPS/timestamp track — GoPro's GPMF atom lives near the end, not the start.
- **GoPro Player (Mac) exports strip GPMF metadata.** The documented production workflow (`gopro2gpx` on the raw `.360` file, then renaming the exported MP4 to embed the UTC timestamp in the filename) exists specifically because of this. The app must check the filename for that embedded timestamp (`extractUtcFromFilename()` in `VideoScreen.js`, patterns `_export_<UTC>_` and `WS-<14digits>-`) *before* falling back to binary GPMF extraction, since a Mac-exported file's metadata is already known-gone.
- `video_start_utc` is computed once at import time and persisted — it is never recomputed on later opens. A fix to the extraction logic does not retroactively fix already-imported videos; either re-import, or use the "🔧 Fix GPS Timestamps on Existing Videos" repair action in `VideoScreen.js`.
- GPS speed shown during frame review comes **only** from a FIT file import's `trackpoints` table, matched to the video's linked session by `session_id` + timestamp (±3s tolerance). A video-only session with no FIT import has no speed data, full stop — this isn't a bug to chase.
- `frame_data.speed_kn`/`hr` are correlated and written at frame-insert time (`AnalysisRepository.insertFrames`) so both the review UI and the coaching-report generator read the same numbers.
- When feeding frame/speed correlation into an AI coaching report, always pair it with an explicit instruction not to claim causation from a handful of matched frames (see the `CAUTION` block in `CoachingService.generateCoaching`) — a small real sample is real data, but not proof that speed *causes* a stance change.

## Working style established this session

- **Verify task-brief SQL/schema claims against the real files before implementing** — several task briefs (including ones seemingly written by an earlier Claude session) assumed columns or file locations that don't exist. Grep/read first.
- **Deploy and ask the user to test after every change**, especially AI/prompt changes — this app's behavior only shows up on-device; on-paper-correct code has repeatedly produced wrong runtime results (prompt truncation, sampling variance, stale cached values).
- When something appears "stuck" on-device, check actual evidence (process alive? file growing? log timestamps, converted to the same timezone as your comparison point) before recommending a force-quit — a real incident here was a false alarm caused by comparing a UTC log timestamp against local BST wall-clock time.
- This repo appears to have some auto-commit mechanism outside of manual `git commit` (commits with malformed author-quote fields and no Claude attribution have appeared without being run here) — don't assume `git status`/`git log` fully reflects only what a session explicitly committed.
