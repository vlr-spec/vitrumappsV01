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
