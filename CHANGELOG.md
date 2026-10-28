# Changelog

All notable changes to the Vitrum Glass Production Planning project are documented in this file.

## Entry Template
```markdown
### YYYY-MM-DD — <Title>
- **Problem:** <Description of bug, performance bottleneck, or missing capability>
- **Root Cause:** <Technical explanation of why it occurred>
- **Fix:** <Detailed description of implementation changes>
- **Files Changed:** <Relative file paths>
- **API or DB Impact:** <Any changes to contracts, schema, migrations, or HTTP codes>
```

---

### 2026-10-28 — Efficiency Precision Standardization (1 Decimal Place), Streamlined Shift-Wise Efficiency Card & Machine-Wise Totals with Visibility Toggle in Daily Production Performance Report
- **Problem:**
  - `ProductionQualityMonitor`:
    - Efficiency percentages formatted to two decimal places (`.toFixed(2)`) introduced visual clutter and did not conform to the operational plant standard of 1-decimal precision (`0.0%`).
  - `QualityReport`:
    - The upper "Shift-Wise Production & Efficiency Report" displayed redundant "Actual Production" columns (Shift 1, 2, and 3) that duplicated figures from the lower Daily Production Performance Report, occupied excessive horizontal space (100% width card), lacked cross-machine summary averages, and calculated machine Overall EFF% as a plain average of the three shift values rather than mirroring the Hourly Production Monitor's authoritative Day Avg / Summary rule.
    - In the "Daily Production Performance Report" (DPPR), each machine's runs lacked intermediate machine-level total rows, forcing supervisors to manually sum bottle runs for multi-job machines.
    - The DPPR row-level Overall EFF% and Grand Total Overall EFF% were disconnected from the upper Shift-Wise report's machine overall efficiencies.
    - Users had no mechanism to collapse or hide total rows when reviewing dense raw production schedules or preparing simplified printouts.
- **Root Cause:**
  - `calcEffForEntry` and `avgEff` formatted numbers with `.toFixed(2)`.
  - `QualityReport.tsx` had a wide dual-purpose table structure for Shift-Wise reporting, lacked machine total grouping logic, lacked synchronization with `shiftWiseRows` machine-level overall efficiency, and had no state toggle for totals visibility.
- **Fix:**
  - `src/components/quality/ProductionQualityMonitor.tsx`:
    - Standardized `calcEffForEntry` and summary `avgEff` to display efficiency rounded to one decimal place (`.toFixed(1)`).
  - `src/components/quality/QualityReport.tsx`:
    - Added helper `piecesEffForEntry` reproducing the Hourly Production Monitor's Pieces EFF% column (including 0% contribution for zero cartons on active jobs) formatted to one decimal place (`parseFloat(efficiency.toFixed(1))`).
    - Updated `fmtPctWhole` to format percentages to one decimal place (`${n.toFixed(1)}%`).
    - Streamlined the "Shift-Wise Production & Efficiency Report": removed redundant Actual Production columns, focused purely on efficiency (Shift 1, Shift 2, Shift 3, Overall EFF%), added an all-machine summary Total footer row calculating average shift and overall efficiencies, constrained container width to a compact 30% (`width: 30%, maxWidth: 30%`), and aligned machine Overall EFF% to the Hourly Production Monitor's Day Avg rule.
    - Introduced machine-level total rows (`Machine <M> Total`) beneath each machine's bottle runs in the Daily Production Performance Report, summing As Per Speed Units & Draw, Shift Units, Actual Units, and Actual Draw while inheriting machine overall efficiency from the Shift-Wise report (`machineOverallEff`).
    - Synchronized individual row Overall EFF% to display the machine's overall efficiency from `machineOverallEff`, and computed Grand Total Overall EFF% as the cross-machine arithmetic mean of the machine overall efficiencies (`grandOverallEff`).
    - Added an interactive "Hide Total" / "Show Total" button in the DPPR header (with screen hover states and `.no-print` exemption) that dynamically toggles the visibility of all machine-wise total rows and the Grand Total row simultaneously.
    - Added `.dppr-machine-total:hover` and `.dppr-grand-total:hover` CSS styling for both screen and print media queries.
- **Files Changed:**
  - `src/components/quality/ProductionQualityMonitor.tsx`
  - `src/components/quality/QualityReport.tsx`
- **API or DB Impact:**
  - Zero database schema changes. Zero API contract changes. Display formatting, layout optimization, and UI reporting enhancements only.

---

### 2026-10-26 — Quality Control Inspection Day Totals, 2-Decimal Efficiency Display & Job-Scoped Remarks in QualityReport
- **Problem:**
  - `ProductionQualityMonitor`:
    - Summary footer row in the UI table and exported PDF report left SQC, QC Hold, and NUM columns empty as spacer cells, providing operators and supervisors with no aggregate day totals for defect and hold volumes across the 24-hour cycle.
    - Efficiency percentages in both hourly rows and summary statistics were formatted to one decimal place (`.toFixed(1)`), lacking the two-decimal precision required by plant quality assurance.
  - `QualityReport`:
    - Remarks recorded in hourly production entries were aggregated machine-wide (`remarkByMachine`), causing remarks from one job to leak across all other jobs run on the same machine throughout that day.
    - Job start times derived start labels purely from previous hourly timeline slots without respecting actual minute-granular `period_start` timestamps (e.g., "9:17 AM", "12:38 PM") saved on the entry.
    - Segment efficiency was recomputed from cartons and theoretical targets rather than honoring the monitor's authoritative saved `efficiency_percentage`, and zero-carton production hours (where lines ran with valid bottle and speed but 0 cartons were packed) were excluded rather than contributing 0% to shift averages.
