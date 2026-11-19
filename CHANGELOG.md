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

### 2026-11-18 — Production Timeline Visibility Toggle & 4-Sheet Excel Export in Quality Control
- **Problem:**
  - In `ProductionQualityMonitor.tsx`, the "Production Timeline" column was persistently displayed, consuming table width on dense 18-column inspection grids even when operators only required the "Packing Timeline".
  - The multi-machine Excel export previously concatenated all four machines into a single `Hourly Production` worksheet, requiring vertical scrolling and making per-machine data consumption cumbersome.
- **Root Cause:**
  - Table header and cell rendering lacked a visibility toggle flag for the Production Timeline column.
  - `handleExport` added only one worksheet to the ExcelJS workbook and appended all machine tables sequentially separated by spacer rows.
- **Fix:**
  - `src/components/quality/ProductionQualityMonitor.tsx`:
    - Added `showProductionTimeline` state (boolean, default `false`).
    - Added an interactive toggle button with `Eye` / `EyeOff` icons in the machine tab toolbar (`"Show Production Time"` / `"Hide Production Time"`).
    - Conditioned the "Production Timeline" header cell (`<th>`) and table row cells (`<td>`) on `showProductionTimeline`.
    - Dynamically adjusted `colSpan` in the table footer ("Day Avg / Summary" row: 5 to 4 columns; column lock banner row) when the Production Timeline column is hidden.
    - Updated `handleExport` to generate an Excel workbook with four dedicated worksheets (`Machine 1`, `Machine 2`, `Machine 3`, `Machine 4`). Each sheet contains its machine's centered header, exact column formatting, shift colors, and Day Avg / Summary row.
- **Files Changed:**
  - `src/components/quality/ProductionQualityMonitor.tsx`
- **API or DB Impact:**
  - None. Client-side UI visibility toggle and spreadsheet layout reorganization.

---

### 2026-11-18 — Dedicated Reports Module Integration & Navigation Structure
- **Problem:**
  - Production and quality reports lacked a dedicated first-class application module in the main layout and sidebar navigation.
  - The hash routing system did not recognize `#reports`, and the navigation shell lacked top-level integration for the reports workspace.
- **Root Cause:**
  - `ReportsModule.tsx` was an unused placeholder file not wired into the main application layout or module collections.
- **Fix:**
  - `src/App.tsx`:
    - Imported `ProductionReportModule` from `./components/reports/ProductionReportModule`.
    - Added `'Reports'` to `BUILT_IN_MODULES` and rendered `<ProductionReportModule />` when `activeModule === 'Reports'`.
  - `src/components/layout/Sidebar.tsx`:
    - Added "Reports" navigation entry with `FileBarChart` icon to `NAV_ITEMS`.
    - Added `'Reports'` to `STATIC_MODULE_NAMES`.
  - `src/components/reports/ProductionReportModule.tsx`:
    - Implemented `ProductionReportModule` component wrapping the module placeholder for production reporting.
  - `src/components/reports/ReportsModule.tsx`:
    - Removed obsolete placeholder file.
  - `src/context/AuthContext.tsx`:
    - Added `'Reports'` to `APP_MODULES` array.
  - `src/context/ERPContext.tsx`:
    - Mapped `'Reports': 'reports'` in `MODULE_TO_SLUG` and `'reports': 'Reports'` in `SLUG_TO_MODULE`.
  - `src/types/index.ts`:
    - Added `'Reports'` to the `ActiveModule` union type.
- **Files Changed:**
  - `src/App.tsx`
  - `src/components/layout/Sidebar.tsx`
  - `src/components/reports/ProductionReportModule.tsx`
  - `src/components/reports/ReportsModule.tsx`
  - `src/context/AuthContext.tsx`
  - `src/context/ERPContext.tsx`
  - `src/types/index.ts`
- **API or DB Impact:**
  - None. Frontend application shell and navigation structure enhancement.

---

### 2026-11-17 — Repacking Model/Schema Refactor (No Defective Bottles in Numbering) & Component Rename to numbering-SQC-QC-Hold
- **Problem:**
  - The live PostgreSQL table `sqc.repacking_numbering` does not have a `defective_bottles` column (which exists only in `sqc.repacking_sqc_qc_hold`). However, SQLAlchemy models, Pydantic schemas, and API handlers still defined and serialized `defective_bottles`, causing potential runtime errors or misleading API contracts.
  - The frontend component `Re-PackingReport.tsx` had an inconsistent filename relative to its dual-purpose Numbering and SQC/QC Hold duties.
- **Root Cause:**
  - Initial scaffolding mirrored the `repacking_sqc_qc_hold` columns into `repacking_numbering` instead of respecting the exact PostgreSQL schema.
- **Fix:**
  - `Backend/app/models/repacking.py`:
    - Removed `defective_bottles` column from `RepackingNumbering` ORM model.
  - `Backend/app/schemas/repacking.py`:
    - Removed `defective_bottles` from `NumberingEntryCreate`, `NumberingEntryUpdate`, and `NumberingEntryResponse` schemas.
  - `Backend/app/api/production/repacking.py`:
    - Removed `defective_bottles` assignment and query construction from repacking numbering endpoints.
  - `Backend/tests/test_numbering_no_defective_bottles.py`:
    - Added comprehensive automated test suite (252 lines) verifying that the numbering model, API endpoints, and bulk save operations function correctly without `defective_bottles`.
  - `src/services/repackingRepository.ts`:
    - Removed `defective_bottles` from `NumberingEntry` interface.
  - `src/components/quality/numbering-SQC-QC-Hold.tsx`:
    - Renamed from `src/components/quality/Re-PackingReport.tsx` to `src/components/quality/numbering-SQC-QC-Hold.tsx`.
  - `src/components/quality/ProductionQualityMonitor.tsx`:
    - Updated import to `./numbering-SQC-QC-Hold`.
  - `DOCUMENTATION.md`:
    - Removed `defective_bottles` from `sqc.repacking_numbering` field list.
