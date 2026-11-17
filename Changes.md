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

## 11. Quality Control Day Totals (SQC, QC Hold, NUM), Two-Decimal Efficiency Precision & Job-Scoped Remarks
- **Issue**:
  1. In `ProductionQualityMonitor`, the summary footer row in both the interactive UI table and PDF exports left SQC, QC Hold, and NUM columns blank, depriving supervisors of daily aggregate totals for quality inspections, hold counts, and defect volumes.
  2. Efficiency percentages in `ProductionQualityMonitor` were displayed with only one decimal place (`.toFixed(1)`), which was insufficient for plant quality engineering precision requirements.
  3. In `QualityReport`, hourly remarks were aggregated at the machine level, causing remarks entered for one job to display across all other jobs on that machine. Additionally, start times ignored custom minute-level `period_start` values, and shift efficiency recalculated from cartons instead of using the authoritative stored `efficiency_percentage` from the Hourly Production Monitor (excluding 0% intervals during line clearings).
- **Fix**:
  1. **SQC, QC Hold & NUM Day Totals**: Added `sumNumericField` in `QualityControlModule` to calculate daily sums for `sqc`, `qc_hold`, and `num` across all displayed rows. Rendered formatted totals (`toLocaleString()`) in both the table footer summary row and the exported PDF summary.
  2. **Two-Decimal Efficiency Display**: Formatted hourly efficiency and summary average efficiency to two decimal places (`.toFixed(2)`) across `ProductionQualityMonitor`, preserving underlying floating-point values for persistence.
  3. **Job-Scoped Remarks in QualityReport**: Replaced machine-wide remark aggregation with a job-scoped map keyed by `machineNo|jobId|bottleId`. Each job now displays only its own chronological, deduplicated numbered remarks without cross-job pollution.
  4. **Minute-Granular Period Starts & Authoritative Efficiency**: Updated `jobStartLabels` to use `entry.period_start` directly when present. Updated segment efficiency to prioritize stored `efficiency_percentage` from the hourly record and handle zero-carton runs as 0% efficiency when bottle and speed are valid.
- **Files Touched**: `src/components/quality/ProductionQualityMonitor.tsx`, `src/components/quality/QualityReport.tsx`

## 12. Efficiency Precision Standardization (1 Decimal Place), Streamlined Shift-Wise Card & Machine-Wise Totals Toggle
- **Issue**:
  1. Efficiency percentages formatted to two decimal places in `ProductionQualityMonitor` clashed with the standard 1-decimal plant reporting format (`0.0%`).
  2. In `QualityReport`, the upper "Shift-Wise Production & Efficiency Report" duplicated production counts already shown in the lower Daily report, took up the full screen width, lacked an all-machine cross-shift average summary row, and did not align machine Overall EFF% with the Hourly Production Monitor's Day Avg rule.
  3. The Daily Production Performance Report (DPPR) lacked machine-level subtotal rows for multi-job machines, lacked visual alignment between row-level Overall EFF% and the machine's overall efficiency from the Shift-Wise report, and provided no way for supervisors to hide summary total rows when inspecting raw job data or printing compact forms.
- **Fix**:
  1. **Standardized 1-Decimal Precision**: Reverted `.toFixed(2)` to `.toFixed(1)` across `ProductionQualityMonitor.tsx` (`calcEffForEntry`, summary `avgEff`) and `QualityReport.tsx` (`fmtPctWhole`, `piecesEffForEntry`, Shift-Wise Total row).
  2. **Streamlined Shift-Wise Report**: Dropped duplicate Actual Production columns to focus entirely on shift efficiencies (Shift 1, Shift 2, Shift 3, Overall EFF%); added a bottom "Total" row averaging shift and overall efficiencies across all machines; reduced card container width to a clean, left-aligned 30% (`width: 30%, maxWidth: 30%`); and aligned machine `overallEff` calculation to the Hourly Production Monitor's Day Avg / Summary rule.
  3. **Machine-Wise Totals & Unified Overall EFF%**: Added machine subtotal rows (`Machine <M> Total`) beneath each machine's bottle runs in the DPPR summing As-Per-Speed and actual units and draw; synchronized individual row and machine total Overall EFF% to the authoritative `machineOverallEff` from the upper Shift-Wise report; and set Grand Total Overall EFF% to the arithmetic mean across machines (`grandOverallEff`).
  4. **Interactive Totals Toggle**: Added a "Hide Total" / "Show Total" button in the DPPR header (styled with hover transitions and marked `.no-print`) that toggles the visibility of all machine-wise total rows and the Grand Total row simultaneously.