- **Root Cause:**
  - Statistics computation in `QualityControlModule` only summed cartons and bottles, lacking accumulators for numeric inspection metrics, and table/PDF summary formatters hardcoded blank spacer cells.
  - `calcEffForEntry` and summary `avgEff` used `.toFixed(1)`.
  - `QualityReport` grouped remarks by machine index rather than a composite key of machine, job, and bottle.
  - `QualityReport` lacked prioritization for the stored `efficiency_percentage` field and omitted zero-carton valid production rows from efficiency aggregations.
- **Fix:**
  - `src/components/quality/ProductionQualityMonitor.tsx`:
    - Implemented `sumNumericField` in `QualityControlModule` to calculate plain day sums for `sqc`, `qc_hold`, and `num` across all displayed rows, handling empty/null/non-numeric values gracefully while preserving legitimate 0 and positive counts.
    - Rendered formatted totals (`toLocaleString()`) in the summary footer row of the interactive UI table and PDF export body.
    - Updated `calcEffForEntry` and summary `avgEff` to display efficiency percentages rounded to two decimal places (`.toFixed(2)`).
  - `src/components/quality/QualityReport.tsx`:
    - Refactored remark handling to build a job-scoped map `remarkByJob` keyed by `${machineNo}|${jobId}|${bottleId}`. Remarks now strictly isolate to their originating job and bottle run, deduplicating chronological numbered entries and remaining empty if no remarks were logged for that specific job.
    - Updated `jobStartLabels` to check `entry.period_start` directly before falling back to timeline indices, preserving exact minute timestamps.
    - Updated segment efficiency in `QualityReport` to prioritize the authoritative stored `efficiency_percentage` from the hourly record (matching the Hourly Production Monitor), with fallback calculation that includes 0% efficiency when cartons = 0 on active bottle runs with valid speed.
- **Files Changed:**
  - `src/components/quality/ProductionQualityMonitor.tsx`
  - `src/components/quality/QualityReport.tsx`
- **API or DB Impact:**
  - Zero database schema changes. Zero API contract changes. Display formatting and report aggregation enhancements only.

---

### 2026-10-25 — Production Duration Calculation Enhancements in AllMachineReport & QualityReport
- **Problem:**
  - `QualityReport` and `AllMachineReport` suffered from duration calculation inaccuracies when custom Lehr Out times or split rows were present. Split segments could be miscalculated or double-counted, previous-day carry-in durations into the 9:00 AM hour were lost when the client lacked cached prior-day data, and midnight crossings could distort `runtimeMinutes`.
  - On a newly initialized production day, the 9:00 AM entry does not yet exist in the database; if the bottle matched the previous day's final job, the system generated an unnecessary new Job ID instead of continuing the existing run.
- **Root Cause:**
  - `durationHoursForReportKey` and `splitMachineRuns` relied purely on nominal hourly spacing without passing actual period interval slots.
  - Backend carry-in resolution in `save_daily_quality` relied on client-supplied labels rather than querying the previous day's authoritative ending timestamp, and job continuity logic checked only existing database records rather than the incoming payload.
- **Fix:**
  - `AllMachineReport.tsx` & `QualityReport.tsx`:
    - Updated `durationHoursForReportKey` and `splitMachineRuns` to accept actual `timelineSlots` computed from `period_start` and `period_end` via `buildLayerOutTimeline`.
    - Computed timeline slots using absolute timeline minutes (not modulo 1440), eliminating distortions across midnight and shift boundaries.
    - Updated `runtimeMinutes` to use actual slot boundaries (`endMin - startMin`) with graceful fallback to index ordering.
  - `Backend/app/api/production/quality_daily.py`:
    - Pre-queries the previous day's report in `save_daily_quality` to calculate authoritative carry-in durations for the 9:00 AM entry, ensuring consistent interval calculation even when the frontend lacks previous-day cache.
    - Extended job continuity logic to check both existing database entries and the incoming payload for 9:00 AM entries, preserving continuous Job IDs across midnight.
- **Files Changed:**
  - `Backend/app/api/production/quality_daily.py`
  - `src/components/quality/AllMachineReport.tsx`
  - `src/components/quality/QualityReport.tsx`
  - `src/components/dashboard/DashboardModule.tsx`
  - `src/App.tsx`
- **API or DB Impact:**
  - Zero database schema changes. Full backwards compatibility with existing stored records.

---