- **Files Changed:**
  - `Backend/app/api/production/repacking.py`
  - `Backend/app/models/repacking.py`
  - `Backend/app/schemas/repacking.py`
  - `Backend/tests/test_numbering_no_defective_bottles.py`
  - `src/components/quality/ProductionQualityMonitor.tsx`
  - `src/components/quality/numbering-SQC-QC-Hold.tsx`
  - `src/services/repackingRepository.ts`
  - `DOCUMENTATION.md`
- **API or DB Impact:**
  - Removed `defective_bottles` field from Numbering API schemas (`POST /api/production/repacking/numbering`, `PUT /api/production/repacking/numbering/{id}`, `POST /api/production/repacking/numbering/save`, and `GET /api/production/repacking/`). Database schema matches existing PostgreSQL column structure.

---

### 2026-11-17 — Hourly Production Monitor Export & Print for All Four Machines
- **Problem:**
  - Export Excel and Print generated only the report of the currently selected machine tab, even though the report is meant to cover the whole selected production date across all production lines.
- **Root Cause:**
  - Both `handleExport` and `handlePrint` read the active machine's rows (`productionStore[dateKey][activeMachine]`) and used the active-machine timelines, durations and summary values, omitting the other three machines.
- **Fix:**
  - `src/components/quality/ProductionQualityMonitor.tsx`:
    - Added shared `buildMachineReportModel(machineNo, date, store, inputs, gobCount)` builder that evaluates ordered display keys, layer-out timeline, durations, shift indices, production timeline, day averages, and totals for any machine without altering any calculation rule.
    - Added `reportStoreForDate()` reusing the loaded `24 x 4` day store, or fetching the day once if export/print runs before load finishes.
    - **Excel:** Generates all 4 machine reports sequentially with centered company/date/day/machine heading, proper column widths, shift colors, and Day Avg / Summary row.
    - **Print:** Generates one landscape PDF with exactly one complete machine report per page using explicit `addPage()` breaks and independent font profiles to ensure single-page-per-machine layout.
- **Files Changed:**
  - `src/components/quality/ProductionQualityMonitor.tsx`
- **API or DB Impact:**
  - None. Frontend-only multi-machine aggregation.

---

### 2026-11-17 — Hourly Production Monitor Excel Export Matched to PDF Report Layout
- **Problem:**
  - The Hourly Production Monitor's Export button downloaded a plain `.csv` with an extra Machine column and no heading, header styling, shift colours or Day Avg / Summary row, so the export looked nothing like the existing PDF print report.
- **Root Cause:**
  - `handleExport` manually built comma-separated rows and a text/csv Blob, discarding all of the layout and formatting that the PDF path applies through jsPDF + autoTable.
- **Fix:**
  - `src/components/quality/ProductionQualityMonitor.tsx`:
    - Replaced the CSV writer with a lazily loaded ExcelJS workbook downloaded as `.xlsx`.
    - Reused the PDF's centered heading (company name + `date - day    Machine: No. n`), merged across the full report width.
    - Reused the PDF's exact 18-column table (17 on 2-gob machines, omitting Weight M), its rows, its split segments and its Day Avg / Summary values.
    - Applied dark navy header cells (`#1E293B`) with white bold wrapped text, thin borders, centered numeric/time columns, left-aligned Bottle Name and Remarks, proportional column widths and consistent row heights.
    - Applied the PDF's shift-wise row palette (light blue / light green / light cream) plus the split-group highlight, and a bold light-shaded summary row.
    - Hid gridlines, set landscape A4 with fit-to-one-page-width and added the report title + `Page x of y` to the print footer.
- **Files Changed:**
  - `src/components/quality/ProductionQualityMonitor.tsx`
- **API or DB Impact:**
  - None. Frontend-only export change.

---

### 2026-11-17 — Strict Job ID Validation, Bottle Name Master Resolution & Extra Row Identity in Repacking Module
- **Problem:**
  - In `repacking_numbering` and `repacking_sqc_qc_hold`, erroneous payloads or frontend inputs could persist bottle name strings (e.g. `'100 ML MEDLEY'`, `'60 ML RECTANGULAR'`) directly into the `job_id` column, breaking relational consistency.
  - In `numbering-SQC-QC-Hold.tsx` (formerly `Re-PackingReport.tsx`), the "JOB NAME" column displayed raw numeric IDs (e.g. `"65"`) when a bottle name was not eagerly fetched or when a row was added dynamically via `(+)`.
  - Dynamically added rows (`(+)`) lacked inheritance of the parent row's `jobId` and `bottleId`, leading to unassigned or corrupted job identifiers upon batch saving.
- **Root Cause:**
  - Backend lacked explicit validation preventing bottle names from being passed as `job_id`.
  - Re-packing combined fetch omitted `production.bottle_master` lookup data, forcing the UI to fall back to raw numeric IDs.
  - `ExtraRow` state structure omitted `jobId` and `bottleId` parent fields.
