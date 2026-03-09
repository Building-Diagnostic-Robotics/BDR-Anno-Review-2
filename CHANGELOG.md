# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Fixed
- Added abort-aware frontend orchestration sleeps and unmount guards for warmup/generation loops so React test teardown can cleanly stop in-flight polling and timer work.
- Hardened async event listener registration cleanup to dispose late-attached Tauri drag-drop and generation-progress listeners when components unmount.
- Reduced frontend test wall-time by defaulting `main.test.tsx` to suggestions-disabled settings and using shorter warmup timeout test fixtures, while adding orchestration sleep unit tests for deterministic timer behavior.

- Split the frontend runtime bootstrap from the `App` component and added shared Vitest cleanup so importing the app in `main.test.tsx` no longer mounts a hidden root that can keep CI frontend tests running indefinitely.

## [1.3.2] - 2026-03-09

### Changed
- Set the default OpenAI suggestion model to `gpt-5.4` in backend settings and the settings UI.

### Fixed
- Filtered background prefetch fetches to `readyFaceIds` returned by readiness/top-up APIs so editor polling no longer triggers foreground generation for queued/in-progress faces.
- Bound worker generation/cache reads to the job suggestion signature and rejected mismatches, preventing stale model/settings cache payloads from being persisted under a newer signature.
- Reused persisted `ready` suggestion payloads in foreground fetches before live generation, preventing duplicate OpenAI calls after warmup/prefetch and allowing cached suggestions to survive app restarts.
- Raised OpenAI suggestion timeout policy for tool-enabled requests by extending the backend default timeout, removing the frontend warmup-timeout override from focused fetches, and letting worker jobs inherit the backend timeout budget instead of failing after 20 seconds.
- Scoped frontend suggestion caching to the active dataset/settings context so overlapping face IDs across datasets or model-setting changes no longer suppress fresh suggestion fetches.
- Added structured OpenAI JSON-output constraints plus broader response-shape parsing and elapsed-time diagnostics to make bbox responses more reliable and timeout failures more actionable.

## [1.3.1] - 2026-02-27

### Fixed
- Corrected SQLite enqueue semantics for `suggestion_jobs` by replacing invalid `ON CONFLICT(... ) WHERE ... DO NOTHING` syntax with `INSERT OR IGNORE`, relying on the existing partial unique index for active-job deduplication.

## [1.3.0] - 2026-02-27

### Added
- Added persistent suggestion storage (`suggestions`) and background job queue storage (`suggestion_jobs`) in a local SQLite database, including uniqueness constraints for `(dataset_id, frame_id, suggestion_signature)` and active-job deduplication for queued/in-progress jobs.
- Added deterministic suggestion-signature generation with canonical JSON serialization and SHA-256 hashing so orchestration and workers can consistently detect whether a frame already has valid suggestions.
- Added backend orchestration endpoints for editor entry and readiness/top-up flows: `editing_session_start_command`, `suggestions_readiness_command`, and `suggestions_topup_command`.
- Added a backend suggestion worker loop that leases jobs atomically, rechecks for existing ready suggestions before LLM calls, persists successful payloads via upsert, records failed suggestions, and marks terminal job states.

### Changed
- Changed suggestion prefetch behavior to use vacancy-based background top-up with readiness snapshots, rather than only in-memory queue checks, so buffer refill continues automatically.
- Changed editor warmup flow to use backend readiness/session orchestration while preserving the entry blocker until the minimum ready threshold is met.
- Changed frontend API/types and tests to use the new readiness/session/top-up contracts for deterministic blocker progress and polling.

### Fixed
- Derived diagnostics terminal health badge from the latest log entry level so transient historical errors no longer keep status stuck in `ERROR` after recovery/clear actions.
- Prevented concurrent editor warmup retries by guarding warmup entry while an existing warmup loop is in flight and disabling retry while the warmup modal is active.

## [1.2.9] - 2026-02-26

### Added
- Separated LLM suggestion controls from editable annotation controls in the editor UI, including suggestion list actions to add individual boxes, apply all suggestions, or replace current editable boxes with confirmation.
- Added visual suggestion overlays on canvas with distinct dashed styling and hover-highlight state independent from editable box active state.
- Added append-only diagnostics logging with timestamped structured entries, scope/level tagging, queue-state metadata, and terminal actions to copy/clear logs.
- Added advanced LLM settings controls for editor warmup threshold ratio and warmup timeout (ms).

### Changed
- Increased frontend warmup timeout baseline and introduced timeout-extension refresh on incremental warmup progress.
- Expanded warmup messaging with target counts, required threshold, and queue-state breakdown (ready/queued/in-flight/failed/unseen), plus retry/continue controls.
- Converted background suggestion buffering into live polling prefetch behavior so face suggestions continue queuing/processing while reviewers work.

### Fixed
- Added an editor informational banner after warmup timeout to clearly indicate background suggestion processing is still active.
- Added explicit diagnostics for suggestion fetch success/failure including provider, model, attempts, and suggestion counts.

## [1.2.8] - 2026-02-26

### Fixed
- Raised the backend default LLM suggestion request timeout from 30s to 120s and added a 10s connect-timeout guard for OpenAI transport so slow multimodal/tooling responses no longer fail prematurely as client-side timeouts.
- Removed the frontend hardcoded 30s suggestion timeout override so runtime requests inherit backend timeout policy consistently.
- Improved OpenAI proxy diagnostics to include `ALL_PROXY`/`all_proxy` and `NO_PROXY`/`no_proxy` signal reporting, reducing false "direct" hints in timeout troubleshooting.

## [1.2.7] - 2026-02-26

### Fixed
- Ensured `get_settings_response` never propagates secure-storage lookup failures: missing credentials and keyring read errors are both treated as `hasKey=false` (with warning diagnostics) so the settings UI remains usable during transient keychain issues.
- Switched the Tauri OpenAI HTTP client to `reqwest` `native-tls` so TLS trust aligns with the host OS certificate store for better compatibility on managed systems.
- Added explicit OpenAI transport diagnostics including reqwest error-class tags, proxy mode hints, and full nested cause chains to make suggestion failures actionable.
- Added proxy-mode diagnostics for OpenAI requests by surfacing whether proxy environment variables are present during client init/request failures (without exposing secrets).
- Hardened suggestion retry classification to treat transient transport send/connect/timeout failures as retryable while preserving fail-loud behavior for permanent errors.