### 2026-10-24 — Modular Lehr Out Timeline Utility & Efficiency Reporting Refactor
- **Problem:**
  - Lehr Out timeline calculation logic was embedded directly within `ProductionQualityMonitor.tsx`, preventing reuse across reporting components and leading to code duplication and inconsistent timeline math.
- **Root Cause:**
  - Timeline logic had evolved organically inside the monitor component and was not decoupled into a shared pure utility module.
- **Fix:**
  - Created `src/utils/layerOutTimeline.ts` encapsulating:
    - `buildLayerOutTimeline`: Constructs ordered start/end timeline slots accounting for variable Lehr Out durations, boundary clamping (0–119 min), midnight transitions, and previous-day carry-in.
    - `layerOutInputsFromSavedPeriods`: Reconstructs per-shift Lehr Out values and carry-in minutes directly from saved `period_start` and `period_end` labels.
  - Refactored `ProductionQualityMonitor.tsx` and `QualityReport.tsx` to consume the shared timeline module.
- **Files Changed:**
  - `src/utils/layerOutTimeline.ts`
  - `src/components/quality/ProductionQualityMonitor.tsx`
  - `src/components/quality/QualityReport.tsx`
- **API or DB Impact:**
  - None. Pure frontend architectural refactoring.

---

### 2026-10-23 — Shift Lehr Out Lock & Uncapped Efficiency Display
- **Problem:**
  - Lehr Out inputs remained editable even after the shift's final hourly entry had been saved and locked.
  - Unit efficiency and weight efficiency across `ProductionQualityMonitor` and `QualityReport` were artificially capped at 100% (`Math.min(100, efficiency)`), masking over-speed and above-rated production performance.
- **Root Cause:**
  - Lehr Out inputs had no lock guard tied to row state.
  - Legacy calculation helpers enforced a hard `Math.min(100, ...)` ceiling.
- **Fix:**
  - Tied each shift's Lehr Out input disabled state to its final hourly row's lock state (`layerOutLocked = isFirstInShift && !!activeRows[SHIFT_LAST_HOURLY_KEY[shiftId]]?.is_locked`). Checked/saved final rows lock the input for that shift only.
  - Removed artificial 100% capping from `calcEffForEntry`, `calcUnitEfficiency`, and `calcWeightEfficiency`, displaying true calculated percentages as-is.
- **Files Changed:**
  - `src/components/quality/ProductionQualityMonitor.tsx`
  - `src/components/quality/QualityReport.tsx`
- **API or DB Impact:**
  - None.

---

### 2026-10-22 — Lehr Out Time Tracking & Zero-Schema Duration Persistence
- **Problem:**
  - Plant operators needed to track variable Lehr Out (annealing lehr clearance) times (0–119 min) for each shift's ending hour (4:00 PM, 12:00 AM, 8:00 AM), shifting subsequent shift start times and carrying 3rd-shift adjustments across the 9:00 AM day boundary.
  - Storing custom durations historically required adding database columns and running migrations across deployed PostgreSQL instances.
- **Root Cause:**
  - `hourly_production` schema lacked duration fields, and standard hourly spacing was assumed.
- **Fix:**
  - **Timestamp Microsecond Encoding**: Persisted non-standard segment durations directly into `hourly_production.production_time`'s `microsecond` field (`minutes * 1000` for standard durations <= 720 min, `(minutes - 1320) * 1000 + 500` for overflow <= 1440 min). Standard 60-minute entries keep `0` microseconds.
  - Query functions continue using `_norm_time` (stripping seconds and microseconds) for row identity, lock matching, and unique constraints `(production_time, machine_no, report_id)`.
  - Updated deletion matching in `save_daily_quality` to use normalized time-of-day rather than exact datetime equality.
  - Added `period_start` and `period_end` optional fields to `QualityHourlyEntrySchema` and `QualityEntryPayload`.
  - Added `VITE_API_BASE_URL` alongside `VITE_API_URL` in `.github/workflows/deploy.yml`.
- **Files Changed:**
  - `Backend/app/api/production/quality_daily.py`
  - `Backend/app/schemas/quality.py`
  - `src/services/qualityRepository.ts`
  - `src/components/quality/ProductionQualityMonitor.tsx`
  - `src/components/quality/QualityReport.tsx`
  - `.github/workflows/deploy.yml`
- **API or DB Impact:**
  - `GET /api/production/quality/daily/` and `POST /api/production/quality/daily/` support optional `period_start` and `period_end` string labels on hourly rows.
  - Zero database schema modifications, zero DDL migrations.

---

### 2026-10-16 — Snyk Security Vulnerability Remediations (Containers & Dependencies)
- **Problem:**
  - Snyk security scans detected container vulnerabilities (outdated base image in `Backend/Dockerfile`, vulnerable `zlib 1.3.2-r0` in frontend container) and 13 unique open-source issues in `package.json` / lockfiles including `proxy-addr` (Critical), `qs` (High/Medium), `brace-expansion` (High/Medium), `dompurify` (Medium XSS), and `traverse` (Medium prototype pollution).