- **Fix:**
  - `Backend/app/api/production/repacking.py`:
    - Implemented `_reject_bottle_name_job_ids(db, job_ids)` and integrated it into `_validate_references`. Queries `production.bottle_master` and rejects requests with HTTP 400 if `job_id` matches a bottle name.
    - Updated `get_repacking_data` to query `production.bottle_master` and return `bottle_names: List[BottleNameItem]` in the single combined response.
  - `Backend/app/schemas/repacking.py`:
    - Added `BottleNameItem` schema (`bottle_id: int`, `bottle_name: str`) and added `bottle_names` to `RepackingDataResponse`.
  - `src/services/repackingRepository.ts`:
    - Added `BottleNameItem` interface and updated `repackingDataCache` to store and return `bottleNames`.
  - `src/components/quality/numbering-SQC-QC-Hold.tsx`:
    - Updated `bottleNameFor` to resolve names from `bottleNames` and return an empty cell rather than falling back to numeric IDs.
    - Extended `ExtraRow` to store `jobId` and `bottleId` copied directly from the parent row on `(+)` click.
    - Updated `jobIdForRow` to prioritize authoritative Job IDs from daily production runs, omitting `job_id` from updates if legacy data contained an invalid bottle name.
- **Files Changed:**
  - `Backend/app/api/production/repacking.py`
  - `Backend/app/schemas/repacking.py`
  - `src/services/repackingRepository.ts`
  - `src/components/quality/numbering-SQC-QC-Hold.tsx`
- **API or DB Impact:**
  - `GET /api/production/repacking/` response includes `bottle_names: List[BottleNameItem]`.
  - All mutating repacking endpoints (`POST`, `PUT`, bulk saves) strictly reject bottle names in `job_id` with HTTP 400.

---

### 2026-11-16 — Precision Efficiency Calculations, Zero-Carton Handling & HPM Summary Alignment in QualityReport and Quality Monitor
- **Problem:**
  - Logging zero cartons (e.g. line clearings, packaging changes) rendered blank/null efficiency badges instead of an explicit `0%`.
  - Rows with unassigned or partial packaging entries failed to display efficiency or bottle estimates even when authoritative stored `efficiency_percentage` or `bottles_in_nos` metrics were present in the database.
  - In `QualityReport.tsx`, the Shift-Wise Overall EFF% used a simplistic inline check that calculated machine efficiency differently from the Hourly Production Monitor's summary row.
- **Root Cause:**
  - `packagingBottles` and `EffBadge` treated `0` as falsy, dropping zero-carton values.
  - Calculation helpers lacked fallback checks to database-persisted fields.
  - Overall efficiency calculation logic was duplicated and diverged between the report card and the monitor grid.
- **Fix:**
  - `src/components/quality/ProductionQualityMonitor.tsx`:
    - Updated `packagingBottles` to recognize `cartons === 0` as a valid numeric outcome (`0` bottles).
    - Updated `EffBadge` and `calcEffForEntry` to format and render explicit `0%` styling when efficiency is 0.
    - Added fallbacks to stored `bottles_in_nos` and stored `efficiency_percentage` in `calcTotalBottlesInNos` and `calcEffForEntry`.
  - `src/components/quality/QualityReport.tsx`:
    - Built `daySummaryEfficiencyForEntry` implementing the exact HPM Day Summary rule: non-zero carton rows use stored efficiency, zero-carton rows evaluate actual pieces efficiency, and blank entries are ignored.
    - Integrated `daySummaryEfficiencyForEntry` into `buildShiftWiseRows` to guarantee complete alignment between the Shift-Wise Overall EFF% and the Hourly Production Monitor.
- **Files Changed:**
  - `src/components/quality/ProductionQualityMonitor.tsx`
  - `src/components/quality/QualityReport.tsx`
- **API or DB Impact:**
  - None. Frontend calculation accuracy and visual rendering enhancement.

---

### 2026-11-16 — Active Entry Time Checks & Slot Availability Logic in QualityControlModule
- **Problem:**
  - In `ProductionQualityMonitor.tsx`, the row action buttons ("+" extension and "−" delete) were restricted only to entries passing slot availability rules, which could inadvertently disable controls on the latest active production entry.
- **Root Cause:**
  - Action visibility and handler guards relied exclusively on `canExtendFromTime` without falling back to `isActiveEntryTime`.
- **Fix:**
  - `src/components/quality/ProductionQualityMonitor.tsx`:
    - Updated `copyRowDown`, `removeBottle`, and render conditions to check `(canExtendFromTime(time) || isActiveEntryTime(time))`.
    - Guarantees that the active running production entry always presents "+" and "−" capabilities while keeping earlier uncompleted rows manageable.
- **Files Changed:**
  - `src/components/quality/ProductionQualityMonitor.tsx`
- **API or DB Impact:**
  - None.

---

### 2026-11-16 — Atomic Row Locking in Daily Quality Save, Connection Pool Hardening & ERP Cache Polling Optimization
- **Problem:**
  - Saving edited row metrics and toggling row lock checkboxes required separate HTTP calls, leading to potential out-of-sync database states if the second call failed.
  - High concurrency during shift-end quality reporting produced occasional PostgreSQL connection timeouts and stale connection errors.
  - High-frequency 500ms polling for ERP cache updates created unnecessary CPU timer wakeups on client browsers.
- **Root Cause:**
  - `save_daily_quality` lacked an atomic row locking parameter in its save payload.
  - SQLAlchemy connection pool used default settings without pre-ping health checks or idle connection recycling.
  - `ERPContext.tsx` polled `getCacheVersion()` every 500ms.