### Changed
- Updated `Cargo.lock` to reflect the TLS backend transition from `rustls-tls` to `native-tls` in the Tauri backend transport stack.

## [1.2.6] - 2026-02-26

### Fixed
- Stopped failing API key saves on immediate post-write secure-storage readback so successful keyring writes are treated as success instead of false-negative verification failures on Windows.
- Preserved explicit fail-loud behavior for real key persistence errors by continuing to surface write failures from secure storage back to the settings UI.
- Updated backend unit tests to cover write-success and write-failure key-save flows under the simplified no-readback verification strategy.

## [1.2.5] - 2026-02-26

### Fixed
- Corrected frontend diagnostics updates for API key set/clear success paths so successful operations no longer emit false `[error] openai`/`[error] anthropic` terminal states.
- Restored fail-loud key-save semantics by verifying provider key readback immediately after secure write and returning explicit errors when post-write verification fails.
- Added regression coverage for settings key-update UX and backend key-save verification branches to prevent reintroduction of false-success key flows.

## [1.2.4] - 2026-02-25

### Changed
- Simplified LLM settings persistence by removing API key fields from save requests and writing only non-secret provider/model/preset settings to `llm-settings.json`.
- Simplified LLM settings response shape to report only non-secret provider config plus per-provider key presence (`hasKey`) without masked previews or keychain status metadata.
- Added dedicated backend key-management commands for setting and clearing provider API keys so credentials stay in OS keyring operations separate from settings JSON writes.
- Updated the settings modal to show key presence (`Present`/`Not set`) and explicit `Set key`/`Clear key` actions, while keeping Save focused on non-secret settings only.
- Updated runtime suggestion generation to fail fast with friendly missing-key guidance when the enabled provider has no configured API key.

### Removed
- Removed immediate keychain readback verification/retry logic after key writes, including the corresponding settings-save failure path tied to immediate post-write keychain visibility.

## [1.2.3] - 2026-02-25

### Fixed
- Hardened LLM key-save verification by adding bounded immediate-readback retries to handle transient keychain visibility delays after write, while preserving explicit failure diagnostics when verification does not converge.
- Split post-write credential verification from general "key configured" lookup semantics so save verification now distinguishes structured missing-entry (`NoEntry`) from backend read failures instead of collapsing platform errors into generic missing-key outcomes.
- Added Rust unit-test coverage for key-save readback verification branches (match, mismatch, transient missing-entry recovery, exhausted retries, and backend read errors) to prevent regressions in settings save behavior.

## [1.2.2] - 2026-02-25

### Fixed
- Fixed GitHub Actions pnpm bootstrap reliability by ensuring repository-root `.npmrc` registry settings are present before `pnpm/action-setup@v4` self-installer runs, preventing Windows `@pnpm/exe` `ERR_PNPM_FETCH_403` failures caused by auth-gated inherited runner defaults.
- Corrected release notes wording to reflect that `standalone: true` still fetches `@pnpm/exe` from npm registry and therefore still depends on registry reachability/auth policy.

### Changed
- Deduplicated frontend toolchain setup across CI and release workflows by introducing a shared composite action (`.github/actions/setup-frontend-toolchain`) used by CI checks, release checks, and release build matrix jobs so pnpm setup hardening remains consistent across Linux and Windows paths.

## [1.2.1] - 2026-02-25

### Fixed
- Hardened secure-key missing-entry detection by preferring structured keyring errors and narrowing string fallbacks to known "missing credential" variants, avoiding false "key missing" classification for backend availability/lock errors.
- Improved LLM settings key-save verification to compare immediate keychain readback against the written value and fail with explicit diagnostics for missing, mismatched, or backend readback failures.
- Expanded secure-key classifier tests to cover additional platform failure variants and prevent regressions in keychain error interpretation.

## [1.2.0] - 2026-02-25

### Changed
- Added a pre-editor warmup flow that prefetches an initial portion of LLM suggestions before entering the editing dashboard, with visible progress messaging and an explicit "Enter now" bypass to preserve workflow control.
- Added a bounded warmup timeout policy so editor entry remains non-blocking when suggestion generation is slow, while logging explicit diagnostics when the warmup threshold is not met in time.

### Fixed
- Improved secure-key missing-entry detection for keyring backends by treating broader "credential missing" variants (including "No matching entry found in secure storage") as "not configured" rather than surfacing keychain status errors.
- Improved settings-save UX by surfacing save failures directly in the LLM settings modal and disabling the Save action while requests are in-flight to prevent silent no-op behavior.

### Added
- Added Rust unit-test coverage for secure-key missing-entry classification variants.
- Added frontend tests for settings-save failure/in-flight UX and editor warmup skip/failure/timeout behavior.

### Changed
- Reworked MP4 extraction batching to use bounded select-filter chunks for large frame sets instead of full-video temporary decode dumps, reducing temporary disk spikes while preserving deterministic frame-to-index mapping guards and fail-loud diagnostics.
- Added a bounded review-render worker pool that automatically caps concurrency by available CPU and a configurable memory budget (`BDR_REVIEW_MEMORY_BUDGET_MB`, `BDR_REVIEW_MAX_RENDER_WORKERS`) to prevent runaway RAM growth on large equirectangular source frames.

### Fixed
- Added explicit review-generation OOM guardrails that fail loudly when a single worker’s estimated decode/render memory exceeds the configured budget, avoiding unstable best-effort behavior under constrained RAM conditions.
- Refactored `extract_frames_via_select` batching progress plumbing to satisfy strict Clippy argument-count limits without changing extraction semantics.
- Improved review render memory detection in Linux containers by preferring cgroup memory limits/usage (`memory.max` + `memory.current`, with cgroup v1 fallback) before `/proc/meminfo`, preventing worker over-allocation under containerized limits.

## [1.1.3] - 2026-02-24

### Changed
- Improved MP4 frame-count probing to use a fast ffprobe metadata-first path (`nb_frames`, `avg_frame_rate` + `duration` estimation) before falling back to full `-count_frames`, reducing long startup stalls on large videos while preserving explicit diagnostics when probing fails.
- Added optional GPU-acceleration mode selection for ffmpeg frame extraction with a new generation request field (`gpuAcceleration`) and engine option (`ffmpeg_hwaccel`), including auto mode that runs a short CPU-vs-platform-GPU probe and only enables hardware decode when the probe is successful and faster.
- Expanded generation progress phases to include early `probing_video` and `planning_frames` updates so long video setup phases are visible in UI progress events.
- Added a frontend heartbeat ticker that keeps `Last update Ns` moving between backend events, improving responsiveness perception during long-running extraction/probe steps.