- **Files Touched**: `src/components/quality/ProductionQualityMonitor.tsx`, `src/components/quality/QualityReport.tsx`

## 13. QualityReport Layout & Calculation Refinements: Machine Wise Production and Efficiency Naming, Runtime Minutes in Machine Subtotals, Row-Wise Overall Efficiency, and Centered Shift-Wise Card
- **Issue**:
  1. In `QualityReport`, the main table header was labeled "Daily Production Performance Report", whereas plant operational nomenclature requires "Machine Wise Production and Efficiency".
  2. The upper summary card retained the old title "Shift-Wise Production & Efficiency Report" with a separate inner header bar, left alignment (`marginLeft: 0`), right-aligned numeric cells, and column header "Efficiency %", rather than being a clean, centered shift efficiency overview.
  3. In the machine subtotal rows (`Machine <M> Total`), the Runtime (Min) column was rendered as an empty cell (`<td style={td}></td>`), missing the aggregate operational minutes across the machine's runs.
  4. In the main table's individual bottle/job rows, the "Overall" efficiency column was displaying the entire machine's day-wide overall efficiency (`machineOverallEff`) rather than calculating the specific bottle run's own overall efficiency across its active shifts.
  5. The efficiency formatting helper `fmtEff` retained a 2-decimal fallback (`.toFixed(2)`), conflicting with the plant-standard 1-decimal efficiency display (`0.0%`).
- **Fix**:
  1. **Report Titles & Layout Polish**: Renamed the main report table header to "Machine Wise Production and Efficiency" and the upper card to "Shift-Wise Efficiency Report" with column header "Shift Efficiency %". Removed the redundant inner header bar from the Shift-Wise card, horizontally centered the container (`marginLeft: 'auto', marginRight: 'auto'`), and centered efficiency percentage values within table cells (`textAlign: 'center'`).
  2. **Runtime Minutes in Machine Subtotals**: Added `runtimeMinutes` aggregation to `machineTotals` (summing runtime across all runs for each machine) and rendered the total minutes in bold (`mt?.runtimeMinutes ? mt.runtimeMinutes : '—'`) in the `Machine <M> Total` row.
  3. **Row-Wise Overall Efficiency**: Updated individual bottle rows to compute their own row-level Overall Efficiency (`rowOverallEff`) by averaging only their available Shift I, II, and III efficiencies (`averageEfficiency(r.shiftEff.filter(v => v !== null))`), ignoring unworked shifts rather than penalizing as 0%. The machine total row continues to display the authoritative whole-machine overall efficiency.
  4. **Strict 1-Decimal Formatting**: Updated `fmtEff` in `QualityReport.tsx` to format all efficiency percentages with one decimal place (`n.toFixed(1)`).
- **Files Touched**: `src/components/quality/QualityReport.tsx`

## 14. Responsive Shift-Wise Card Styling, Clean White Machine Rows, and Spaced Subtotals in Machine Wise Production and Efficiency Report
- **Issue**:
  1. In `QualityReport`, the fixed 30% width of the Shift-Wise Efficiency card squeezed columns or triggered awkward horizontal overflow on tablet and mobile viewports.
  2. Main body rows in the Machine Wise Production and Efficiency report table used pastel tint backgrounds per machine (`#EFF6FF`, `#F0FDF4`, `#FFFBEB`, `#F5F3FF`), creating unnecessary visual noise in high-density production data grids.
  3. Machine subtotal rows and the grand total row lacked visual separation from adjacent data rows, making it harder for plant supervisors to quickly scan individual machine boundaries.
- **Fix**:
  1. **Responsive Card Container & Contained Scrolling**: Added `.dppr-sw-card` and `.dppr-sw-scroll` CSS classes with responsive breakpoints: 30% width on desktop, 45% on viewports $\le 1200\text{px}$, 70% on viewports $\le 900\text{px}$, and 100% width on viewports $\le 640\text{px}$ with a minimum table width of 400px and smooth contained horizontal scrolling.
  2. **Standardized Clean White Body Rows**: Standardized `MACHINE_ROW_BG` across all four machines to clean `#ffffff`, updating hover states to subtle light blue tints (`#eff6ff` on machine subtotals and `#dbeafe` on the grand total).
  3. **Visual Spacer Rows**: Added dedicated 6px transparent spacer rows (`aria-hidden="true"`) beneath each `Machine <M> Total` row and the `Grand Total` row for clear visual partitioning. Highlighted the bottom Shift-Wise Total row's overall efficiency cell with `#dbeafe` background and `#93c5fd` top border.
