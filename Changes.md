# Recent Changes

This document tracks the recent bug fixes and configuration updates made to the application.

## 1. `estimated_completion` Time Formatting Bug Fix
- **Issue**: The `handleSaveToDb` function contained a rounding bug where `Math.round(totalMins % 60)` could return `60` (e.g., when `totalMins % 60` was `59.5`). This generated invalid time strings like `"21:60"`, causing 422 validation errors from the backend.
- **Fix**: Moved the rounding logic to `totalMins` *before* decomposing it into hours and minutes, ensuring the minute value (`cm`) always strictly stays in the `0-59` range.
- **Files Touched**: `src/components/planning/ProductionPlanningPage.tsx`

## 2. Yield-Adjusted "Good Bottles" in Grid Qty Column
- **Issue**: The main planning grid's "Qty" column was showing the raw, unadjusted daily quantity, whereas users expected to see the 90% yield-adjusted "Good Bottles" amount (which was previously only visible inside the cell hover tooltip).
- **Fix**: Applied the `calcGoodBottles` utility (90% yield factor) to the raw quantity returned by `calculateQuantityForProductionDay` within the `getDailyProducedQty` wrapper. This aligns the grid column with the tooltip.
- **Files Touched**: `src/components/planning/ProductionPlanningPage.tsx`

## 3. GitHub Actions CI Deployment Fix
- **Issue**: The CI workflow was failing with a `permission denied: The requested installation does not exist` error when trying to push Docker images. This occurred because the repository was moved back to the `omkarshejwal` namespace.
- **Fix**: Updated the GitHub Container Registry (GHCR) tags in the CI workflow to push to `ghcr.io/omkarshejwal/...` instead of the old `vlr-spec` namespace.
- **Files Touched**: `.github/workflows/ci.yml`

## 4. Holiday Highlighting Logic
- **Issue**: The holiday cache was empty on the initial load of the planning grid, so holiday dates were not being highlighted correctly on the screen.
- **Fix**: Added a `useEffect` hook to fetch holiday data on component mount and store it in state, forcing the UI to highlight holiday dates properly upon initial load.
- **Files Touched**: `src/components/planning/ProductionPlanningPage.tsx`

## 5. Job Deletion 500 Error
- **Issue**: Deleting jobs threw a 500 Internal Server Error due to a Postgres type mismatch (`InvalidDatetimeFormat`).
- **Fix**: Parsed the `plan_date` and `start_time` string parameters into a proper Python `datetime` object before querying the database.
- **Files Touched**: `Backend/app/api/production/jobs.py`

## 6. Quality Control Data Not Persisting After Refresh
- **Issue**: Bottle selections and hourly production rows looked saved but vanished after a page refresh (the `hourly_production` table stayed empty). Four root causes: (1) the real column `hourly_production.job_id` is `VARCHAR(20) NOT NULL` while the save code wrote `NULL`, so SQLAlchemy raised `IntegrityError` and rolled back the whole day's transaction; (2) once (1) was fixed, `hpr.hpr_job`'s partial unique index `uq_production_job_one_running_per_machine (machine_no) WHERE status = 'RUNNING'` rejected the new `RUNNING` job because the previous one (`J001`) had never been closed — again rolling back the whole day; (3) the failures were swallowed — the repository returned `ok:false` with no reason and the UI still showed a success toast; (4) Pydantic v2 rejected fractional floats for integer columns (`cartons: 12.5` → 422), aborting the entire day's save.
- **Fix**: Send `job_id = ""` instead of `NULL` on insert/update/clear (schema untouched); close the machine's still-`RUNNING` job (status `COMPLETED`, `job_end_time` = the new run's start) and flush it before inserting the new one; de-duplicate `defect_ids` before writing `hourly_production_defect` (composite PK `(entry_id, defect_id)`); added `db.rollback()` + `logger.exception(...)` and a 500 detail of the form "…was NOT saved (the transaction was rolled back)" for unexpected errors; added a `field_validator(mode="before")` that truncates whole-number fields and `Math.trunc` on the frontend payload; load/save errors now propagate to the UI (error banner shows the server reason, save failure toasts the reason); the save response is treated as proof of persistence — every sent bottle row must be present in the returned committed state or the save is reported as failed; load failures no longer blank the store, and untouched-but-meaningful rows are preserved. The ORM model was also aligned with the live database (`job_id` `NOT NULL`, `packing_category` `VARCHAR(100)`, `defect_type` `VARCHAR(20)`, `defect_name` `VARCHAR(255)`, `shift_name` `VARCHAR(20)`, supervisor/executive `VARCHAR(255)`) so `create_all` no longer drifts from the deployed schema — no table or constraint was created, altered or dropped.
- **Files Touched**: `Backend/app/api/production/quality_daily.py`, `Backend/app/schemas/quality.py`, `Backend/app/models/quality.py`, `src/services/qualityRepository.ts`, `src/components/quality/ProductionQualityMonitor.tsx`