### Fixed
- Corrected OpenAI suggestion call wiring and image base64 encoding in `llm` so argument order matches `run_openai`, media type is passed through to data URLs, and image bytes are no longer moved before format detection.
- Improved LLM credential UX and diagnostics by adding explicit per-provider key status messaging in Settings, surfacing keychain read failures without silently treating them as missing keys, and validating secure key save via readback before accepting a save request.
- Hardened object-schema bbox parsing by validating returned `image_size` against actual image dimensions and clamping `w`/`h` to remaining bounds from `x`/`y`, preventing out-of-frame suggestion boxes.
- Updated object-schema parser regression expectation to reflect remaining-bounds clamping when `y + h` exceeds image height.
- Ensured suggestion queue entries transition to `failed` (instead of getting stuck `in_flight`) when provider key lookup fails, and limited secure-key reads during generation to the currently enabled provider to avoid unrelated keychain errors aborting requests.

## [1.1.2] - 2026-02-24

### Changed
- Updated Anthropic Messages request building to detect image format and send valid vision image blocks with base64 `source` payloads (`type`, `media_type`, `data`) using supported media types (`image/jpeg`, `image/png`, `image/gif`, `image/webp`) and explicit `content-type: application/json` headers.
- Added a shared `BDR_LLM_CODE_EXECUTION_ENABLED` toggle so OpenAI and Anthropic code-execution tools can be enabled/disabled with parity across providers without changing default bbox-labeling flow.
- Added Anthropic `tools` wiring for code execution (`{"type":"code_execution_20250825","name":"code_execution"}`) and made response text extraction resilient to non-text content blocks by safely skipping/logging structured blocks while preferring JSON-bearing text.
- Updated bbox prompt contract to request stable object output schema (`boxes` + `image_size`) with pixel coordinates while preserving strict negative-case behavior.

### Added
- Added Anthropic payload-shape tests for text+image Messages vision requests and code execution tool configuration.
- Added parser coverage for object-shaped bbox JSON (`boxes`/`image_size`) alongside legacy normalized-array format support.
- Added an ignored Anthropic vision + code-execution smoke test that loads a local image, sends base64 vision input, prints raw response, and parses returned JSON when API key/test image env vars are provided.

### Changed
- Updated OpenAI Responses payload construction for bbox suggestions to use the documented multimodal `input` content format (`input_text` + `input_image`) and added built-in Code Interpreter tool configuration with `container: { type: "auto", memory_limit: "4g" }`.
- Added a debug-only toggle (`BDR_OPENAI_TOOL_CHOICE_REQUIRED=1`) to force `tool_choice: "required"` when validating Code Interpreter execution without changing default bbox-labeling behavior.
- Hardened bbox suggestion parsing to fail loudly when any returned bbox entry is invalid instead of silently accepting partial results.

### Added
- Added OpenAI payload “golden JSON” and schema-shape tests for multimodal + Code Interpreter request bodies, plus response-shape detection tests for Code Interpreter tool outputs.
- Added an ignored network smoke test that can assert Code Interpreter execution against the live Responses API when `OPENAI_API_KEY` is available.

### Fixed
- Scoped the Code Interpreter response-shape helper to tests so release builds pass strict `-D warnings`/dead-code checks in CI.

## [1.1.1] - 2026-02-24

### Fixed
- Fixed review-dataset face assignment so each source annotation is deterministically owned by a single cube face under standard `front/right/back/left` 90° configuration, preventing widespread adjacent-face duplicate boxes in generated manifests.
- Replaced non-face-relative bbox projection with geometric point sampling + face-plane projection, so projected coordinates are derived from per-face camera geometry instead of copied equirectangular scaling.
- Added regression tests for face ownership and face-relative projection behavior to prevent recurrence of duplicated/identical bbox patterns across rendered faces.

## [1.1.0] - 2026-02-24

### Changed
- Parallelized review face generation across source images using Rayon, while preserving deterministic manifest ordering and thread-safe progress reporting/cancellation checks to improve multi-core throughput on large frame sets.
- Optimized face projection rendering hot loops by hoisting row invariants and precomputing x-axis world components once per output image, reducing repeated math in pixel loops.
- Switched rendered face PNG writing to explicit fast-profile encoding (`CompressionType::Fast`, `FilterType::NoFilter`) to reduce per-image write latency during dataset generation.
- Added early yaw-range intersection rejection before box projection to skip non-visible annotations earlier and reduce unnecessary projection work.

## [1.0.0] - 2026-02-23

### Changed
- Performed a full frontend UI overhaul by migrating styling to Tailwind CSS with a shared `anno` design token palette, replacing legacy handcrafted CSS surfaces with utility-driven, modular component styling for consistent dark-mode hierarchy and responsive behavior.
- Redesigned Home, Editor, Export, and modal flows into a cohesive Anno workspace aesthetic with layered solid surfaces, softer rounded geometry, improved action hierarchy, focused input states, and refined micro-interactions across controls.
- Reworked diagnostics into a collapsible bottom status drawer styled as an integrated developer terminal panel instead of a raw always-open command block.
- Applied final Anno Midnight polish pass across Home/Editor/Export/settings surfaces: refined header hierarchy, added subtle indigo ambient background glow, standardized rounded-2xl corners, aligned Create/Resume card proportions, upgraded ghost Browse controls, improved focus-ring input feedback, enhanced Generate button emphasis, and introduced toast-style inline validation alerts with iconography.
- Tuned the diagnostics terminal treatment with a distinct tinted panel and animated chevron affordance for open/close state transitions to better mimic high-end desktop suite behavior.

### Fixed
- Made MP4 extraction cancellation interrupt in-flight `ffmpeg` processes immediately so abort requests stop heavy decode work without waiting for process completion.
- Prevented abort requests from regressing already terminal generation jobs (`done`, `error`, `cancelled`) back to `aborting`.

## [0.9.0] - 2026-02-23

### Added
- Added cancellable generation jobs with a new abort command in the Tauri host and an Abort control in the Home generation flow so users can stop long-running generation safely.

### Changed
- Reworked MP4 frame extraction to avoid repeated multi-pass chunk decoding by using a single-pass select path for moderate frame sets and a single full-decode path for large frame sets, significantly reducing worst-case decode overhead on long videos.
- Extended generation pipeline orchestration with cooperative cancellation checks across validation, extraction, and rendering phases and propagated cancellation-aware progress/status transitions (`aborting`/`cancelled`).
- Updated diagnostics UX to explicitly reset after successful recovery paths (generation success, open success, export success) and to allow clearing state after dismissing generation notices.
- Bundled and superseded the prior patchset from `0.8.0` into this release while preserving those fixes/features in the release lineage.