- **Fix:**
  - `Backend/app/schemas/quality.py`:
    - Added `lock_times: Optional[Dict[str, List[str]]]` to `QualityDailyRequest`.
  - `Backend/app/api/production/quality_daily.py`:
    - Updated `save_daily_quality` to apply `is_locked = True` on specified machine rows within the same commit transaction.
  - `Backend/app/db/session.py`:
    - Hardened PostgreSQL engine pooling: `pool_pre_ping=True`, `pool_size=10`, `max_overflow=20`, `pool_recycle=1800`, and `pool_timeout=30`.
  - `src/services/qualityRepository.ts`:
    - Added `lockTimes` to `qualityRepository.save` options.
  - `src/components/quality/ProductionQualityMonitor.tsx`:
    - Integrated atomic lock dispatch via `saveDailyQuality`.
    - Added `getNextHourlySlot` to look ahead to the next canonical hourly production slot.
  - `src/context/ERPContext.tsx`:
    - Adjusted cache polling interval from 500ms to 2000ms.
- **Files Changed:**
  - `Backend/app/schemas/quality.py`
  - `Backend/app/api/production/quality_daily.py`
  - `Backend/app/db/session.py`
  - `src/services/qualityRepository.ts`
  - `src/components/quality/ProductionQualityMonitor.tsx`
  - `src/context/ERPContext.tsx`
- **API or DB Impact:**
  - `POST /api/production/quality/daily/` payload supports optional `lock_times` map.

---

### 2026-11-15 — Timeline Adjustments for Pre-9 AM Split Rows, First-Row Splitting & Display-Order Job Continuations
- **Problem:**
  - Carving out a manual split row before the 9:00 AM production-day start (e.g. 8:30 AM carved out of the initial 9:00 AM carry-in hour) caused the split segment to be sorted after 8:00 AM at the bottom of the table rather than at the top before 9:00 AM.
  - The first row (9:00 AM) was hard-coded with `canSplit={time !== PRODUCTION_TIMES[0].time}`, preventing operators from logging split runs during the first operational hour.
  - Extending a job with `(+)` evaluated next targets using raw clock minute comparisons, which jumped over split segments or failed when crossing midnight.
- **Root Cause:**
  - Timeline sort helpers (`toTimelineMinutes`) mapped morning hours (8:30 AM) to the tail of the production day timeline (~1410 min) rather than recognizing pre-9 AM carry-in intervals.
  - Continuation logic indexed by array position rather than actual displayed order.
- **Fix:**
  - `src/components/quality/ProductionQualityMonitor.tsx`:
    - Added `alignSplitMinuteToInterval`, `isPreDayStartSplitKey`, `toOrderedTimelineMinutes`, and `toPreNineTimelineMinutes`. Pre-9 AM split rows are shifted back by 24 hours so they sort strictly at the top of the table before 9:00 AM.
    - Updated `stampSplitPeriods` so pre-9 AM split rows retain their parent `period_start` (e.g. 8:00 AM) instead of generating overlapping intervals.
    - Enabled splitting on all rows with positive duration (`canSplit={(slot?.durationMinutes ?? 0) > 0}`), including the 9:00 AM slot.
    - Replaced clock comparison with display index navigation (`orderedKeys.indexOf(time)`), allowing job continuations to cascade sequentially into the immediate next displayed row regardless of splits or midnight boundaries.
- **Files Changed:**
  - `src/components/quality/ProductionQualityMonitor.tsx`
- **API or DB Impact:**
  - Zero schema changes. Microsecond duration encoding seamlessly stores pre-9 AM split durations in `production_time.microsecond`.

---

### 2026-11-14 — Re-Packing Report TYPE 2 Packaging Support & Job-Scoped Pack Type Resolution
- **Problem:**
  - In `Re-PackingReport.tsx`, pack type options were extracted solely from TYPE 1 packaging (`packing_category`), ignoring secondary packaging configurations (`packing_category_2`) logged in the Hourly Production Monitor.
  - Pack types were pooled machine-wide, causing packaging types from one bottle run to leak into the dropdowns of different bottle runs on the same machine.
- **Root Cause:**
  - Pack info caching did not parse `packing_category_2` and did not partition pack types by Job ID or Bottle ID.
- **Fix:**
  - `src/components/quality/Re-PackingReport.tsx`:
    - Updated `machinePackInfo` to aggregate both `packing_category` and `packing_category_2`.
    - Grouped available pack types and pack sizes per Job ID and Bottle ID (`byJob: Record<string, { packTypes, packSize }>`).
    - Implemented `packTypesForRow(machineNo, row)` which resolves the exact pack types reported during that job's operational hours, falling back to machine-wide options only for unanchored manual rows.
  - `src/components/quality/ProductionQualityMonitor.tsx`:
    - Updated table header and cell formatting to maintain visual alignment with dual packaging columns.
- **Files Changed:**
  - `src/components/quality/Re-PackingReport.tsx`
  - `src/components/quality/ProductionQualityMonitor.tsx`
- **API or DB Impact:**
  - Zero schema or API changes. Display and dropdown resolution enhancement.

---

### 2026-11-14 — Streamlined PDF & Print Report Generation in Production Quality Monitor
- **Problem:**
  - PDF export in `ProductionQualityMonitor.tsx` duplicated repetitive report titles, machine numbers, and shift assignment metadata blocks across multi-page printouts, consuming vertical space and cluttering printed sheets.
  - Print tables were vulnerable to awkward pagination breaks across rows.
- **Root Cause:**
  - The PDF generation routine rendered multiple redundant header text lines and used a complex two-row table header with pastel fills.