- **Root Cause:**
  - Base images had older unpatched OS package snapshots.
  - Unused dependencies (`@google/genai`, `dotenv`, `express`, `@types/express`) were lingering in `package.json` with 0 actual code usage.
  - Older lockfile pins satisfied existing semver ranges but lacked recent security patch releases.
- **Fix:**
  - `Backend/Dockerfile`: Pinned base to `python:3.11-slim-trixie` and added an OS package upgrade layer (`RUN apt-get update && apt-get upgrade -y && rm -rf /var/lib/apt/lists/*`).
  - `Dockerfile`: Fixed build stage casing (`as build` → `AS build`) and added `RUN apk upgrade --no-cache` to upgrade `zlib` to `1.3.2-r1`.
  - `package.json`: Removed unused `@google/genai`, `dotenv`, `express`, and `@types/express` packages, eliminating `proxy-addr` (Critical) and `qs` (High/Medium).
  - `package.json`: Added a scoped override for `jspdf` to use `dompurify >= 3.4.16` (resolved to `3.4.17`), resolving both `dompurify` XSS vulnerabilities.
  - `package-lock.json` & `bun.lock`: Updated transitives to resolve `brace-expansion` to `1.1.21` (1.x) & `2.1.7` (2.x) and `traverse` to `0.3.10` within existing parent semver ranges.
  - Bundle audit: Verified that `unzipper`, `inflight`, `glob`, and `archiver` are completely absent from client bundles in `dist/`.
- **Files Changed:**
  - `Backend/Dockerfile`
  - `Dockerfile`
  - `package.json`
  - `package-lock.json`
  - `bun.lock`
  - `Changes.md`
  - `CHANGELOG.md`
- **API or DB Impact:**
  - Zero API, database schema, or application logic impact. All 40 pytest backend tests and frontend Vite builds pass cleanly.

---

### 2026-10-05 — Documentation Cleanup & Codebase Synchronization
- **Problem:**
  - `DOCUMENTATION.md` contained massive duplication (sections 3-6 repeated), conflicting statements regarding implemented quality features, broken markdown formatting, environment-specific CI paths, and lacked documentation for entire database schemas (`hpr.*`, `auth.*`, `job_master`, `machine_job_sequence`).
- **Root Cause:**
  - Cumulative manual additions and copy-paste appends during previous feature sprints left duplicated blocks and contradictory text.
- **Fix:**
  - Restructured `DOCUMENTATION.md` into 11 clean, verified sections matching the active code.
  - Documented full database schemas across `production`, `auth`, and `hpr` schemas.
  - Documented the live database-driven RBAC system (`auth.module_master` and `auth.user_module_permissions`).
  - Extracted the entire historical changelog into standalone `CHANGELOG.md` with standardized entry templates.
  - Converted unformatted 2026-08-21 `estimated_completion` rounding fix notes into a standardized changelog entry.
  - Documented a comprehensive Known Issues register with severity and impact ratings.
- **Correction:**
  - The `GET /health` `db_url` credential leak removal described in the 2026-10-02 changelog entry was not present in the live codebase at audit time; `Backend/app/main.py` continued returning `settings.DATABASE_URL`. This remains an open critical security vulnerability tracked in the Known Issues register pending deployment of a dedicated backend fix.
- **Files Changed:**
  - `DOCUMENTATION.md`
  - `CHANGELOG.md`
- **API or DB Impact:**
  - Documentation-only change. No application code, database schema, or APIs were modified.

### 2026-10-05 — Fix 500 Date Query Filter Error in Jobs Endpoint & Model Type Alignment
- **Problem:**
  - `GET /api/production/jobs/?from_date=2026-09-25&to_date=2026-10-25` failed with a 500 Internal Server Error on deployed environments running PostgreSQL with `psycopg3`:
    ```
    sqlalchemy.exc.ProgrammingError: (psycopg.errors.UndefinedFunction) operator does not exist: date >= character varying
    WHERE production_job.plan_date >= $1::VARCHAR AND production_job.plan_date <= $2::VARCHAR
    parameters: {'plan_date_1': '2026-09-25', 'plan_date_2': '2026-10-25'}
    ```
- **Root Cause:**
  - Date query parameters `from_date` and `to_date` were defined as raw strings (`Optional[str] = None`) in `get_all_jobs` and directly compared in SQLAlchemy filters (`ProductionJob.plan_date >= from_date`). In `psycopg3` (used on Render via `psycopg[binary]`), string parameters are typed strictly as `VARCHAR` (`$1::VARCHAR`), and PostgreSQL has no built-in `date >= character varying` operator.