### Fixed
- Fixed background generation lifecycle behavior so app exit requests mark in-flight jobs for cancellation instead of continuing to run as active generation jobs.
- Fixed stale diagnostics error styling after user recovery by clearing terminal error state on successful operations.
- Fixed generation polling flow to detect and surface cancelled jobs cleanly instead of falling through as generic failures.

## [0.8.0] - 2026-02-23

### Changed
- Refined frontend visual polish across Home/Editor/Export and settings surfaces with stronger typography hierarchy, tokenized status colors, richer focus/active control states, grouped action rows, and a cleaner sectioned LLM settings modal for a more professional UI presentation.
- Reworked global component styling with richer gradient surfaces, polished cards, stronger control states, improved inspector readability, and elevated modal/preview treatments so the full UI feels more premium and consistent across Home, Editor, and Export flows.
- Replaced page-local diagnostics panels with a persistent bottom diagnostics terminal that matches the app theme, starts collapsed, and expands on hover/focus to reveal deeper status history across Home, Editor, and Export screens.
- Redesigned the Home experience around a GitHub-style centered split flow with bold Anno branding, dedicated “Start new project” and “Open existing project” paths, streamlined project/Coco/MP4 intake, and a Generate-first workflow with modal failure notices while keeping diagnostics and settings persistent.
- Refined Home layout ergonomics by removing the bulky top banner, relocating settings to a clean top-right floating action, tightening card spacing to reduce crowding/overflow, and re-anchoring the diagnostics terminal to hover near the viewport bottom without intruding into content cards.

### Fixed
- Prevented editor ArrowLeft/ArrowRight face-navigation hotkeys from firing while typing in bbox input fields, so caret movement inside inputs no longer triggers unintended face switches.
- Moved LLM suggestion prefetch execution to background async tasks so prefetch requests no longer block command completion while keeping queue/cache state transitions explicit (`queued` → `in_flight` → `ready`/`failed`).
- Scoped LLM suggestion queue state by `(dataset_root, face_id)` so identical face IDs across different datasets no longer suppress prefetch for uncached datasets.
- Corrected frame-sourcing COCO diagnostics to report the actual `images[]` index when `file_name` is missing instead of always reporting index `0`.
- Improved editor responsiveness on narrower windows by adding layout breakpoints that avoid horizontal overflow and keep toolbar/nav/canvas/inspector sections reachable.
- Made the settings modal viewport-safe by capping modal height and enabling internal scrolling so lower controls remain accessible on short screens.
- Clamped pointer-driven and manual bbox edits to image bounds so move/resize/draw interactions can no longer save out-of-frame boxes.
- Preserved bbox width/height during pointer drag moves at image edges by clamping move origin without shrinking box dimensions.
- Fixed LLM settings coherence by enforcing a single provider selection when suggestions are enabled (frontend validation + backend fail-loud guardrails).
- Added keyboard-accessible dialog behavior for LLM settings (Escape to close, focus trap, and focus restoration) and close the modal after a successful save.
- Corrected frontend layout fitment issues by clamping the diagnostics dock to a true bottom hover position, adding robust content-safe spacing, truncating long read-only path fields, and making bbox coordinate editors adapt better to constrained widths.
- Packaged all unreleased frontend and UX updates into version `0.8.0` by bumping workspace/Tauri/frontend version metadata.

## [0.7.1] - 2026-02-23

### Changed
- Replaced the LLM suggestion prompt with a ROOFER-focused roofing inspection prompt that requires normalized defect boxes (`xmin`, `ymin`, `xmax`, `ymax`) or the exact negative-case string `"No defects detected"`.
- Updated LLM suggestion parsing to accept the new response contract, convert normalized coordinates to pixel-space annotations using each image's dimensions, and treat `"No defects detected"` as an empty suggestion set.
- Kept COCO/MP4/source-frames path inputs visible on Home (removed advanced-path hiding), removed editor Focus mode/face-queue UI, switched keyboard face navigation to left/right arrows, and expanded preview + inspector responsiveness to reduce clipping/overflow.
- Enabled visible generation activity feedback with an inline throbber and active button label while review dataset generation runs.
- Set LLM defaults to suggestions enabled with a Quality-oriented preset profile and raised default prefetch depth.
- Changed export save dialog fallback filename from `exported_instances.json` to `instances_default.json`.
- Bumped workspace, Tauri app config, and frontend package versions from `0.7.0` to `0.7.1` for this UI/UX + save reliability patch release.

### Fixed
- Kept auto-inferred Home file paths (`COCO JSON`, `Source MP4`) synchronized with dataset root edits until the user explicitly overrides either field, preventing stale hidden-path defaults after iterative root input changes.
- Hardened annotation edit payload normalization in the frontend invoke layer to prevent mixed-case provenance keys from serializing duplicate `updated_at` fields during save requests.

## [0.7.0] - 2026-02-23

### Added
- Introduced a reusable frontend UI foundation with design primitives (`Button`, `Card`, `Field`, and `SectionHeading`) and a centralized token module for color, shape, and motion values to support a cohesive Material-inspired design language.
- Added a guided Home setup stepper and progressive-disclosure controls so common dataset setup paths require less manual input.
- Added an editor face-queue side panel and optional Focus mode to streamline annotation review and reduce visual clutter while editing.

### Changed
- Restyled the application around a dark, minimalist token-driven theme with consistent surfaces, button variants, spacing rhythm, and save/progress motion polish.
- Redesigned LLM settings into basic and advanced tiers with provider selection, preset profiles (`Fast`, `Balanced`, `Quality`), and an effective configuration summary for safer defaults.
- Bumped workspace, Tauri app config, and frontend package versions from `0.6.1` to `0.7.0` for the UI overhaul release.

### Fixed
- Preserved the original resize anchor while dragging edge/corner handles across the opposite side by reusing the pointer-down bbox as the resize baseline for the full drag interaction.

## [0.6.1] - 2026-02-23

### Added
- Added asynchronous generation job commands (`start_generate_review_dataset_command`, `get_generation_status_command`) and frontend polling integration so generation progress can be tracked without blocking a single long-running UI invoke.
- Added full-box resize handle support (all four corners + all four edges) with handle rendering on the active annotation box.
- Added pointer-intent helpers and unit tests for resize/move hit-testing and handle-based bbox resizing behavior.