- **Fix:**
  - `src/components/quality/ProductionQualityMonitor.tsx`:
    - Streamlined PDF header to a centered company name and report date block.
    - Consolidated table columns into a clean, compact single-row header (`Shift`, `Time`, `Production Time`, `Bottle Name`, `Weight F/M/R`, `Average`, `Speed/Min`, `Pack Type`, `Pack Size`, `Cartons`, `Pack Type`, `Pack Size`, `Cartons`, `Bottles`, `Pieces EFF%`, `Remarks`).
    - Enhanced `@media print` CSS with explicit page break prevention (`page-break-inside: avoid !important; break-inside: avoid !important;`) on tables and cards, and targeted A4 landscape layout (`@page { size: A4 landscape; margin: 6mm 7.5mm; }`).
- **Files Changed:**
  - `src/components/quality/ProductionQualityMonitor.tsx`
- **API or DB Impact:**
  - Zero API or database impact. Client-side PDF formatting optimization.

---

### 2026-11-14 — Shared Production Timeline Builder (`buildProductionTimeline`) & Quality Report Integration
- **Problem:**
  - Production timeline calculation (the continuous 24-hour cycle from 7:00 AM to 7:00 AM next day, offset by annealing lehr transit times) was coupled directly to `ProductionQualityMonitor.tsx`.
  - In `QualityReport.tsx`, machine runtime minutes and start times reverted to packing clock times rather than using true Lehr-Out-adjusted production boundaries.
- **Root Cause:**
  - The timeline math was not factored into a reusable shared module.
- **Fix:**
  - `src/utils/layerOutTimeline.ts`:
    - Created `buildProductionTimeline` pure function and `ProductionTimeSlot` interface.
    - Shifts packing timeline boundaries backwards by applicable per-shift Lehr Out minutes, correctly handling boundary transition rules and wrapping across midnight.
  - `src/components/quality/ProductionQualityMonitor.tsx`:
    - Replaced local timeline math with `buildProductionTimeline` and labeled the column "Production Timeline".
  - `src/components/quality/QualityReport.tsx`:
    - Integrated `buildProductionTimeline` into machine runtime calculations and subtotal aggregations.
- **Files Changed:**
  - `src/utils/layerOutTimeline.ts`
  - `src/components/quality/ProductionQualityMonitor.tsx`
  - `src/components/quality/QualityReport.tsx`
- **API or DB Impact:**
  - None. Shared utility refactoring.

---

### 2026-11-13 — TYPE 2 Packaging Fields Across Backend Models, Schemas & Quality Control Module
- **Problem:**
  - Modern container manufacturing lines frequently pack ware under dual packaging formats (e.g. cartons and bulk pallets/trays) during the same operating hour.
  - `hourly_production` only supported single packaging entries (`packing_category`, `packing_size`, `cartons`), preventing plant operators from accurately recording dual-pack runs.
- **Root Cause:**
  - Database schema and ORM models lacked secondary packaging columns.
- **Fix:**
  - `Backend/app/models/quality.py`:
    - Added `packing_category_2` (`String(100)`), `packing_size_2` (`Integer`), and `cartons_2` (`Integer`) to `HourlyProduction`.
  - `Backend/app/schemas/quality.py`:
    - Extended `QualityHourlyEntrySchema` with `packing_category_2`, `packing_size_2`, and `cartons_2`.
  - `Backend/app/api/production/quality_daily.py`:
    - Updated `toDbEntry` and `fromDbEntry` to serialize and deserialize TYPE 2 packaging attributes.
  - `Backend/app/main.py`:
    - Added `_ensure_hourly_production_type2_packing_columns()` startup check to auto-add missing TYPE 2 columns via DDL against PostgreSQL if needed.
  - `src/services/qualityRepository.ts`:
    - Updated `QualityHourlyEntry`, `QualityEntryPayload`, and `DefectMasterItem` interfaces.
  - `src/components/quality/ProductionQualityMonitor.tsx`:
    - Added dedicated TYPE 1 and TYPE 2 column groups in the table header and body.
    - Updated total bottle calculation: `(TYPE 1 Pack Size * TYPE 1 Cartons) + (TYPE 2 Pack Size * TYPE 2 Cartons)`.
- **Files Changed:**
  - `Backend/app/models/quality.py`
  - `Backend/app/schemas/quality.py`
  - `Backend/app/api/production/quality_daily.py`
  - `Backend/app/main.py`
  - `src/services/qualityRepository.ts`
  - `src/components/quality/ProductionQualityMonitor.tsx`
- **API or DB Impact:**
  - Columns `packing_category_2`, `packing_size_2`, and `cartons_2` added to `hpr.hourly_production`.
  - `GET` and `POST /api/production/quality/daily/` support TYPE 2 packaging fields.

---

### 2026-11-09 — Re-Packing Report Table Layout Refactoring & Column Rationalization
- **Problem:**
  - The Re-Packing Report displayed separate "Bottle" and "Job Name" columns, which caused redundant text display and squeezed table width on standard displays.
- **Root Cause:**
  - Initial ERP wireframe included separate columns for bottle name and job code before realizing job names convey both specifications.
- **Fix:**
  - `src/components/quality/Re-PackingReport.tsx`:
    - Removed redundant "Bottle" column across NUMBERING and SQC/QC HOLD tables.
    - Adjusted table colspans, widths, and horizontal scroll boundaries.
- **Files Changed:**
  - `src/components/quality/Re-PackingReport.tsx`
- **API or DB Impact:**
  - Zero API or database impact.

---