- **Files Touched**: `src/components/quality/QualityReport.tsx`

## 15. Re-Packing Report Dashboard (Numbering & SQC/QC Hold Layouts), Direct Main Navbar Access, Dynamic Job-Grouped Row Insertion/Removal, Manual 12-Hour Time Picker & GOB Field Integration
- **Issue**:
  1. Glass production and quality assurance operations required a dedicated re-sorting and re-packing workflow to monitor packing outputs, defect counts, defective bottles, lot numbers, moulds, sections, and QA inspections under two standard operational formats: "NUMBERING" and "SQC/QC HOLD".
  2. Plant supervisors needed direct access to both NUMBERING and SQC/QC HOLD views straight from the main navigation bar without complex nested menus or state loss during tab switches.
  3. Production jobs frequently encounter multiple re-sorting intervals or defect events per bottle run. Operators needed the ability to dynamically insert additional inspection rows immediately beneath the active bottle run (grouped under that specific bottle) and remove manually added rows, while ensuring core production runs loaded from the Hourly Production Monitor remained immutable.
  4. Inspection times for re-packing operations represent manual observation events and must never be auto-filled or inferred from scheduled machine production intervals.
  5. QA teams required logging the GOB number alongside Section and Mould for both Numbering and SQC/QC Hold records to provide complete mould equipment traceability.