## 7. Snyk Security Vulnerability Remediations (Containers & Dependencies)
- **Issue**: Snyk security scans detected container-level and open-source dependency vulnerabilities across the repository:
  - `Backend/Dockerfile`: Outdated Python Debian base image with unpatched OS packages.
  - `Dockerfile`: Vulnerable `zlib 1.3.2-r0` package in the `nginx:alpine` runtime container stage.
  - `package.json` & lockfiles: 13 unique open-source issues including `proxy-addr` (Critical), `qs` (High/Medium), `brace-expansion` (High/Medium recursion & ReDoS), `dompurify` (Medium XSS), and `traverse` (Medium prototype pollution).
- **Fix**:
  1. **Backend Container**: Pinned base image to `python:3.11-slim-trixie` (Debian 13) and added an OS package update layer (`RUN apt-get update && apt-get upgrade -y && rm -rf /var/lib/apt/lists/*`) to ensure newly released Debian security patches are applied.
  2. **Frontend Container**: Fixed multi-stage casing (`as build` → `AS build`) and added `RUN apk upgrade --no-cache` to the `nginx:alpine` stage, upgrading `zlib` to `1.3.2-r1` and clearing all container vulnerabilities.
  3. **Removed Unused Packages**: Verified 0 codebase usage and removed `@google/genai`, `dotenv`, `express`, and `@types/express` from `package.json`, eliminating `proxy-addr` (Critical) and all 3 `qs` issues.
  4. **Scoped `dompurify` Override**: Added `"overrides": { "jspdf": { "dompurify": "^3.4.16" } }` in `package.json` (resolving `3.4.17`), fixing both `dompurify` XSS findings. (Also verified `jspdf.html()` is never called in `src/`).
  5. **Lockfile Transitive Bumps**: Updated `package-lock.json` and `bun.lock` to resolve `brace-expansion` to `1.1.21` (1.x line) & `2.1.7` (2.x line) and `traverse` to `0.3.10` within their existing parent semver ranges.
  6. **Client Bundle Audit**: Verified that `unzipper`, `inflight`, `glob`, and `archiver` are completely absent from browser bundles in `dist/`.
- **Files Touched**: `Backend/Dockerfile`, `Dockerfile`, `package.json`, `package-lock.json`, `bun.lock`

## 8. Lehr Out Time Management & Zero-Schema-Change Timeline Persistence
- **Issue**: Plant operations require tracking variable Lehr Out (annealing lehr clearance) times (0–119 minutes) for each shift's final hour (Shift 1 ending at 4:00 PM, Shift 2 ending at 12:00 AM, Shift 3 ending at 8:00 AM). Changing a shift's final hour duration shifts the start time of the subsequent shift and carries over the 3rd shift's adjustment into the next production day's initial 9:00 AM hour. These custom interval durations needed to survive Save, Refresh, and Page Reload without requiring database schema alterations or DDL migrations in deployed PostgreSQL environments.
- **Fix**:
  1. **Zero-Schema Persistence**: Persisted non-standard segment durations directly inside the `microsecond` component of `hourly_production.production_time` (`minutes * 1000` for standard durations up to 720 min, and `(minutes - 1320) * 1000 + 500` for overflow up to 1440 min). Default 60-minute rows retain `0` microseconds. Normalization helpers (`_norm_time`) strip microseconds on row identity checks, uniqueness constraints, and lock validations, ensuring zero regressions on existing database queries.
  2. **Schema & API Updates**: Extended `QualityHourlyEntrySchema` and `QualityEntryPayload` with optional `period_start` and `period_end` string labels. The backend emits reconstructed period labels on GET `/api/production/quality/daily/`.
  3. **Delete Logic**: Updated deletion query in `save_daily_quality` to match on normalized time-of-day rather than exact datetime equality so rows with embedded microsecond durations are never skipped during delete operations.
  4. **Deploy Workflow**: Added `VITE_API_BASE_URL` alongside `VITE_API_URL` in `.github/workflows/deploy.yml`.