### 2026-11-06 — Pack Size Standardization & Shift-Restricted Custom 12-Hour Time Picker in Re-Packing Report
- **Problem:**
  - Re-Packing tables used "Pcs/Pack", which diverged from the plant-wide terminology "Pack Size".
  - Operators could manually select inspection times outside the active shift hours, causing scheduling inconsistencies.
  - In `TimePickerDropdown`, passing null `triggerRef` on component mount triggered TypeScript warnings.
- **Root Cause:**
  - Lack of shift boundary validation in the custom time picker component.
  - Strict ref typing in `TimePickerDropdown`.
- **Fix:**
  - `src/components/quality/Re-PackingReport.tsx`:
    - Renamed all UI headers and field mappings from "Pcs/Pack" to "Pack Size".
    - Updated `CellTimePicker` to enforce shift-specific selectable hours (Shift 1: 9:00 AM – 5:00 PM, Shift 2: 5:00 PM – 1:00 AM, Shift 3: 1:00 AM – 9:00 AM) while maintaining 24-hour parsing fallback.
    - Updated `triggerRef` typing to allow null references safely.
- **Files Changed:**
  - `src/components/quality/Re-PackingReport.tsx`
- **API or DB Impact:**
  - Zero database impact.

---

### 2026-11-05 — Combined Repacking Data Fetch API & Client-Side Date Caching
- **Problem:**
  - Switching between Numbering and SQC/QC HOLD views triggered duplicate HTTP network requests for the same date.
- **Root Cause:**
  - Numbering and SQC/QC Hold views lacked a unified fetch endpoint and local cache.
- **Fix:**
  - `Backend/app/api/production/repacking.py`:
    - Added `GET /api/production/repacking/` returning `{ numbering: [...], sqc_qc_hold: [...] }` for a given production date.
  - `Backend/app/schemas/repacking.py`:
    - Added `RepackingDataResponse` composite schema.
  - `src/services/repackingRepository.ts`:
    - Implemented `repackingDataCache` keyed by `YYYY-MM-DD`, eliminating duplicate network queries on layout toggles.
- **Files Changed:**
  - `Backend/app/api/production/repacking.py`
  - `Backend/app/schemas/repacking.py`
  - `src/services/repackingRepository.ts`
  - `src/components/quality/Re-PackingReport.tsx`
  - `src/services/planningRepository.ts`
- **API or DB Impact:**
  - Added `GET /api/production/repacking/` endpoint.

---

### 2026-11-05 — Employee Master SQLAlchemy Registration & Test Coverage
- **Problem:**
  - Automated tests and local development using SQLite failed due to unresolvable foreign key references on `repacking_numbering.checker_id` $\rightarrow$ `hpr.employee_master.employee_id`.
- **Root Cause:**
  - `EmployeeMaster` was not mapped as a Declarative model in SQLAlchemy `Base.metadata`.
- **Fix:**
  - `Backend/app/models/employee.py`:
    - Created `EmployeeMaster` model mapping `hpr.employee_master` (`employee_id`, `employee_name`, `is_active`).
  - `Backend/app/db/base.py`:
    - Imported and registered `EmployeeMaster` in `Base.metadata`.
  - `Backend/tests/test_employee_master_metadata.py`:
    - Added unit test asserting `employee_master` table is registered in `Base.metadata.tables`.
- **Files Changed:**
  - `Backend/app/models/employee.py`
  - `Backend/app/models/repacking.py`
  - `Backend/tests/test_employee_master_metadata.py`
- **API or DB Impact:**
  - None on production PostgreSQL. Enables clean foreign key resolution in SQLite test environments.

---

### 2026-11-04 — Executive Analytics Dashboard Activation & Real-Time Performance Cockpit
- **Problem:**
  - Management required a bird's-eye view of manufacturing operations, tonnage draw, and line efficiencies without manually collating individual machine reports.
- **Root Cause:**
  - The dashboard module was inactive in the top-level application layout.
- **Fix:**
  - `src/App.tsx`:
    - Activated `DashboardModule` component in the main application layout and URL hash `#dashboard`.
  - `src/components/dashboard/DashboardModule.tsx`:
    - Added 6 KPI overview cards: Actual Production, Planned / As Per Speed, Variance, Weight Efficiency (% WT EFF), Unit Efficiency (Pieces EFF%), and Total Furnace Draw (tonnage).
    - Integrated Recharts bar charts for output targets vs actuals and machine efficiency comparisons.
    - Added machine draw distribution breakdown, hourly timeline visualizers, and isolated print stylesheet (`isolateReportForPrint`).
- **Files Changed:**
  - `src/App.tsx`
  - `src/components/dashboard/DashboardModule.tsx`
- **API or DB Impact:**
  - Zero backend or database changes. Reuses existing planning and quality APIs.

---

### 2026-11-03 — Dedicated Repacking Database Persistence (Numbering & SQC/QC HOLD), Schemas, API & Repository
- **Problem:**
  - Re-packing and re-sorting inspections, defect records, and sign-offs were previously stored in temporary browser memory and lost upon page reload.
- **Root Cause:**
  - Lack of database tables, backend API endpoints, and repository services for repacking workflows.
- **Fix:**
  - `Backend/app/models/repacking.py`:
    - Created `RepackingNumbering` and `RepackingSqcQcHold` models in schema `sqc`.
  - `Backend/app/schemas/repacking.py`:
    - Created Pydantic request/response schemas for Numbering and SQC/QC Hold entries.
  - `Backend/app/api/production/repacking.py`:
    - Built comprehensive CRUD endpoints: `GET`, `POST`, `PUT`, `DELETE`, and atomic bulk-save `POST /numbering/save` and `POST /sqc-qc-hold/save`.
  - `src/services/repackingRepository.ts`:
    - Built frontend API service connecting the UI to backend repacking endpoints.
  - `Backend/app/api/auth.py`:
    - Added `GET /api/auth/employees` for employee lookup dropdowns.