- **Fix**:
  1. **Two-Layout Re-Packing ERP Dashboard (`Re-PackingReport.tsx`)**: Created a modern, modular report component displaying 4 machine cards with subtle borders, rounded corners, and blue (#2563EB) accents. Automatically detects continuous same-bottle runs from the selected date's HPR records via `qualityRepository.load(date)`:
     - **NUMBERING Layout (13 Columns)**:
       `Job Name` | `Shift` | `Time` | `Pcs/Pack` | `Cartons` | `Defective Bottles` | `Defects` | `Lot No.` | `Mould` | `Section No.` | `GOB` | `Checker Name` | `QA-Shift Ex.`
     - **SQC/QC HOLD Layout (13 Columns)**:
       `Shift` | `Time` | `Job Name` | `Lot No.` | `Mould` | `Section` | `GOB` | `Defects` | `Pcs/Pack` | `Cartons` | `Defective Bottles` | `Checker Name` | `QA-Shift Ex.`
  2. **Direct Top Navigation Integration**: Added top-level navigation buttons in `ProductionQualityMonitor.tsx` for both `SQC/QC HOLD` and `NUMBERING` (active machine view 6 with layout state `'sqc'` or `'numbering'`), styled consistently with existing machine navigation tabs and preserving active date context.
  3. **Dynamic Row Insertion & Removal Grouped by Job**:
     - Implemented an ERP-style `(+)` button beside the Job Name input that inserts an editable row immediately below the clicked row (`anchor` tracking), maintaining bottle grouping (e.g., Medley $\rightarrow$ Medley-added rows $\rightarrow$ Himalaya) rather than appending to the bottom of the table.
     - Implemented a `(-)` button on manually added rows to delete them, clearing their state and gracefully re-anchoring child rows. Core production runs remain protected and cannot be deleted.
     - Maintained isolated state stores (`numberingValues`, `sqcValues`, `numberingExtras`, `sqcExtras`) so adding or editing rows in one layout never modifies or corrupts data in the other layout.
  4. **Manual 12-Hour AM/PM Time Picker (`CellTimePicker`)**: Created a floating, viewport-aware time selector panel with Hour (1–12), Minute (00–59), and AM/PM dropdowns. Stored in standard `h:mm A` format (e.g., "3:30 PM"). Never auto-populates from schedules, ensuring operator entered times are genuine. Automatically dismisses on outside clicks, Escape, or page scroll.
  5. **13-Column Grid with GOB Integration & Numeric Stepper Protection**: Added `GOB` column input to both tables and updated minimum table width to `1220px` with contained horizontal scrolling. Swallowed native `ArrowUp`/`ArrowDown` keystrokes on numeric input fields (`CellNumInput`) to prevent accidental stepping during inspection entry.
  6. **Zero Backend / Schema Impact**: Entirely UI-driven ERP module that reuses existing read-only daily quality records; does not alter database schemas or create breaking API dependencies.
- **Files Touched**: `src/components/quality/Re-PackingReport.tsx`, `src/components/quality/ProductionQualityMonitor.tsx`

## 16. Packaging Master Management (`hpr.packaging_master`), Endpoints & Panel Integration
- **Issue**: Plant operations required a standardized catalog of packaging specifications (carton configurations, box sizes, trays) rather than entering arbitrary, unvalidated packaging text.
- **Fix**:
  1. **Model & Schema**: Mapped `PackagingMaster` in `Backend/app/models/packaging.py` against `hpr.packaging_master` (`packaging_id` PK, `packaging_code` VARCHAR(20) UNIQUE, `packaging_description` VARCHAR(150)) and created Pydantic schemas in `Backend/app/schemas/packaging.py`.
  2. **FastAPI CRUD Router**: Implemented `Backend/app/api/production/packaging.py` providing GET, POST, PUT, and DELETE endpoints governed by `require_any_module_read` and `require_any_module_edit` permissions on Master Management modules, with audit logging (`CREATED_PACKAGING`, `UPDATED_PACKAGING`, `DELETED_PACKAGING`).
  3. **Frontend Management Panel**: Created `PackagingMasterPanel.tsx` and mounted it inside `MachinesModule.tsx` as a new tab ("Packaging Master") with edit/delete confirmation modals and synchronized backend loading via `planningRepository`.
- **Files Touched**: `Backend/app/models/packaging.py`, `Backend/app/schemas/packaging.py`, `Backend/app/api/production/packaging.py`, `Backend/app/main.py`, `src/components/master-management/PackagingMasterPanel.tsx`, `src/components/master-management/MachinesModule.tsx`, `src/services/planningRepository.ts`

## 17. Dedicated Repacking Database Persistence (Numbering & SQC/QC HOLD), Schemas, API & Combined Caching
- **Issue**: Re-Packing data was initially stored only in ephemeral client state, causing re-sorting inspections, defect records, and sign-offs to be lost on page refresh or date navigation.
- **Fix**:
  1. **Database ORM Models**: Created `RepackingNumbering` and `RepackingSqcQcHold` in `Backend/app/models/repacking.py` located within the `sqc` schema. Defined fields for date, machine, job, bottle, pack type, shift, time, pack size, cartons, defective bottles, defect ID, mould, section, checker ID, remarks, and lot number (for SQC/QC Hold).
  2. **FastAPI Endpoints**: Built comprehensive CRUD and atomic bulk-save endpoints in `Backend/app/api/production/repacking.py` (`POST /numbering/save`, `POST /sqc-qc-hold/save`), along with a combined date-fetch endpoint (`GET /api/production/repacking/`).
  3. **Frontend Repository & Caching**: Created `src/services/repackingRepository.ts` featuring a date-keyed cache (`repackingDataCache`) to eliminate redundant HTTP queries when toggling between Numbering and SQC/QC Hold views.
- **Files Touched**: `Backend/app/models/repacking.py`, `Backend/app/schemas/repacking.py`, `Backend/app/api/production/repacking.py`, `Backend/app/main.py`, `src/services/repackingRepository.ts`, `src/components/quality/Re-PackingReport.tsx`

## 18. Executive Analytics Dashboard Activation (`DashboardModule.tsx`)
- **Issue**: Plant management and executives lacked a unified high-level performance cockpit combining schedule execution, furnace draw, weight efficiency, and line throughput.
- **Fix**:
  1. **Component Activation**: Activated `DashboardModule` in `src/App.tsx` and linked it to the top navigation bar under `#dashboard`.
  2. **Executive KPI Suite**: Added real-time summary cards displaying Actual Production (bottles), Planned / As Per Speed, Variance, Weight Efficiency (% WT EFF), Pieces Efficiency (%), and Total Draw (tonnage).
  3. **Visual Analytics & Print Isolation**: Integrated Recharts bar charts for target vs actual output and machine efficiency comparisons, machine draw distribution, hourly timeline tracking, and dedicated `@media print` isolation routines (`isolateReportForPrint`).
- **Files Touched**: `src/App.tsx`, `src/components/dashboard/DashboardModule.tsx`

## 19. Employee Master Metadata Registration & Checker/QA-Executive Lookup
- **Issue**: Foreign keys on `repacking_numbering.checker_id` and `repacking_sqc_qc_hold.checker_id` referencing `hpr.employee_master` failed during automated metadata reflection in CI and local SQLite testing.
- **Fix**:
  1. **Model Registration**: Added minimal `EmployeeMaster` model mapping `hpr.employee_master` (`employee_id`, `employee_name`, `is_active`) and registered it in `Base.metadata`.
  2. **API Endpoint**: Exposed `GET /api/production/repacking/employees` and `GET /api/auth/employees` to serve active employees for dropdown selectors.
  3. **Test Coverage**: Added `Backend/tests/test_employee_master_metadata.py` verifying `Base.metadata` includes `employee_master`.
- **Files Touched**: `Backend/app/models/employee.py`, `Backend/app/db/base.py`, `Backend/app/api/auth.py`, `Backend/tests/test_employee_master_metadata.py`

## 20. Re-Packing Report Field Standardization & Shift-Restricted Custom Time Picker
- **Issue**:
  1. The column header "Pcs/Pack" caused operational confusion with package quantities; plant standard is "Pack Size".
  2. The "Bottle" column duplicated information already conveyed by "Job Name".
  3. Free-form time entry allowed operators to log inspection times outside the active shift hours.
- **Fix**:
  1. **Nomenclature & Layout**: Renamed "Pcs/Pack" to "Pack Size" and removed the redundant "Bottle" column across both NUMBERING and SQC/QC HOLD tables.
  2. **Shift-Restricted Time Picker**: Enhanced the floating 12-hour time picker (`CellTimePicker`) to restrict selectable hours to the current row's shift (Shift 1: 9:00 AM – 5:00 PM, Shift 2: 5:00 PM – 1:00 AM, Shift 3: 1:00 AM – 9:00 AM) while maintaining flexible 24-hour string parsing fallbacks.
  3. **Dropdown Typing**: Fixed `triggerRef` typing in `TimePickerDropdown` to permit null values on mount.
- **Files Touched**: `src/components/quality/Re-PackingReport.tsx`

## 21. Dual Packaging Types (TYPE 1 and TYPE 2) Across Quality Inspection & Re-Packing
- **Issue**: Modern glass packaging lines frequently run dual packing configurations simultaneously (e.g. cartons and bulk trays). The Hourly Production Report only supported a single packing category, pack size, and carton count, forcing operators to combine or omit packaging types.
- **Fix**:
  1. **Database Schema & Migration**: Added `packing_category_2` (VARCHAR 100), `packing_size_2` (INTEGER), and `cartons_2` (INTEGER) to `hpr.hourly_production`. Added idempotent startup check `_ensure_hourly_production_type2_packing_columns` in `Backend/app/main.py`.
  2. **Quality Monitor Grid**: Added distinct column groups for TYPE 1 and TYPE 2 packaging (Pack Type, Pack Size, Cartons) in `ProductionQualityMonitor.tsx`. Total bottles produced is computed as `(TYPE 1 Pack Size * TYPE 1 Cartons) + (TYPE 2 Pack Size * TYPE 2 Cartons)`.
  3. **Job-Scoped Pack Type Resolution**: Updated `Re-PackingReport.tsx` to harvest both TYPE 1 and TYPE 2 packing categories from hourly data and map them by Job ID and Bottle ID (`packTypesForRow`). Each row's dropdown offers only the exact pack types reported during that job's operational hours.
- **Files Touched**: `Backend/app/models/quality.py`, `Backend/app/schemas/quality.py`, `Backend/app/api/production/quality_daily.py`, `Backend/app/main.py`, `src/services/qualityRepository.ts`, `src/components/quality/ProductionQualityMonitor.tsx`, `src/components/quality/Re-PackingReport.tsx`

## 22. Shared Production Timeline Builder (`buildProductionTimeline`) & Quality Report Integration
- **Issue**: Calculating the actual Production Timeline (the continuous 24-hour cycle from 7:00 AM to 7:00 AM next day, offset by annealing lehr transit times) was coupled directly to the monitor component and omitted from the Machine Wise Production and Efficiency report.
- **Fix**:
  1. **Pure Utility Function**: Implemented `buildProductionTimeline` in `src/utils/layerOutTimeline.ts`. Offsets packing start and end boundaries backwards by applicable per-shift Lehr Out minutes, handling boundary transitions and 24-hour day wrapping.
  2. **Continuous Production Time Display**: Rendered dedicated "Production Timeline" column alongside "Packing Timeline" in `ProductionQualityMonitor.tsx`.
  3. **Quality Report Alignment**: Refactored `QualityReport.tsx` to consume `buildProductionTimeline`, guaranteeing that reported machine runtime minutes and start times match the Hourly Production Monitor.
- **Files Touched**: `src/utils/layerOutTimeline.ts`, `src/components/quality/ProductionQualityMonitor.tsx`, `src/components/quality/QualityReport.tsx`

## 23. Timeline Adjustments for Pre-9 AM Carry-In Split Rows & Display-Order Job Continuations
- **Issue**:
  1. Splitting the initial 9:00 AM row before 9:00 AM (e.g. 8:30 AM carved out of the previous day's carry-in) placed the split row chronologically after the final 8:00 AM row instead of at the top of the table.
  2. The first row (9:00 AM) was hard-coded to disallow row splitting (`canSplit={time !== PRODUCTION_TIMES[0].time}`).
  3. The "Continue Job" (`+`) action relied on raw clock minute comparisons, which miscalculated next targets when crossing midnight or encountering pre-9 AM split segments.
- **Fix**:
  1. **Pre-9 AM Timeline Adjustments**: Implemented `toOrderedTimelineMinutes`, `isPreDayStartSplitKey`, and `alignSplitMinuteToInterval` in `ProductionQualityMonitor.tsx`. Pre-9 AM split rows are shifted back by 24 hours so they sort strictly at the top of the table before 9:00 AM.
  2. **Universal Row Splitting**: Removed the first-row split restriction (`canSplit={(slot?.durationMinutes ?? 0) > 0}`), allowing any row with duration > 0 to be split. Preserved parent `period_start` (e.g. 8:00 AM) when creating pre-9 AM splits.
  3. **Display-Order Job Continuations**: Replaced raw clock comparison with display index navigation (`orderedKeys.indexOf(time)`). Job extensions cleanly cascade into the immediate next displayed row regardless of whether it is an hourly slot, a split segment, or a cross-day transition.
- **Files Touched**: `src/components/quality/ProductionQualityMonitor.tsx`

## 24. Atomic Row Locking via `lock_times` in Daily Quality Save & PostgreSQL Connection Pool Hardening
- **Issue**:
  1. Operators checking row lock checkboxes during an inspection edit required two separate network requests (saving row metrics first, then triggering a separate lock toggle endpoint), risking partial failures.
  2. High concurrency during shift-end handovers caused intermittent PostgreSQL connection drops and timeout exceptions on Render/AWS RDS.
  3. Frequent 500ms polling for ERP planning cache updates created unnecessary CPU timer wakeups on client browsers.
- **Fix**:
  1. **Atomic Lock in Save Payload**: Added `lock_times` (mapping of machine number to list of production time labels) to `QualityDailyRequest` schema and `qualityRepository.save`. Updated `save_daily_quality` in `quality_daily.py` to set `entry.is_locked = True` on matching rows within the same commit transaction.
  2. **Engine Pool Hardening**: Configured PostgreSQL connection pooling in `Backend/app/db/session.py` with `pool_pre_ping=True`, `pool_size=10`, `max_overflow=20`, `pool_recycle=1800` (recycles connections every 30 min), and `pool_timeout=30`.
  3. **Throttled Cache Polling**: Reduced cache version check frequency in `ERPContext.tsx` from 500ms to 2000ms.
- **Files Touched**: `Backend/app/schemas/quality.py`, `Backend/app/api/production/quality_daily.py`, `Backend/app/db/session.py`, `src/services/qualityRepository.ts`, `src/context/ERPContext.tsx`

## 25. Active Entry & Slot-Availability Row Extension Logic in QualityControlModule
- **Issue**:
  1. The "+" (job continuation) and "−" (permanent removal) buttons were shown only on the singular latest active row, preventing operators from extending earlier uncompleted slots into adjacent empty hours.
  2. When edge-case conditions arose in slot detection, the active entry could lose its extension and removal controls.
- **Fix**:
  1. **Next Hourly Slot Detection**: Created `getNextHourlySlot` to look ahead to the next canonical hourly production slot. Added `canExtendFromTime(time, rows)` to show "+" whenever the immediately upcoming hourly slot is empty.
  2. **Active Entry Fallback**: Updated `copyRowDown`, `removeBottle`, and row action rendering in `ProductionQualityMonitor.tsx` to check `(canExtendFromTime(time) || isActiveEntryTime(time))`, ensuring the latest active production entry always preserves "+" and "−" capabilities.
- **Files Touched**: `src/components/quality/ProductionQualityMonitor.tsx`

## 26. Precision Efficiency Calculation & Zero-Carton / Stored-Fallback Alignment across Quality Monitor and Quality Report
- **Issue**:
  1. When operators logged 0 cartons for a run (e.g. during a line shutdown or pack change), the efficiency badge rendered blank or null instead of explicit `0%`.
  2. When packaging category or carton fields were omitted or partially filled, calculated bottle and efficiency helpers returned blank rather than utilizing stored `bottles_in_nos` or `efficiency_percentage` fallbacks.
  3. In `QualityReport.tsx`, the upper Shift-Wise "Overall EFF%" card calculated overall machine efficiency using a simplistic inline ternary that diverged from the Hourly Production Monitor's Day Avg / Summary calculation.
- **Fix**:
  1. **Explicit Zero-Carton & 0% Efficiency Handling**: Updated `packagingBottles` to treat `cartons === 0` as a legitimate numeric value (`0` bottles). Updated `EffBadge` and `calcEffForEntry` in `ProductionQualityMonitor.tsx` to explicitly format and display `0%` when efficiency evaluates to 0.
  2. **Stored Metric Fallbacks**: Added fallback checks to stored `bottles_in_nos` and stored `efficiency_percentage` in `calcTotalBottlesInNos` and `calcEffForEntry` when packaging entries are empty or unassigned.
  3. **Unified Day Summary Efficiency Helper**: Created `daySummaryEfficiencyForEntry` in `QualityReport.tsx` implementing the authoritative HPM Day Summary rule: non-zero carton rows use stored efficiency, zero-carton rows compute actual pieces efficiency against theoretical speed, and blank entries are cleanly excluded. Wired this helper directly into `buildShiftWiseRows` to guarantee identical overall efficiency between both screens.
- **Files Touched**: `src/components/quality/ProductionQualityMonitor.tsx`, `src/components/quality/QualityReport.tsx`

## 27. Strict Job ID Validation & Bottle Name Resolution in Repacking Module (`_reject_bottle_name_job_ids` & `BottleNameItem`)
- **Issue**:
  1. Operators or automated payloads could mistakenly submit bottle names (e.g. `'100 ML MEDLEY'`, `'60 ML RECTANGULAR'`) into the `job_id` column of `repacking_numbering` or `repacking_sqc_qc_hold`, corrupting foreign key and job identity consistency.
  2. The UI displayed numeric bottle IDs (e.g. `"65"`) under the "JOB NAME" column when a bottle name was not eagerly fetched or when a row was added dynamically via `(+)`.
  3. Dynamically added rows (`(+)`) did not track the parent row's `jobId` and `bottleId`, leading to empty or unassigned job identifiers upon save.
- **Fix**:
  1. **Backend Name Rejection**: Implemented `_reject_bottle_name_job_ids` in `Backend/app/api/production/repacking.py`. Checks incoming `job_id` values against `production.bottle_master.bottle_name` and rejects name values with HTTP 400 (`"job_id cannot be a bottle name ('...'). Use the actual Job ID; the bottle name is resolved from bottle_id."`).
  2. **Combined Bottle Master Lookup**: Added `BottleNameItem` schema and included `bottle_names: List[BottleNameItem]` in `RepackingDataResponse`. `get_repacking_data` queries `production.bottle_master` to return `(bottle_id, bottle_name)` pairs in the single round-trip.
  3. **Frontend Bottle Name Resolution & Clean Rendering**:
     - Updated `Re-PackingReport.tsx` to resolve bottle names using `bottleNames` lookup from `repackingRepository.getRepackingData`.
     - `bottleNameFor` never returns raw numeric IDs, rendering an empty cell instead of showing numeric strings like `"65"`.
     - Updated `ExtraRow` interface to store `jobId: string` and `bottleId: number | null` copied directly from the parent row when clicking `(+)`.
     - `jobIdForRow` prioritizes resolving valid Job IDs from daily production runs, omitting `job_id` from updates if legacy data contained an invalid bottle name.
- **Files Touched**: `Backend/app/api/production/repacking.py`, `Backend/app/schemas/repacking.py`, `src/services/repackingRepository.ts`, `src/components/quality/Re-PackingReport.tsx`