### Changed
- Refactored editor interaction state to expose intent-aware cursor updates (`grab`/`grabbing` for moves and directional resize cursors for handles) instead of a static crosshair cursor.
- Split coarse busy-state handling into generation/import/export/face-loading specific flags so editor and status UX remain responsive during background operations.
- Updated editor quick tutorial guidance to describe resizing from any corner/edge.

### Fixed
- Fixed autosave regression for pointer-driven bbox modifications by hardening dirty-state checks and forcing autosave scheduling after pointer-up when unsaved edits remain.
- Moved import-stage validation for generation into `spawn_blocking` execution to avoid synchronous blocking during dataset generation startup.

## [0.6.0] - 2026-02-23

### Added
- Added secure LLM settings management and backend commands for reading/saving provider configuration, clearing provider keys, and feature-gating suggestions with reasoning + prefetch controls.
- Added OpenAI (`gpt-5.2`) and Anthropic (`claude-opus-4-6`, `claude-sonnet-4-6`) suggestion provider adapters with a shared normalized suggestion parser, prompt file loading (`src-tauri/prompts/suggest_boxes_v1.txt`), and deterministic bbox normalization/sorting.
- Added end-to-end suggestion commands (`get_suggestions`, queue prefetch/state commands) plus backend retry/backoff handling for transient API failures and queue state tracking for linear review buffering.
- Added a Home-page settings entry (gear button) and a new LLM Settings modal with masked API key fields, show/hide toggles, provider/model selection, reasoning preset, and prefetch buffer controls.

### Changed
- Updated frontend editor flow to maintain suggestion queue state and prefetch next linear faces from the current position to reduce annotation interruptions from LLM request latency.
- Bumped workspace, Tauri app config, and frontend package versions from `0.5.1` to `0.6.0` for the LLM suggestions feature release.

## [0.5.1] - 2026-02-23

### Fixed
- Prevented autosave from treating stale edits as dirty during face switches by gating dirty-check/autosave while target face annotations are still loading.
- Preserved newer in-flight UI edits when an older save request resolves by only applying save responses when the current editor snapshot still matches the saved request snapshot.
- Fixed frontend test resolver typing in `main.test.tsx` so production frontend builds no longer fail TypeScript compilation with `Type 'never' has no call signatures` errors.
- Bumped workspace, Tauri app config, and frontend package versions from `0.5.0` to `0.5.1` for this patch release bundle.

## [0.5.0] - 2026-02-23

### Added
- Added an explicit 3-step UI flow with dedicated Home, Editor, and Export pages so users can move through dataset intake/resume, annotation, and export in a guided order.
- Added a collapsible quick tutorial panel in the editor with persisted collapse preference (`localStorage`) for discoverable but unobtrusive annotation guidance.
- Added debounced editor autosave with visible save-state badges (`Unsaved`, `Autosaving`, `Autosaved`, and error states) while retaining manual Save as an explicit fallback.
- Added export completion controls that let users continue editing or return home directly from the export page.

### Changed
- Refactored the annotation dashboard layout to prioritize a large centered frame preview/canvas with a sticky action toolbar for progress, save/export controls, and face navigation.
- Updated frontend unit tests to cover the new multi-page workflow, autosave behavior, tutorial persistence, and delete-box behavior under the revised UI.
- Bumped workspace, Tauri app config, and frontend package versions from `0.4.2` to `0.5.0` for the workflow-oriented UI/UX release.

### Fixed
- Enabled Tauri asset protocol with a bounded filesystem scope for common local dataset locations so face preview images resolved via `convertFileSrc` (including Windows absolute paths) load reliably instead of returning `asset.localhost` 403 errors.
- Updated frontend face-preview path tests to mimic real Tauri `convertFileSrc` URLs (`http://asset.localhost/...`) so Windows absolute-path preview regressions are caught in unit tests.
- `scripts/check.sh` now auto-builds `frontend/dist` when missing so Tauri workspace tests no longer fail with a missing `frontendDist` path in clean environments.
- Scoped staging-workspace lifecycle cleanup to the active app session so startup/exit cleanup no longer deletes temp workspaces created by other concurrently running app processes.
- Hardened staging workspace ownership validation by requiring an app-owned marker file before cleanup removes a temp directory, preventing accidental deletion of similarly prefixed non-app directories.
- Restricted Linux `.deb` uninstall cleanup to remove only marker-verified app-owned staging directories under `/tmp` instead of sweeping by name prefix alone.


## [0.4.2] - 2026-02-22

### Fixed
- Invalidated the in-memory annotation cache for a dataset when opening that dataset and after review-dataset regeneration completes, preventing stale cached edits from surviving manifest/regeneration changes.
- Hardened dataset open/list preflight to validate every manifest `faces[].image_path` target exists on disk and fail loudly with sampled missing face IDs/paths, so preview-load issues are diagnosed before face selection.
- Normalized manifest preview image paths before preflight existence checks so Windows-style relative separators (for example `raw_frames\\face-1.png`) resolve correctly on macOS/Linux instead of being misreported as missing files.
- Fixed dropped-input staging so `staged_dataset_root` is assigned only from dropped directories; unsupported non-JSON/non-MP4 files are now ignored and reported instead of being misclassified as dataset roots.
- Hardened recursive dropped-directory staging to skip only symlinked directories (preventing recursive traversal of symlink cycles) while preserving symlinked files by materializing their file contents in the staging workspace.

### Added
- Added app-owned staging workspace tracking in the Tauri host and a cleanup command that removes only `bdr-anno-review-drop-*` temp directories while skipping non-owned paths.
- Added startup/exit best-effort cleanup hooks so registered dropped-input staging workspaces are removed even when packaging uninstall hooks are unavailable (for example AppImage).
- Added Linux `.deb` post-remove and Windows NSIS uninstall hooks that remove app-owned dropped-input temp directories during uninstall.
- Added Tauri host regression tests for staging-workspace cleanup behavior, including owned-path deletion and non-owned path skipping.
- Added Tauri-host regression tests for drop staging to ensure dataset root selection prefers dropped directories over unsupported files and to verify recursive staging skips symlinked directories on Unix.
- Added backend generation progress event streaming (`generation-progress`) with work-based payloads (`phase`, `completed/total`, percent, elapsed ms) so the UI can display live progress instead of static step percentages.
- Added session-scoped annotation caching in the Tauri host for `get_annotations`/`set_annotations` to speed repeated face-to-face navigation within an open review session.
  