- **Fix:**
  - `Backend/app/api/production/jobs.py` (`get_all_jobs`):
    - Changed `from_date` and `to_date` query parameter types from `Optional[str]` to `Optional[date]`, allowing FastAPI/Pydantic to automatically parse and validate ISO date strings (`YYYY-MM-DD`).
    - Added defensive string coercion with `date.fromisoformat()` for any direct Python function invocations.
    - Added input validation returning HTTP 422 for invalid date strings (instead of 500) and HTTP 422 if `from_date > to_date` (`"from_date must be less than or equal to to_date"`).
    - Bound native Python `datetime.date` objects to the SQLAlchemy filter expressions (`ProductionJob.plan_date >= parsed_from`, `ProductionJob.plan_date <= parsed_to`), allowing `psycopg3` to pass native PostgreSQL `DATE` parameters (`$1::DATE`).
  - `Backend/app/models/job.py` (`JobMaster`):
    - Changed `JobMaster.job_id` from `Column(Integer, ...)` to `Column(BigInteger, ...)` to match the live PostgreSQL column type (`bigint NOT NULL`) and align with `ProductionJob.job_id` and `JobPackaging.job_id`.
  - Backend Audit & CI Dependency Fix:
    - Audited all routers and services across the entire backend (including quality, HPR, machine master, and auth). Confirmed that all other date-based queries parse strings into `datetime.date` or `datetime` objects before querying, leaving `get_all_jobs` as the sole unparsed date filter.
    - Added `httpx==0.27.0` to `Backend/requirements.txt`. FastAPI's `TestClient` (via `starlette.testclient`, used in `Backend/tests/test_jobs_date_filter.py`) requires `httpx`. Resolved CI test collection failure on GitHub Actions where `httpx` was absent during `pip install -r Backend/requirements.txt`.
- **Files Changed:**
  - `Backend/app/api/production/jobs.py` (function `get_all_jobs`)
  - `Backend/app/models/job.py` (model `JobMaster`)
  - `Backend/requirements.txt`
  - `DOCUMENTATION.md`
- **API Behaviour:**
  - Response format is completely unchanged: `ProductionJobResponse.plan_date` remains typed as `date`, serializing to standard `"YYYY-MM-DD"` ISO string format so the frontend planning grid, Excel export, and PDF export operate with zero changes.
  - New validation responses: Malformed date strings return HTTP 422 Unprocessable Entity; inverted date ranges (`from_date > to_date`) return HTTP 422.
- **Rule for Future Development:**
  - Always parse and type date query parameters as `date` or `datetime` before using them in database filters. Never compare SQLAlchemy `Date` or `DateTime` columns against raw strings.
- **Strict Scope Verification:**
  - No frontend code was modified.
  - No database or schema changes were made (no DDL, no migrations, no ALTER).
  - Gob calculation was untouched.

### 2026-10-02 — Weight Efficiency (% WT EFF), Shift Panel Removal & Auto-Migration
- **What changed:**
  - `src/components/quality/ProductionQualityMonitor.tsx`: Added Weight Efficiency (% WT EFF) calculation and column to the quality inspection grid; removed the redundant manual shift panel to streamline inspector workflows.
  - `Backend/app/main.py`: Added `_ensure_hourly_production_weight_efficiency_column()` to automatically detect and execute `ALTER TABLE hpr.hourly_production ADD COLUMN weight_efficiency NUMERIC(10, 2)` on database initialization if the column is absent on pre-existing RDS instances.
  - `Backend/app/main.py`: Hardened the `/health` endpoint to eliminate plain-text credential leaks (`db_url`), implementing a non-blocking database ping (`SELECT 1`) returning `status: "healthy"` and `database: "connected"`.
  - Hidden internal database entry IDs from operator view in the quality table.
  - Added Daily Production Performance Report in Quality module with job ID synchronization fixes.
- **Files changed:** `src/components/quality/ProductionQualityMonitor.tsx`, `Backend/app/main.py`, `src/services/qualityRepository.ts`
- **Why:** Delivers real-time Weight Efficiency data during bottle inspection, automates schema safety across database deployments, and closes security exposure on public health endpoints.

### 2026-09-30 — Planning Grid Tooltip Optimization & Calendar Date Header Refinement
- **What changed:**
  - `src/components/planning/ProductionPlanningPage.tsx`: Disabled heavy hover tooltips on the production planning grid cells to reduce DOM re-renders and boost rendering speed.
  - Refined calendar header date formatting, font scaling, and color contrasting for better visibility on plant floor display screens.
  - `src/components/master-management/BottleMasterPanel.tsx`: Improved responsive UI layout, button spacing, and grid alignment.
- **Files changed:** `src/components/planning/ProductionPlanningPage.tsx`, `src/components/master-management/BottleMasterPanel.tsx`
- **Why:** Eliminates browser frame drops and stutter when navigating large monthly planning registers.

### 2026-09-29 — Auto-Save in Planning & Quality, Branded Company Report Headers & Database-Driven RBAC
- **What changed:**
  - `src/components/planning/ProductionPlanningPage.tsx`: Added auto-save with debounce and optimistic local state updates, automatically persisting machine schedule edits in the background.
  - `src/components/quality/ProductionQualityMonitor.tsx`: Added auto-save for hourly production entries, defects, and carton counts.
  - `src/utils/reportHeader.ts`: Built a centralized report header utility that injects company branding, legal name, address, and document timestamps across all PDF and Excel exports.
  - `Backend/app/api/access.py` & `Backend/app/api/permissions.py`: Implemented database-driven role-based access control (RBAC). Endpoints enforce `require_module_read` and `require_module_edit` based on dynamic permissions in `auth.module_master` and `auth.user_module_permissions`.
  - `Backend/app/models/auth.py`: Isolated auth models (`AuthUser`, `ModuleMaster`, `UserModulePermission`) onto a separate `AuthBase` DeclarativeBase so `Base.metadata.create_all()` never alters server-managed auth schema tables.