- **Files Touched**: `Backend/app/api/production/quality_daily.py`, `Backend/app/schemas/quality.py`, `src/services/qualityRepository.ts`, `src/components/quality/ProductionQualityMonitor.tsx`, `.github/workflows/deploy.yml`

## 9. Shift Lehr Out Locking & Uncapped Efficiency Reporting
- **Issue**:
  1. When an operator saved and locked a shift's final hour row, the Lehr Out minute input for that shift remained editable, allowing accidental desynchronization between entered intervals and locked records.
  2. Efficiency values in both `ProductionQualityMonitor` and `QualityReport` were artificially capped at 100% via `Math.min(100, efficiency)`. When a production line ran above rated speed, the true operational efficiency was hidden.
- **Fix**:
  1. **Lehr Out Lock**: Tied the Lehr Out input's disabled state to the shift's final hour row (`layerOutLocked = isFirstInShift && !!activeRows[SHIFT_LAST_HOURLY_KEY[shiftId]]?.is_locked`). Once saved/locked, the input is read-only until the row is unlocked.
  2. **Uncapped Efficiency**: Removed the 100% ceiling in `calcEffForEntry`, `calcUnitEfficiency`, and `calcWeightEfficiency`, displaying the exact calculated percentage across the quality monitor, PDF exports, and daily reports.
- **Files Touched**: `src/components/quality/ProductionQualityMonitor.tsx`, `src/components/quality/QualityReport.tsx`

## 10. Modular Lehr Out Timeline & Multi-Machine / Quality Report Duration Calculations
- **Issue**:
  1. Timeline calculation logic was tightly coupled to `ProductionQualityMonitor`, preventing other reporting views (`AllMachineReport`, `QualityReport`) from accurately calculating segment runtimes, shift averages, and midnight crossings.
  2. In `QualityReport` and `AllMachineReport`, durations for split rows or custom Lehr Out hours reverted to default 1-hour slots or failed across midnight, leading to discrepancies between the monitor and summary reports.
  3. On a brand-new production day, the 9:00 AM entry does not yet exist in the database; if the bottle matches the previous day's final job, the system generated an unnecessary new Job ID instead of preserving job continuity.
- **Fix**:
  1. **Shared Timeline Module**: Created `src/utils/layerOutTimeline.ts` providing pure, reusable functions: `buildLayerOutTimeline` (constructs ordered timeline slots handling variable durations, clamps, and midnight crossings) and `layerOutInputsFromSavedPeriods` (rebuilds per-shift Lehr Out values and carry-in minutes directly from saved period labels).
  2. **Report Accuracy**: Integrated `buildLayerOutTimeline` and `timelineSlots` parameter into `durationHoursForReportKey`, `splitMachineRuns`, and `runtimeMinutes` across `AllMachineReport.tsx` and `QualityReport.tsx`. Duration calculations now utilize absolute timeline minutes rather than modulo 1440.
  3. **Backend Carry-In & Job Continuity**: In `save_daily_quality`, pre-queries the previous day's report to compute authoritative carry-in durations for 9:00 AM rows even if the client lacked cached previous-day data. Also checks both database records and incoming payload to preserve continuous Job IDs across midnight.
- **Files Touched**: `src/utils/layerOutTimeline.ts`, `src/components/quality/AllMachineReport.tsx`, `src/components/quality/QualityReport.tsx`, `Backend/app/api/production/quality_daily.py`