### Changed
- Updated release docs with explicit uninstall cleanup behavior for Windows NSIS, Linux deb, and Linux AppImage installs.
- Bumped workspace, Tauri app config, and frontend package versions from `0.4.1` to `0.4.2` for temp-workspace cleanup coverage and uninstall cleanup hooks.
- Collapsed frontend generation orchestration to a single backend generation command that performs validation, frame extraction, and review generation in one pipeline call.
- Moved heavy generation/extraction work off the command thread by running engine work in Tauri `spawn_blocking` tasks, improving UI responsiveness during long-running operations.
- Updated MP4 frame extraction to process referenced frames in bounded ffmpeg chunks instead of one unbounded select filter expression.
- Updated review generation to skip rendering/writing face images when a face has no projected boxes, reducing unnecessary CPU and I/O work.
- Added optional generation quality profiles (`high`/`balanced`/`low`) that tune render size for wider low-compute device support.
- Replaced fixed frontend generation progress percentages with event-driven progress + heartbeat-style status updates.
- Drop-import diagnostics now report backend-provided ignored staged paths, and the staged-input response schema now includes `ignored_paths` / `ignoredPaths` for explicit UI messaging.
  
## [0.4.1] - 2026-02-22

### Changed
- Bumped workspace, Tauri app config, and frontend package versions from `0.4.0` to `0.4.1` for dropped-input staging correctness and symlink-safety hardening.

## [0.4.0] - 2026-02-22

### Added
- Added a discoverable **Drop input** workflow in the frontend with a dedicated button and modal popup so users can intentionally use drag-and-drop intake rather than relying on hidden window-drop behavior.
- Added backend staging support via a new Tauri `stage_dropped_inputs_command` that copies dropped files/directories into an app-managed temporary workspace and returns staged paths for dataset root, COCO JSON, and MP4.

### Changed
- Updated drop ingestion to use staged temp-workspace paths before import/generation and improved diagnostics to report the staging workspace and ignored paths.
- Bumped workspace, Tauri app config, and frontend package versions from `0.3.4` to `0.4.0` for the file-input schema and drop-staging UX release.

## [0.3.4] - 2026-02-22

### Fixed
- Fixed Tauri import-stage IPC decoding by introducing a camelCase request boundary for `run_import_stage_command` and mapping it into engine snake_case options, eliminating `missing field `dataset_root`` errors from frontend validation and generation preflight calls.
- Added a camelCase import-stage response boundary in the Tauri host so frontend diagnostics receive consistently-cased fields from `run_import_stage_command`.
- Improved `open_dataset_command` and `list_faces_command` preflight diagnostics to fail loudly with actionable messages when dataset root is missing/invalid or `annotations/view_manifest.json` is absent (including guidance to run Generate review dataset first), replacing opaque OS path errors.
- Added Tauri host regression tests for camelCase import-stage request decoding and manifest-preflight error messaging to prevent recurrence.

### Changed
- Bumped workspace, Tauri app config, and frontend package versions from `0.3.3` to `0.3.4` for the IPC boundary and diagnostics hardening release.

## [0.3.3] - 2026-02-22

### Fixed
- Added explicit Tauri capability permissions for dialog open/save in `src-tauri/capabilities/default.json` so Windows browse/save actions are allowed instead of failing with `plugin:dialog|open` ACL denial at runtime.
- Improved frontend dialog failure diagnostics to surface ACL-specific remediation hints for missing `plugin:dialog|open` and `plugin:dialog|save` permissions, while preserving fail-loud behavior for other picker errors.

### Changed
- Bumped workspace, Tauri app config, and frontend package versions from `0.3.2` to `0.3.3` for the Windows dialog ACL fix release.

## [0.3.2] - 2026-02-22

### Fixed
- Fixed review dataset generation to create the `annotations/` output directory before writing `annotations/view_manifest.json`, preventing Windows `os error 3` (and equivalent missing-parent failures on other OSes) when the directory is absent.
- Added regression coverage for missing `annotations/` directory creation so manifest writes remain fail-loud and cross-platform robust.

### Changed
- Bumped workspace, Tauri app config, and frontend package versions from `0.3.1` to `0.3.2` for the cross-platform manifest output-path fix release.

## [0.3.1] - 2026-02-22

### Fixed
- Added Linux release-bundle sidecar verification in `.github/workflows/release.yml` so CI now inspects generated `.AppImage` and `.deb` artifacts and fails loudly when `ffmpeg`/`ffprobe` sidecars are missing from payload contents.
- Added Linux bundle discovery diagnostics and strict single-artifact checks for AppImage/deb verification, including searched target roots and sidecar-name match diagnostics to make release failures actionable.

### Changed
- Bumped workspace, Tauri app config, and frontend package versions from `0.3.0` to `0.3.1` for the Linux sidecar verification release-hardening update.

## [0.3.0] - 2026-02-22

### Added
- Added drag-and-drop path intake in the desktop UI so dropped `.json` and `.mp4` files auto-fill COCO/MP4 fields and other dropped paths auto-fill dataset root with explicit diagnostics.
- Added in-flow generation progress UI messaging that reports step-by-step status (`validating`, `dependencies`, `extracting`, `generating`) and completion percentage for review dataset generation.

### Changed
- Simplified import/generation UX by removing the confusing three-button split and keeping one primary `Generate review dataset` action plus a secondary `Validate inputs only` action.
- Updated generation orchestration so the primary generate action always runs validation first, then dependency checks, frame extraction, and review dataset generation in one guided sequence with explicit stage diagnostics.
- Added browse dialog failure handling in dataset input pickers so dialog failures are surfaced loudly instead of silently doing nothing.
- Bumped workspace, Tauri app config, and frontend package versions from `0.2.9` to `0.3.0` for the dataset generation UX overhaul release.

### Fixed
- Prevented Windows FFmpeg/FFprobe terminal popups by launching subprocesses with `CREATE_NO_WINDOW` for frame extraction, MP4 probing, and runtime dependency verification command checks.

## [0.2.9] - 2026-02-22

### Fixed
- Fixed the `publish-release` job in `.github/workflows/release.yml` to make GitHub CLI release publishing independent of local `.git` metadata by passing an explicit `--repo "${{ github.repository }}"` target.
- Added a pre-edit `gh release view` diagnostic in `publish-release` with explicit `--repo` scope so missing tag/repo context fails early with actionable output before toggling draft state.