- **Files changed:** `src/components/planning/ProductionPlanningPage.tsx`, `src/components/quality/ProductionQualityMonitor.tsx`, `src/utils/reportHeader.ts`, `src/utils/exportData.ts`, `Backend/app/api/access.py`, `Backend/app/api/permissions.py`, `Backend/app/models/auth.py`, `src/context/AuthContext.tsx`
- **Why:** Prevents accidental data loss, creates standardized executive-ready PDF/Excel printouts, and enforces dynamic security boundaries across modules.

### 2026-09-28 — Quality Module Operationalization & Bottle Configuration Fixes
- **What changed:**
  - `src/components/quality/ProductionQualityMonitor.tsx`: Full operationalization of the Quality Control module with dynamic defect dropdowns, hourly inspection inputs, carton counts, and PostgreSQL `hpr.hourly_production` persistence.
  - `Backend/app/api/production/quality_daily.py`: Added validation for hourly bottle configs and shift supervisor assignments.
  - `src/components/master-management/BottleMasterPanel.tsx`: Resolved bottle selection dropdown lag and ensured section-specific weight and speed values persist correctly.
- **Files changed:** `src/components/quality/ProductionQualityMonitor.tsx`, `src/components/master-management/BottleMasterPanel.tsx`, `Backend/app/api/production/quality_daily.py`
- **Why:** Delivers end-to-end quality inspection tracking directly integrated with the live manufacturing line.

### 2026-09-26 — Dedicated Bottle Export Panel & Machine-Specific Bottle Configurations
- **What changed:**
  - `src/components/master-management/BottleExportPanel.tsx`: Added dedicated export panel supporting full Excel and PDF generation for all bottle specifications and machine section configurations.
  - `src/components/master-management/BottleMasterPanel.tsx`: Enabled machine-specific bottle configurations (weight, speed, section settings) and resolved dropdown width clipping.
  - Restructured architecture: Reorganized master panels into `src/components/master-management/` (`BottleMasterPanel`, `BottleExportPanel`, `HolidayMasterPanel`, `MachinesModule`).
- **Files changed:** `src/components/master-management/BottleExportPanel.tsx`, `src/components/master-management/BottleMasterPanel.tsx`, `src/components/master-management/HolidayMasterPanel.tsx`, `src/components/master-management/MachinesModule.tsx`
- **Why:** Allows production engineers to export bottle catalogs and calibrate machine speeds per individual physical section.

### 2026-09-25 — Sliding Session Timeout, Average Draw Metrics & End Job Timing Fixes
- **What changed:**
  - `Backend/app/api/auth.py`: Implemented sliding idle session timeout (`SESSION_IDLE_TIMEOUT_DAYS = 30`), renewing session tokens on every authenticated request so active operators are never logged out mid-shift.
  - `src/utils/exportData.ts`: Added Average Draw calculations to export summaries and print reports.
  - `src/components/planning/EndJobModal.tsx`: Fixed completion time calculation and furnace draw estimation when terminating a job early or on schedule.
- **Files changed:** `Backend/app/api/auth.py`, `src/utils/exportData.ts`, `src/components/planning/EndJobModal.tsx`
- **Why:** Eliminates disruptive session timeouts during long plant shifts and provides accurate furnace tonnage draw metrics.

### 2026-09-24 — User-Based Authentication, Cascading Job Time Shifts & Edit Locks
- **What changed:**
  - `Backend/app/api/auth.py`: Switched to database-backed user authentication against `auth.users`, supporting login via Employee ID, email, or registered phone number.
  - `src/components/planning/ProductionPlanningPage.tsx`: Implemented forward-cascading schedule adjustments — updating an earlier job automatically cascades forward and shifts the start dates and times of subsequent scheduled jobs on that machine.
  - Locked extended job segments from unauthorized direct edits; configured deletion cascade to update dependent sequence runs.
- **Files changed:** `Backend/app/api/auth.py`, `src/components/planning/ProductionPlanningPage.tsx`, `src/services/planningRepository.ts`
- **Why:** Guarantees chronological schedule integrity across machine runs when operational delays occur.

### 2026-09-22 – 2026-09-23 — Planning UI Enhancements, Ctrl+S Shortcut & Dynamic CI Workflow
- **What changed:**
  - `src/components/planning/ProductionPlanningPage.tsx`: Added `Ctrl+S` keyboard shortcut for fast planning saves; added Cumulative Quantity column; updated weight and cut terminology.
  - `src/components/planning/EndJobModal.tsx`: Set default completion time to 9:00 AM with minute-level adjustment steppers; disabled edit/end buttons during invalid states.
  - `.github/workflows/ci.yml`: Dynamically resolved repository owner (`${{ steps.repo.outputs.owner }}`) to ensure automated container builds succeed on any GitHub fork or namespace.