- **Files Changed:**
  - `Backend/app/models/repacking.py`
  - `Backend/app/schemas/repacking.py`
  - `Backend/app/api/production/repacking.py`
  - `Backend/app/main.py`
  - `Backend/app/api/auth.py`
  - `src/services/repackingRepository.ts`
  - `src/components/quality/Re-PackingReport.tsx`
- **API or DB Impact:**
  - New schema `sqc` and tables `sqc.repacking_numbering` and `sqc.repacking_sqc_qc_hold`.
  - New router `/api/production/repacking/*`.

---

### 2026-11-02 — Packaging Master Management (`hpr.packaging_master`), CRUD Endpoints & Navigation Integration
- **Problem:**
  - Plant operators lacked a centralized UI to manage packaging codes and specifications, leading to inconsistent manual text entry.
- **Root Cause:**
  - `hpr.packaging_master` table existed in the database but lacked ORM mapping, API endpoints, and a frontend management screen.
- **Fix:**
  - `Backend/app/models/packaging.py`:
    - Mapped `PackagingMaster` against `hpr.packaging_master`.
  - `Backend/app/schemas/packaging.py`:
    - Created `PackagingBase`, `PackagingCreate`, `PackagingUpdate`, `PackagingResponse` schemas.
  - `Backend/app/api/production/packaging.py`:
    - Created FastAPI router with GET, POST, PUT, DELETE endpoints protected by Master Management permissions, with audit logging (`CREATED_PACKAGING`, `UPDATED_PACKAGING`, `DELETED_PACKAGING`).
  - `src/components/master-management/PackagingMasterPanel.tsx`:
    - Created CRUD management panel with add/edit forms and delete confirmation modals.
  - `src/components/master-management/MachinesModule.tsx`:
    - Mounted "Packaging Master" tab.
  - `src/services/planningRepository.ts`:
    - Added packaging master client API functions.
- **Files Changed:**
  - `Backend/app/models/packaging.py`
  - `Backend/app/schemas/packaging.py`
  - `Backend/app/api/production/packaging.py`
  - `Backend/app/main.py`
  - `src/components/master-management/PackagingMasterPanel.tsx`
  - `src/components/master-management/MachinesModule.tsx`
  - `src/services/planningRepository.ts`
- **API or DB Impact:**
  - Added `/api/production/packaging/` CRUD endpoints. Mapped existing `hpr.packaging_master` table.

---

### 2026-10-31 — Re-Packing Report Dashboard (Numbering & SQC/QC Hold Layouts), Direct Main Navbar Access, Dynamic Job-Grouped Row Insertion/Removal, Manual 12-Hour Time Picker & GOB Field Integration
- **Problem:**
  - Glass manufacturing operations lacked a dedicated re-sorting and re-packing tracking module in the Quality Control suite. Plant teams needed to log re-packing inspection metrics, carton counts, defect totals, mould/section assignments, and sign-offs under two standard operational formats: "NUMBERING" and "SQC/QC HOLD".
  - Supervisors needed direct one-click navigation between the two views from the top-level Quality Control navigation bar rather than hiding them under nested configuration tabs.
  - Production jobs frequently have multiple defect occurrences or separate sorting batches per bottle run. Operators needed to add new inspection rows anchored directly beneath the relevant bottle run (grouped under that specific bottle) without corrupting or deleting base production runs loaded from the Hourly Production Monitor.
  - Inspection timestamps for re-packing are manual observation times and must not default to or be derived from scheduled machine production hours.
  - Operational traceability required logging GOB numbers alongside Section and Mould for all re-packing records.
- **Root Cause:**
  - Re-packing tracking previously lacked a specialized ERP interface and was managed ad-hoc outside the core system.
  - Production quality records only tracked primary hourly inspections and defect tallies without a specialized multi-layout re-sorting view.