### Changed
- Bumped workspace, Tauri app config, and frontend package versions from `0.2.8` to `0.2.9` for the release publishing context fix.

## [0.2.8] - 2026-02-22

### Fixed
- Fixed Windows NSIS sidecar verification in `.github/workflows/release.yml` to accept both target-suffixed sidecar filenames (`ffmpeg-x86_64-pc-windows-msvc.exe`, `ffprobe-x86_64-pc-windows-msvc.exe`) and normalized names (`ffmpeg.exe`, `ffprobe.exe`) when validating installer payload contents.
- Expanded embedded NSIS payload inspection beyond only `*.exe` files to also inspect `.7z`, `.zip`, and extensionless artifacts, while gracefully skipping unreadable candidates and preserving fail-loud behavior.
- Added richer diagnostics for NSIS verification failures, including selected setup path, allowed sidecar names, extracted sidecar-like file hits, embedded listing candidates, and sidecar-like listing lines to make CI triage actionable.

### Changed
- Bumped workspace, Tauri app config, and frontend package versions from `0.2.7` to `0.2.8` for the Windows sidecar verification reliability fix.

## [0.2.7] - 2026-02-22

### Fixed
- Hardened Windows NSIS sidecar verification in `.github/workflows/release.yml` by replacing the fixed `src-tauri/target` root assumption with dynamic target-root discovery across `$CARGO_TARGET_DIR`, `${{ github.workspace }}/target`, and `${{ github.workspace }}/src-tauri/target`, then recursively locating `bundle/nsis` setup executables from existing roots only.
- Added explicit discovery diagnostics listing searched roots, existing roots, and discovered setup candidates, with fail-loud errors that include probed paths when no target root or NSIS installer is found.

### Changed
- Bumped workspace, Tauri app config, and frontend package versions from `0.2.6` to `0.2.7` for the Windows release verification robustness fix.

## [0.2.6] - 2026-02-22

### Fixed
- Fixed Windows release-side NSIS installer verification in `.github/workflows/release.yml` by replacing the brittle hard-coded `src-tauri/target/release/bundle/nsis` lookup with recursive discovery under `src-tauri/target` filtered to `bundle/nsis` setup candidates.
- Added explicit NSIS setup discovery diagnostics and fail-loud checks for zero or multiple setup candidates so CI failures are actionable.

### Changed
- Bumped workspace, Tauri app config, and frontend package versions from `0.2.5` to `0.2.6` for the Windows NSIS verification-path fix release.

## [0.2.5] - 2026-02-22

### Fixed
- Hardened Windows release artifact verification in `.github/workflows/release.yml` by removing the brittle assumption of a fixed intermediate payload filename and instead checking both recursively extracted files and embedded executable payload listings for `ffmpeg-x86_64-pc-windows-msvc.exe` and `ffprobe-x86_64-pc-windows-msvc.exe`.

### Changed
- Bumped workspace, Tauri app config, and frontend package versions from `0.2.4` to `0.2.5` for the Windows sidecar verification hardening release.

## [0.2.4] - 2026-02-22

### Fixed
- Moved FFmpeg/FFprobe sidecar bundling to a checked-in Tauri release override config (`src-tauri/tauri.release.conf.json` `bundle.externalBin`) and switched CI to pass it with `--config`, so Windows/Linux bundles use versioned sidecar rules instead of workflow-inline JSON overrides.
- Added post-build Windows NSIS artifact inspection in release CI to assert that `ffmpeg-x86_64-pc-windows-msvc.exe` and `ffprobe-x86_64-pc-windows-msvc.exe` are present in the packaged app payload.
- Expanded runtime dependency diagnostics to include sidecar candidate paths checked before PATH fallback, making missing-sidecar packaging issues easier to debug from user reports.

### Changed
- Bumped workspace, Tauri app config, and frontend package versions from `0.2.3` to `0.2.4` for the sidecar packaging reliability fix release.

## [0.2.3] - 2026-02-22

### Fixed
- Fixed runtime FFmpeg/FFprobe sidecar discovery in the Tauri host by searching both top-level and `binaries/`-prefixed resource paths (plus adjacent executable fallbacks), so tagged-release installers can resolve bundled sidecars consistently at runtime.
- Kept release-time `bundle.externalBin` injection in `.github/workflows/release.yml` and added a filename guard so bundled sidecar expectations fail fast before Tauri packaging starts.

### Changed
- Bumped workspace, Tauri app config, and frontend package versions from `0.2.2` to `0.2.3` for the packaging fix release.

## [0.2.2] - 2026-02-22

### Fixed
- Added the missing `src-tauri/icons/512x512.ico` release icon asset and bumped workspace/Tauri/frontend versions to `0.2.2` so release tags can be cut with aligned metadata.

## [0.2.1] - 2026-02-22

### Changed
- Removed the Tauri build-script fallback that generated a 1x1 placeholder icon and now require repository-provided icon assets for bundling.
- Configured Tauri `bundle.icon` entries for standard Windows/macOS/Linux icon filenames so AppImage/deb/nsis packaging can resolve square icon assets from `src-tauri/icons/`.
- Bumped workspace/Tauri/frontend version metadata to `0.2.1` for the icon/bundling fix release.

- Switched the Tauri bundle identifier from placeholder `com.example.bdrannoreview` to canonical reverse-DNS `io.bdr.annoreview` to stabilize installer/update identity across tester and production channels.
- Updated the generation UI to treat source frame directory as MP4-extraction-managed output (read-only), and clarified diagnostics to label it as auto-generated.
- Added release tag/version parity checks in CI (`scripts/check-tag-version.sh`) and release docs guidance so Cargo/Tauri/frontend versions stay aligned before tagging.

## [0.2.0] - 2026-02-22

### Tester Summary
- **Supported platforms:** Windows (NSIS installer) and Linux (`.AppImage`, `.deb`).
- **MVP capabilities:** validate import inputs, extract MP4 frames, generate deterministic review faces/manifest, edit bounding boxes, and export deterministic COCO.
- **Known limitations / deferred scope:** MP4-first workflow (manual source-frame override disabled), optional provider integrations deferred, and external FFmpeg sidecar prerequisites remain explicit.