- **Files changed:** `src/components/planning/ProductionPlanningPage.tsx`, `src/components/planning/EndJobModal.tsx`, `.github/workflows/ci.yml`
- **Why:** Improves daily ergonomics for production planners and ensures CI/CD pipeline portability.

### 2026-09-17 – 2026-09-21 — Core Architecture: Bulk API Fetching, SQLite Index Fix & HPR Integration
- **What changed:**
  - `Backend/app/api/production/jobs.py`: Optimized API queries to fetch in bulk and return essential fields only, drastically reducing payload sizes and network latency.
  - `Backend/app/models/job.py`: Fixed duplicate index on `ProductionJob.job_id` under SQLite.
  - Set default job start time to 7:00 AM (shift start).
  - Improved multi-day and month-boundary job extension handling.
  - Connected quality backend (`hpr_job`, `hourly_production`, `shift_master`, `defect_master`).
- **Files changed:** `Backend/app/api/production/jobs.py`, `Backend/app/models/job.py`, `src/services/planningRepository.ts`
- **Why:** Eliminated UI lag during month switches, resolved database transaction conflicts, and integrated the quality reporting backend.

### 2026-09-16 — Quality Module: Add Backend job_id Support & Efficiency Bounds Protection
- **What changed:**
  - `Backend/app/models/quality.py`:
    - Added `job_id = Column(String(20), nullable=True)` to `HourlyProduction` model directly following `remarks`. Note: Treated as a standalone string label, not a Foreign Key constraint.
  - `Backend/app/schemas/quality.py`:
    - Added `job_id: Optional[str] = None` to `QualityHourlyEntrySchema` so Pydantic accepts `job_id` on POST payloads and serializes it on GET responses.
  - `Backend/app/api/production/quality_daily.py`:
    - Added `job_id=None` in `get_default_shape(...)`.
    - Added `job_id=entry.job_id` in `get_daily_quality(...)` response mapping.
    - Added `job_id=entry_data.job_id` in `save_daily_quality(...)` create and update branches.
    - Clamped `efficiency_percentage` between `0.0` and `999.99` (`round(min(max(float(eff), 0.0), 999.99), 2)`) before saving to prevent PostgreSQL `NumericValueOutOfRange` (overflow) errors on the DB column `NUMERIC(5, 2)`.
- **Files changed:** `Backend/app/models/quality.py`, `Backend/app/schemas/quality.py`, `Backend/app/api/production/quality_daily.py`
- **Why:** 
  1. Closes the persistence gap where frontend-generated sequential job identifiers (`J001`, `J002`, etc.) were silently dropped on save and cleared on reload.
  2. Guards the database transaction against 500 errors when extreme efficiency calculations occur from test carton inputs.

### 2026-09-11 — Compute and Persist weight_avg, bottles_in_nos, and efficiency_percentage in Save Payload
- **What changed:**
  - `src/components/quality/ProductionQualityMonitor.tsx`:
    - Extracted and unified shared calculation helpers: `calcBottlesInNosFor(e)`, `calcRowAvgFor(e, machineNo)`, and `calcEffFor(e, machineNo)` matching the exact on-screen display formulas.
    - Updated the on-screen BOTTLES IN NOS table cell to use the shared `calcBottlesInNosFor(entry)` helper function.
    - In `handleSave()`, mapped each hourly entry across all machines to calculate and populate `weight_avg`, `bottles_in_nos`, and `efficiency_percentage` using these shared formulas before dispatching to `qualityRepository.save()`.
    - Maintained strict null handling: when formula inputs are absent/empty, the helpers return empty strings so `toNumOrNull` sends `null` to the backend and database, avoiding 0 or NaN values.
- **Files changed:** `src/components/quality/ProductionQualityMonitor.tsx`
- **Why:** Resolved issue where `weight_avg`, `bottles_in_nos`, and `efficiency_percentage` displayed accurately on screen but were persisted as `NULL` in `hpr.hourly_production` because they were previously computed solely inside JSX render expressions and never included in the hourly payload.

### 2026-09-11 — Re-Apply Dynamic Defect Master Endpoint Fetch in Quality Monitor
- **What changed:** Re-applied dynamic defect master fetching lost in the reset to `origin/main`:
  - `src/services/qualityRepository.ts`: Added `DefectMasterItem` interface and `getDefects(activeOnly: boolean)` calling `GET /api/production/quality/defects/?active_only=true`.
  - `src/components/quality/ProductionQualityMonitor.tsx`: Deleted static `DB_DEFECT_MASTER` constant. Added `useEffect` on mount to fetch active defects from `qualityRepository.getDefects(true)`, dynamically grouping by `defect_type` (`Critical`, `Major`, `Minor`) and sorting by `defect_sr`. Updated `DefectDropdown` to accept `defectGroups` and `isLoading` props. Updated all filtering, badge color group lookups, and table cell defect name resolution to use live `defectGroups`.
- **Files changed:** `src/services/qualityRepository.ts`, `src/components/quality/ProductionQualityMonitor.tsx`
- **Why:** Re-established dynamic synchronisation with database defect definitions, eliminating 400 "Unresolvable defect names" errors caused by discrepancies between hardcoded frontend names and database records.