- **Fix:**
  - `src/components/quality/Re-PackingReport.tsx`:
    - Created a modern two-layout Re-Packing Report dashboard rendering 4 machine cards with subtle borders, rounded corners, and blue (#2563EB) accents.
    - Added automatic continuous run detection from loaded daily HPR records via `qualityRepository.load(date)`:
      - **NUMBERING Layout (13 Columns)**: `Job Name` | `Shift` | `Time` | `Pcs/Pack` | `Cartons` | `Defective Bottles` | `Defects` | `Lot No.` | `Mould` | `Section No.` | `GOB` | `Checker Name` | `QA-Shift Ex.`
      - **SQC/QC HOLD Layout (13 Columns)**: `Shift` | `Time` | `Job Name` | `Lot No.` | `Mould` | `Section` | `GOB` | `Defects` | `Pcs/Pack` | `Cartons` | `Defective Bottles` | `Checker Name` | `QA-Shift Ex.`
    - Implemented job-anchored row insertion (`+` button) inserting new rows immediately beneath the clicked bottle run, and row deletion (`-` button) for manually added rows with child re-anchoring.
    - Built a manual 12-hour floating time picker (`CellTimePicker`) with Hour, Minute, and AM/PM dropdowns, dismissing on click-outside, Escape, or page scroll.
    - Swallowed native `ArrowUp`/`ArrowDown` keystrokes in `CellNumInput` to prevent unintended numeric increments during inspection data entry.
    - Maintained isolated state stores for Numbering and SQC/QC Hold to guarantee non-interference when toggling views.
  - `src/components/quality/ProductionQualityMonitor.tsx`:
    - Added top-level navigation buttons for `SQC/QC HOLD` and `NUMBERING` (active machine view 6 with layout state `'sqc'` or `'numbering'`), integrated seamlessly with existing machine navigation and date selection.
- **Files Changed:**
  - `src/components/quality/Re-PackingReport.tsx`
  - `src/components/quality/ProductionQualityMonitor.tsx`
- **API or DB Impact:**
  - Zero database schema changes. Zero backend API modifications. Display formatting, state management, and UI reporting enhancements reusing existing read-only daily quality records.

---

### 2026-10-30 — Responsive Shift-Wise Card Styling, Clean White Machine Rows, and Spaced Subtotals in Machine Wise Production and Efficiency Report
- **Problem:**
  - `QualityReport`:
    - On tablets, laptops, and smaller viewports, the Shift-Wise Efficiency card's fixed 30% container width compressed table columns and caused layout overflow.
    - Alternating pastel machine tint backgrounds (`#EFF6FF`, `#F0FDF4`, `#FFFBEB`, `#F5F3FF`) across body rows generated visual clutter in dense data grids.
    - Machine subtotals (`Machine <M> Total`) and the Grand Total row lacked visual demarcation from preceding and succeeding rows, reducing readability when scanning multi-machine reports.
- **Root Cause:**
  - The Shift-Wise card lacked viewport-adaptive CSS media queries.
  - Machine background colors were originally configured with machine-specific pastel fills rather than a standardized clean white surface.
  - Table row mapping lacked spacer elements between machine groupings.
- **Fix:**
  - `src/components/quality/QualityReport.tsx`:
    - Added responsive container classes (`.dppr-sw-card` and `.dppr-sw-scroll`) with media queries: 30% width on desktop, 45% on screens $\le 1200\text{px}$, 70% on screens $\le 900\text{px}$, and 100% on screens $\le 640\text{px}$ with a minimum width of 400px and contained horizontal scrolling.
    - Standardized `MACHINE_ROW_BG` across all four machines to clean `#ffffff`, updating hover states to subtle light blue tints (`#eff6ff` for machine subtotals and `#dbeafe` for the grand total).
    - Inserted 6px transparent spacer rows (`aria-hidden="true"`) below each `Machine <M> Total` row and the `Grand Total` row for clean visual separation.
    - Highlighted the bottom Shift-Wise Total row's overall efficiency cell with `#dbeafe` background and `#93c5fd` top border.
- **Files Changed:**
  - `src/components/quality/QualityReport.tsx`
- **API or DB Impact:**
  - Zero database schema changes. Zero API contract changes. Purely frontend styling and responsive layout improvements.

---

### 2026-10-28 — Machine Wise Production and Efficiency Naming, Runtime Minutes in Machine Subtotals, Row-Wise Overall Efficiency & Centered Shift-Wise Card
- **Problem:**
  - `QualityReport`:
    - The main table header was labeled "Daily Production Performance Report", which did not conform to the plant's standardized operational nomenclature "Machine Wise Production and Efficiency".
    - The upper "Shift-Wise Efficiency Report" card was left-aligned with a redundant inner header container, right-aligned cell values, and a generic "Efficiency %" column header.
    - In the machine subtotal rows (`Machine <M> Total`), the "Runtime (Min)" column rendered an empty spacer cell, missing the aggregate operational minutes across that machine's bottle runs.
    - In individual bottle/job rows, the "Overall" efficiency column displayed the entire machine's day-wide overall efficiency (`machineOverallEff`) rather than reflecting the specific bottle run's own efficiency across its active shifts.
    - The `fmtEff` formatting helper retained a two-decimal fallback (`.toFixed(2)`), conflicting with the plant-standard 1-decimal efficiency display (`0.0%`).
- **Root Cause:**
  - Report header titles were not updated to reflect refined nomenclature requirements.
  - `machineTotals` calculation accumulated units and draw but omitted `runtimeMinutes`.
  - Main table row mapping referenced `machineOverallEff.get(r.machineNo)` directly rather than computing the row's own average shift efficiency.
  - `fmtEff` was not updated to 1-decimal precision during the previous refactoring step.
- **Fix:**
  - `src/components/quality/QualityReport.tsx`:
    - Renamed the main report header to "Machine Wise Production and Efficiency".
    - Streamlined the upper "Shift-Wise Efficiency Report" card: removed the inner header box, horizontally centered the container (`marginLeft: 'auto'`, `marginRight: 'auto'`), updated the efficiency column group header to "Shift Efficiency %", and centered numeric efficiency percentages in table cells (`textAlign: 'center'`).
    - Added `runtimeMinutes` accumulation to `machineTotals` and rendered the machine's total runtime in bold (`mt?.runtimeMinutes ? mt.runtimeMinutes : '—'`) in the `Machine <M> Total` subtotal row.
    - Implemented bottle-specific row-wise overall efficiency calculation (`rowOverallEff`), averaging only the non-null shift efficiencies (`r.shiftEff.filter(v => v !== null)`) for that specific job run, while maintaining the authoritative machine-level overall efficiency on the `Machine <M> Total` row.
    - Standardized `fmtEff` to format all efficiency percentages with one decimal place (`n.toFixed(1)`).
- **Files Changed:**
  - `src/components/quality/QualityReport.tsx`
- **API or DB Impact:**
  - Zero database schema changes. Zero API contract changes. Display formatting, layout optimization, and UI reporting enhancements only.

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