### Changed
- Expanded release workflow matrix jobs to fetch platform-specific FFmpeg sidecar binaries and pass Tauri `externalBin` configuration at bundle time so installers include working `ffmpeg`/`ffprobe` out of the box.
- Surfaced invalid bundled FFmpeg sidecars as explicit runtime errors instead of silently falling back to PATH resolution, making packaging failures deterministic and actionable.
- Decided FFmpeg delivery strategy for release builds: ship `ffmpeg`/`ffprobe` as sidecar binaries (with PATH fallback in local/dev), added runtime dependency preflight diagnostics in Tauri/frontend generation flows, and documented the rationale/prerequisites in architecture + README guides.
- Improved dataset onboarding UX by replacing fixture defaults with empty-state inputs, adding Tauri file/folder/save pickers for dataset/COCO/MP4/export selection, and surfacing client-side required-field/extension validation before import, generation, and export actions.
- Expanded quality gates to run frontend unit tests in local `scripts/check.sh`, CI, and release-check workflows in addition to existing type checks.
- Hardened `frame_sourcing` extraction tests to be cross-platform and deterministic by gating Unix-specific permission usage and by forcing missing-ffprobe failures through an explicit nonexistent binary path.
- Enabled Tauri bundling for distributable tester artifacts and set minimal Windows/Linux bundle targets (`nsis`, `appimage`, `deb`) for external delivery.
- Added a tag-driven GitHub Actions release workflow that runs frontend/Rust checks, builds platform bundles, and publishes Windows/Linux artifacts for both stable and prerelease tags.
- Fixed release bundling workflow to build `frontend/dist` in the tag-only bundle job before invoking `tauri-action`, preventing missing-web-assets failures on clean runners.
- Documented tester download, platform prerequisites, and install/run steps in the README release guide.
- Added reviewer-side bounding-box deletion controls (button + Delete/Backspace shortcut) with consistent active-selection/pointer-state updates, plus frontend roundtrip behavior checks covering delete → save → reload persistence through existing annotation APIs.
- Wired MP4-first review generation end-to-end: added backend frame extraction before generation, connected it through a new Tauri command and frontend generate/validate+generate flows, aligned generation to deterministic `frame_######.png` mapping for MP4 inputs, and expanded engine coverage for MP4 happy-path plus explicit extraction-failure diagnostics.
- Replaced review face generation's source-frame file copy placeholder with real equirectangular-to-perspective rendering per configured face (`front/right/back/left`), render size, and horizontal FOV so generated face images are distinct projections rather than duplicates.
- Upgraded the reviewer UI from text-only bbox editing to include selected-face image preview rendering, a canvas-based bbox interaction layer (draw/move/resize) synchronized with existing annotation get/set/save flows, keyboard-driven face navigation continuity, and explicit client-side invalid-edit feedback with non-negative size safeguards before save.
- Updated CI workflow ordering to build `frontend/dist` before Rust checks so Tauri `generate_context!()` can resolve the configured `frontendDist` path during `cargo test` and `cargo clippy`.
- Expanded view manifest schema and Rust engine manifest models to include structured `inputs`, `render`, and `projection` metadata with explicit required-field validation, including MP4 frame-source variant support and schema-version expectation checks in unit tests.
- Aligned `schemas/view_manifest.schema.json` face entries with engine output by allowing optional `initial_boxes` (with strict `source_annotation_id` + 4-number `bbox` shape) while preserving `additionalProperties: false`, and added engine tests that lock schema expectations to manifest model behavior.
- Clarified the MVP input contract across architecture and contributor docs: COCO `instances_default.json` + MP4 is primary/preferred, with frames-directory support documented as secondary/optional convenience.
- Updated GitHub Actions CI to install required Linux GTK/GLib/WebKit system packages before Rust checks so Tauri-linked crates can compile on ubuntu runners.

- Wired an end-to-end import-to-generation workflow into the app by adding a Tauri `generate_review_dataset_command`, frontend invoke wrapper, and import-section actions for generation-only or validate+generate flows with explicit diagnostics that distinguish validation failures vs generation failures and report manifest path + generated face counts.

### Added

- Added an end-to-end MVP reviewer UI + Tauri command bridge for dataset open/import, face listing, annotation get/set/save, and COCO export, including keyboard face navigation, progress indicator, and clear backend status/error diagnostics (with optional LLM suggestions explicitly deferred), and configured Tauri bundling to avoid checked-in binary icon assets.
- Added a deterministic `crates/engine` COCO export pipeline that builds output from manifest face order + persisted review edits, enforces a single `{id:1,name:"bbox"}` category contract, assigns incremental image/annotation IDs, validates export preconditions (manifest, edits readability, writable output path), and includes repeat-run stability tests.
- Added annotation-edit persistence in `crates/engine` via `annotations/review_edits.json`, including deterministic face-keyed serialization, atomic write/rename behavior, explicit payload validation, and backend APIs for `get_annotations(face_id)` / `set_annotations(face_id, edits)` with Tauri command bindings.
- Added a review-generation pipeline in `crates/engine` that deterministically processes referenced source frames into `front/right/back/left` 1024x1024 face artifacts, projects and clips source COCO boxes per face with minimum-area filtering, emits stable `face_id` values from source/render/projection inputs, writes manifest entries in deterministic order, and fails loudly with actionable required-input diagnostics.
- Added deterministic engine tests covering stable manifest ordering and `face_id` reproduction across repeated runs, plus required-input failure diagnostics for missing source frames.
- Added a new `frame_sourcing` engine module that resolves only COCO annotation-referenced images into deterministic frame-extraction plans, maps `images[].file_name` / optional `frame_index` conventions to `derived_frames/frame_sourcing/frame_######.png`, and raises explicit diagnostics when frame references are unresolved or out of MP4 bounds.
- Added fixture-driven frame-sourcing tests and tiny COCO fixtures under `fixtures/tiny_dataset/annotations/instances_frame_source_*.json` to validate deterministic mapping and failure diagnostics.
- Added an import-stage module in `crates/engine` that validates MVP inputs (`dataset_root`, COCO JSON, MP4), parses and validates required COCO sections (`images`, `annotations`, `categories`), builds image-id lookup for annotation reference resolution, and emits explicit user-facing errors for missing files, unsupported formats, empty sections, parse failures, and broken references.
- Added a Tauri command (`run_import_stage_command`) to expose import-stage validation results/errors to the frontend invoke layer.
- Initial architecture-aligned repository scaffold for frontend, Tauri host, Rust crates, schemas, fixtures, CI, and utility scripts.
- Core project documents (`README.md`, docs contribution guide, schema and fixture readmes).
- Safety-focused `.gitignore` rules for datasets, media, secrets, and session artifacts.