### 2026-09-11 — Re-Apply URL Hash Module Persistence & Logout State Reset
- **What changed:** Re-applied frontend navigation fixes lost in the reset to `origin/main`:
  - `src/context/ERPContext.tsx`: Re-added `getModuleFromHash` and bidirectional slug mappings (`production`, `quality`, `master-management`, `machines`, `settings`, `profile`, `dashboard`). Initialized `activeModule` state via `useState<ActiveModule>(getModuleFromHash)`. Added `setHashForModule` and wired it into `setActiveModule` and a mount/change `useEffect` hook to guarantee persistent URL synchronization across page reloads and StrictMode remounts.
  - `src/context/AuthContext.tsx`: Added explicit URL hash clearing (`history.replaceState`) inside the `finally` block of `logout()` so logging out resets the browser URL to root without lingering module hashes.
- **Files changed:** `src/context/ERPContext.tsx`, `src/context/AuthContext.tsx`
- **Why:** Re-established reliable active module persistence across multiple browser refreshes and ensured clean URL resets upon user logout following the reset to origin/main.

### 2026-09-10 — Quality Module Schema Alignment & Pydantic Validation Fixes
- **What changed:** Updated `QualityHourlyEntrySchema` in `Backend/app/schemas/quality.py` to match the frontend request shape and database column types:
  - Strongly typed `bottle_id`, `section`, `cartons`, `bottles_in_nos`, and `num` as `Optional[int]`.
  - Strongly typed `weight_front`, `weight_middle`, `weight_rear`, `weight_avg`, and `speed_per_min` as `Optional[float]`.
  - Renamed schema field `efficiency_percent` to `efficiency_percentage: Optional[float] = None` to match the frontend JSON key, and updated `Backend/app/api/production/quality_daily.py` to map between the frontend field and the underlying DB column `efficiency_percent`.
  - Accepted `packing_category` as `List[str] = []` on the schema, converting to a comma-separated string `", ".join(...)` on DB insertion and splitting back into a `List[str]` in `get_daily_quality`.
  - Coerced `sqc` and `packing_size` to strings via a `@field_validator(..., mode='before')` to safely bridge the database integer column types with frontend string expectations without validation errors.
- **Files changed:** `Backend/app/schemas/quality.py`, `Backend/app/api/production/quality_daily.py`
- **Why:** Resolved 422 Unprocessable Entity errors during `POST /api/production/quality/daily/` and 500 response serialization errors caused by schema type mismatches with the database and frontend.

### 2026-08-24 — Show yield-adjusted Good Bottles in grid Qty column
- **What changed:** Applied the `calcGoodBottles` (90% yield factor) to the raw quantity returned by `calculateQuantityForProductionDay` in `getDailyProducedQty`.
- **Files changed:** `src/components/planning/ProductionPlanningPage.tsx`
- **Why:** To make the main grid's Qty column match the yield-adjusted "Daily Good Bottles (90%)" shown in the tooltip for better readability.

### 2026-08-22 — Fix holiday highlighting logic on production grid
- **What changed:** Added a useEffect hook to fetch holiday data on component mount and stored it in state, resolving an issue where the holiday cache was empty and dates weren't highlighted on initial load.
- **Files changed:** `src/components/planning/ProductionPlanningPage.tsx`
- **Why:** The holiday highlight existed but the fetching function was never invoked when loading the planning grid, so the cache was always empty.

### 2026-08-21 — Fix estimated_completion Minute Rounding Error (21:60)
- **Problem:**
  - The `handleSaveToDb` function in `src/components/planning/ProductionPlanningPage.tsx` contained a rounding bug that generated invalid time strings like `"21:60"`, triggering backend HTTP 422 Unprocessable Entity errors when persisting jobs.
- **Root Cause:**
  - Fractional minute calculation used `Math.round(totalMins % 60)`. When `totalMins % 60` was `59.5` or higher, rounding returned `60` instead of rolling over to the next hour, producing timestamps with 60 minutes and violating ISO/time validation rules.
- **Fix:**
  - Rounded `totalMins` before decomposing into hours and minutes:
    ```ts
    const roundedTotalMins = Math.round(totalMins);
    const ch = Math.floor(roundedTotalMins / 60) % 24;
    const cm = roundedTotalMins % 60;
    ```
  - Ensured `cm` strictly remains in the valid `0-59` integer range.
- **Files Changed:**
  - `src/components/planning/ProductionPlanningPage.tsx`
- **API or DB Impact:**
  - Eliminates client-side generation of invalid ISO timestamps, preventing HTTP 422 validation rejections on `POST /api/production/jobs/`.

### 2026-08-20 — Fix 500 Error on Job Deletion
- **What changed:** Parsed the `plan_date` and `start_time` string parameters into a proper Python `datetime` object before querying the database, fixing a Postgres type mismatch error when deleting jobs.
- **Files changed:** `Backend/app/api/production/jobs.py`
- **Why:** To resolve an `InvalidDatetimeFormat` error preventing job deletions.
