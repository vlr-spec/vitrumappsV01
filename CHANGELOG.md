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

### 2026-10-06 — Remove Legacy production.users Table and Model from Backend
- **Problem:**
  - The application previously maintained two user models and tables: `auth.users` (`AuthUser`) as the authoritative authentication source, and `production.users` (`User`) as a legacy mirror storing display `department` and `role`. This caused dual inserts, dual password updates, and database fragmentation.
- **Root Cause:**
  - Historical transition to database-driven RBAC left the legacy `production.users` table partially coupled into signup, profile, and change-password flows.
- **Fix:**
  - Deleted `Backend/app/models/user.py` entirely and removed the `User` model import from `Backend/app/main.py` so `Base.metadata.create_all()` never recreates `production.users`.
  - Removed the `ForeignKey` to `users.employee_id` in `Backend/app/models/audit_log.py` (`user_id = Column(String, nullable=True)`).
  - Updated `Backend/app/api/auth.py`:
    - Removed `ProductionUser` import and queries.
    - Updated `SignupRequest` to accept optional `department` and `role` fields (ignored on save) to maintain backwards compatibility with existing frontend forms.
    - Updated `signup()` to enforce unique case-insensitive email and unique employee ID checks exclusively against `AuthUser`, inserting only into `auth.users`.
    - Updated `user_response()` to return fixed compatibility values (`"department": ""` and `"role": "Viewer"`).
    - Updated `change_password()` to update password strictly on `AuthUser`.
  - Added test suite `Backend/tests/test_zz_auth.py` verifying full auth workflows against `AuthUser` only and confirming complete absence of `production.users` in `Base.metadata`.
- **Files Changed:**
  - `Backend/app/models/user.py` (deleted)
  - `Backend/app/main.py`
  - `Backend/app/models/audit_log.py`
  - `Backend/app/api/auth.py`
  - `Backend/tests/test_zz_auth.py`
  - `DOCUMENTATION.md`
  - `CHANGELOG.md`
- **API or DB Impact:**
  - `auth.users` is now the sole source of truth for users in the backend.
  - `department` and `role` are intentionally not migrated to `auth.users`; the API preserves contract shape by returning `"department": ""` and `"role": "Viewer"`.
  - The database team can safely drop `production.users` without breaking backend boot or runtime queries.

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
