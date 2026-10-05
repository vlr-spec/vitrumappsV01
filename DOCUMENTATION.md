## Table of Contents
- [1. Overview](#1-overview)
- [2. Database Schema](#2-database-schema)
- [3. Backend API](#3-backend-api)
- [4. Frontend Structure](#4-frontend-structure)
- [5. Known Issues and History](#5-known-issues-and-history)
- [6. Setup and Run](#6-setup-and-run)

## 1. Overview
The Vitrum Glass application is a production-planning ERP focused on glass bottle manufacturing schedules. The implemented core supports:
- user authentication,
- planning jobs by date/machine,
- bottle and machine master management,
- bottle configuration management,
- holiday master,
- job extension/deletion and draw/quantity calculations,
- export/print of planning data.

### Users and roles (from code)
- `Editor`: required for all write operations on production resources (`require_manager_role` in `Backend/app/api/deps.py`).
- `Viewer`: allowed at signup, can authenticate and access authenticated reads, but blocked from write endpoints by role guard.
- `Admin`: mentioned in product/readme language, but signup only allows `Editor`/`Viewer`, and backend role checks explicitly require `Editor` for modifications. **Needs verification** for actual Admin behavior.

### Tech stack (from config/code)
- **Frontend**: React 19 + TypeScript + Vite (`package.json`), UI with Tailwind-related packages and `lucide-react`, export via `exceljs` and `jspdf`.
- **Backend**: FastAPI + SQLAlchemy + Pydantic (`Backend/requirements.txt`), served by Uvicorn (`Backend/Dockerfile`, `Backend/app/main.py`).
- **Database**: SQLAlchemy models with SQLite default (`Backend/app/core/config.py`, `Backend/.env.example`) and optional PostgreSQL URL normalization.
- **Deployment/runtime**:
  - Docker multi-service (`docker-compose.yml`) with frontend and backend containers.
  - Frontend served via Nginx in production image (`Dockerfile`, `nginx.conf`).
  - CI pipeline builds/tests frontend and backend and pushes container images to GHCR (`.github/workflows/ci.yml`).

### Implemented System Modules
The active modules in the application include:
- **Production Planning**: `src/components/planning/*`, `context/ERPContext.tsx`, `services/planningRepository.ts`, `Backend/app/api/production/jobs.py`. Features multi-machine calendar grids, automatic job cascading, cumulative quantities, auto-save, end-job modal, and drawer editing.
- **Master Management**: `src/components/master-management/*` (`BottleMasterPanel`, `BottleExportPanel`, `HolidayMasterPanel`, `MachinesModule`). Features machine section speeds/weights, bottle configs, holiday exclusions, and Excel/PDF export.
- **Quality Control**: `src/components/quality/ProductionQualityMonitor.tsx`, `src/services/qualityRepository.ts`, `Backend/app/api/production/quality_daily.py`, `Backend/app/api/production/quality_defects.py`. Features hourly checks, defect classifications, auto-saving, weight efficiency (% WT EFF), and daily production performance tracking.
- **Authentication & RBAC**: `src/context/AuthContext.tsx`, `src/components/auth/LoginPage.tsx`, `Backend/app/api/auth.py`, `Backend/app/api/access.py`, `Backend/app/api/permissions.py`. Role-based permissions (`auth.module_master`, `auth.user_module_permissions`) guarding module-level reads and edits.
- **Reports & Exporting**: Standardized branded company headers (`src/utils/reportHeader.ts`) across planning exports, bottle configuration reports, and quality performance sheets.

Placeholders / Future Modules:
- `DashboardModule` and `SettingsModule` currently render containers ready for upcoming analytics widgets.

## 2. Database Schema
Source: SQLAlchemy models under `Backend/app/models/*.py`.

> Note: tables are optionally placed in schema `production` for non-SQLite via `production_table_args()`.

### `users`
- `employee_id` `String` **PK**, indexed, non-null
- `employee_name` `String` non-null
- `department` `String` non-null
- `email` `String` unique, indexed, non-null
- `phone_number` `String` indexed, non-null
- `password` `String` non-null
- `role` `String` non-null
- `is_active` `Boolean` non-null, default `True`
- `created_at` `DateTime(timezone=True)` non-null, server default `now()`

### `machine_master`
- `machine_no` `Integer` **PK**, indexed, non-null
- `gob_type` `Integer` non-null
- `max_section` `Integer` non-null

### `bottle_master`
- `bottle_id` `Integer` **PK**, indexed, non-null
- `bottle_name` `String(150)` non-null

### `bottle_configuration`
**Composite primary key**: (`machine_no`, `bottle_id`, `section`)
- `machine_no` `Integer` **PK**, **FK** → `machine_master.machine_no`
- `bottle_id` `Integer` **PK**, **FK** → `bottle_master.bottle_id`
- `section` `Integer` **PK`
- `weight` `Numeric(10,2)` non-null
- `speeds` `Numeric(10,2)` non-null

### `production_job`
- `job_id` `Integer` **PK**, indexed, non-null
- `plan_date` `Date` non-null
- `machine_no` `Integer` non-null
- `start_time` `DateTime` non-null
- `bottle_id` `Integer` non-null
- `section` `Integer` non-null
- `weight` `Numeric(10,2)` non-null
- `speeds` `Numeric(10,2)` non-null
- `draw` `Numeric(10,2)` non-null
- `quantity` `Numeric(12,2)` non-null
- `required_bottles` `Numeric(14,2)` nullable
- `estimated_completion` `DateTime` nullable
- `completion_time` `DateTime` nullable
- `changeover_minutes` `Integer` default `0`
- `status` `String(20)` default `"Planned"`
- Unique constraint `uix_1` on (`plan_date`, `machine_no`, `start_time`)

### `job_packaging`
**Composite primary key**: (`job_id`, `packaging_type`)
- `job_id` `Integer` **PK**, **FK** → `production_job.job_id`
- `packaging_type` `String(2)` **PK`
- `plan_date` `Date` nullable
- `machine_no` `Integer` nullable
- `bottle_id` `Integer` nullable
- `section` `Integer` nullable
- `start_time` `DateTime` nullable
- `quantity` `Numeric(12,2)` non-null
- `pallet_packing` `Boolean` default `False`
- `pallet_quantity` `Numeric(12,2)` nullable

### `audit_logs`
- `id` `Integer` **PK**, indexed, non-null
- `user_id` `String` nullable, **FK** → `users.employee_id`
- `action` `String` non-null
- `details` `String` nullable
- `timestamp` `DateTime(timezone=True)` server default `now()`

### `holiday_master`
- `holiday_date` `Date` **PK**, non-null
- `holiday_name` `String(150)` non-null

### Foreign key enforcement in plain language
- `bottle_configuration.machine_no` must reference an existing machine.
- `bottle_configuration.bottle_id` must reference an existing bottle master row.
- `job_packaging.job_id` ties each packaging row to one production job.
- `audit_logs.user_id` (if present) must reference an existing user employee ID.

### ER-style relationship summary
- A `production_job` has many `job_packaging` rows.
- A `job_packaging` row belongs to one `production_job`.
- A `bottle_configuration` row belongs to one machine and one bottle master record.
- A machine can have many bottle configurations.
- A bottle can have many bottle configurations across machines/sections.
- `audit_logs` belongs to users (optional user reference).

## 3. Backend API
Source: `Backend/app/main.py`, routers under `Backend/app/api/*`.

### Auth and global auth behavior
- All `/api/production/*` routers are mounted with `Depends(get_current_user)` in `main.py`.
- Write endpoints additionally enforce `Editor` role via `require_manager_role`.
- `/api/auth/*` endpoints handle login/session and account actions.

### Health
#### `GET /health`
- Purpose: health probe.
- Auth: none.
- Response: `{ status, service, db_url }`.

### Authentication router (`/api/auth`)
#### `POST /api/auth/login`
- Body: `{ user_id, password }`.
- Behavior: user lookup by email or phone, session token creation.
- Response: `{ token, user: { employee_id, employee_name, department, email, phone_number, role } }`.
- Auth: none.

#### `POST /api/auth/signup`
- Body: `{ employee_id, employee_name, department, email, phone_number, password, role }`.
- Role validation: only `Editor` or `Viewer`.
- Response: `{ message: "Account created successfully" }`.
- Auth: none.

#### `GET /api/auth/me`
- Purpose: current authenticated user profile.
- Response: same user object shape as login.
- Auth: bearer token required.

#### `POST /api/auth/change-password`
- Body: `{ current_password, new_password }`.
- Response: `{ message: "Password updated successfully" }`.
- Auth: bearer token required.

#### `POST /api/auth/logout`
- Purpose: invalidate current in-memory session token.
- Response: HTTP 204 no body.
- Auth: optional bearer token (if present, token removed).

### Machines router (`/api/production/machines`)
#### `GET /api/production/machines/`
- Purpose: list machine master rows.
- Response: array of `{ machine_no, gob_type, max_section }`.
- Auth: authenticated user.

#### `POST /api/production/machines/`
- Purpose: create machine row with hard validation for machines 1..4.
- Body: `{ machine_no, gob_type, max_section }`.
- Response: created machine row.
- Auth: authenticated + `Editor`.

#### `PUT /api/production/machines/{machine_no}`
- Purpose: update machine gob/section config.
- Body: `{ machine_no, gob_type, max_section }`.
- Response: updated machine row.
- Auth: authenticated + `Editor`.

### Products router (`/api/production/products`)
#### `GET /api/production/products/bottles/`
- Response: array `{ bottle_id, bottle_name }`.
- Auth: authenticated.

#### `POST /api/production/products/bottles/`
- Body: `{ bottle_name }`.
- Response: created bottle `{ bottle_id, bottle_name }`.
- Auth: authenticated + `Editor`.

#### `PUT /api/production/products/bottles/{bottle_id}`
- Body: `{ bottle_name }`.
- Response: updated bottle.
- Auth: authenticated + `Editor`.

#### `GET /api/production/products/configurations/`
- Response: array `{ machine_no, bottle_id, section, weight, speeds }`.
- Auth: authenticated.

#### `POST /api/production/products/configurations/`
- Body: `{ machine_no, bottle_id, section, weight, speeds }`.
- Response: created configuration row.
- Auth: authenticated + `Editor`.

#### `PUT /api/production/products/configurations/{machine_no}/{bottle_id}/{section}`
- Body: `{ machine_no, bottle_id, section, weight, speeds }`.
- Response: updated configuration row.
- Auth: authenticated + `Editor`.

#### `DELETE /api/production/products/configurations/{machine_no}/{bottle_id}/{section}`
- Response: `{ ok: true }`.
- Auth: authenticated + `Editor`.

### Jobs router (`/api/production/jobs`)
#### `GET /api/production/jobs/`
- Query params (all optional): `from_date`, `to_date`, `machine_no`, `limit`, `order_by`.
- Purpose: list jobs with `packaging` relation loaded.
- Response: array of job objects including packaging collection:
  - `job_id, plan_date, machine_no, start_time, bottle_id, section, weight, speeds, draw, quantity, required_bottles, estimated_completion, completion_time, changeover_minutes, status, packaging[]`.
- Auth: authenticated.

#### `POST /api/production/jobs/`
- Purpose: create or upsert by (`plan_date`,`machine_no`,`start_time`), compute quantity/draw from machine/config.
- Body (accepted schema): `plan_date, machine_no, start_time, bottle_id, section?, draw?, required_bottles?, estimated_completion?, completion_time?, changeover_minutes?, status?, packaging[]`.
- Response: saved job object (with packaging relation).
- Auth: authenticated + `Editor`.

#### `POST /api/production/jobs/extend/`
- Purpose: extend one job by `days`, shift subsequent same-machine jobs forward.
- Body: `{ plan_date, machine_no, start_time, days }`.
- Response: array of affected jobs for same machine from source date onward.
- Auth: authenticated + `Editor`.

#### `DELETE /api/production/jobs/{plan_date}/{machine_no}/{start_time}`
- Purpose: delete job, delete linked packaging, shift subsequent jobs backward to close gap.
- Response: HTTP 204 no body.
- Auth: authenticated + `Editor`.

### Audit logs router (`/api/production/audit-logs`)
#### `GET /api/production/audit-logs/`
- Purpose: latest 50 audit entries for notification panel.
- Response: array of `{ id, user_id, action, details, timestamp }`.
- Auth: authenticated.


### Holidays router (`/api/production/holidays`)
#### `GET /api/production/holidays/`
- Response: ordered array `{ holiday_date, holiday_name }`.
- Auth: authenticated.

#### `POST /api/production/holidays/`
- Body: `{ holiday_date, holiday_name }`.
- Response: created holiday.
- Auth: authenticated + `Editor`.

#### `PUT /api/production/holidays/{holiday_date}`
- Body: `{ holiday_date, holiday_name }`.
- Response: updated holiday.
- Auth: authenticated + `Editor`.

#### `DELETE /api/production/holidays/{holiday_date}`
- Response: `{ ok: true }`.
- Auth: authenticated + `Editor`.

### Frontend/backend API alignment notes
- Frontend calls found for auth, jobs, machines, bottles, configurations, holidays.
- Endpoint currently present but **not called by frontend code found in this pass**: `GET /api/production/audit-logs/`.
- Frontend sends `production_hours` in some job payloads, but backend `ProductionJobCreate` schema has no `production_hours` field. **Needs verification**.
- `AuditLogResponse.user_id` schema is typed `int`, while model stores `String` FK to `users.employee_id`. **Needs verification**.

## 4. Frontend Structure
Source: `src/*`.

### Top-level structure
- `App.tsx`: wraps app with `AuthProvider`; renders `LoginPage` if unauthenticated, else `ERPProvider` + main layout.
- `context/AuthContext.tsx`: login/signup/me/change-password/logout and token persistence via `localStorage`.
- `context/ERPContext.tsx`: main module state and orchestration around repository cache + planning actions.
- `services/planningRepository.ts`: API-backed data layer and in-memory cache for machines/bottles/configs/jobs.
- `components/layout/*`: header/sidebar module navigation.

### Major modules/components
- `components/planning/PlanningModule.tsx`: hosts `ProductionPlanningPage` and `PlanningDrawer`.
- `components/planning/ProductionPlanningPage.tsx`: grid/register UI, date filtering, month navigation, local editing state (`machineLists`, `completedJobMap`), save-to-DB batch flow, extend/delete/end-job flows, export/print.
- `components/planning/PlanningDrawer.tsx`: modal form for creating/editing jobs with machine+bottle+section selection, metrics preview, packaging allocation, pallet options; submits to `saveJob` in context.
- `components/planning/EditMachineModal.tsx`: grid cell edit modal for bottle/start-time/packing/required quantity.
- `components/planning/EndJobModal.tsx`: marks job completed and schedules next start with changeover delay.
- `components/master-management/MachinesModule.tsx`: container router for machine, bottle, and holiday masters.
- `components/master-management/BottleMasterPanel.tsx`: create bottle, edit names, and manage machine-specific section speed/weight configurations.
- `components/master-management/BottleExportPanel.tsx`: dedicated export panel for bottle configurations to Excel and PDF.
- `components/master-management/HolidayMasterPanel.tsx`: calendar view and CRUD operations for factory holidays.
- `components/quality/ProductionQualityMonitor.tsx`: comprehensive quality monitoring dashboard with hourly bottle entries, defect tracking, auto-save, weight efficiency (% WT EFF), and daily performance reporting.
- `components/profile/ProfileModule.tsx`: view authenticated user profile, roles, and change password.
- `components/dashboard`, `components/settings`: layout placeholders ready for upcoming widgets.

### End-to-end core data flows
#### A) Create/edit a production job (drawer/context/repository/backend)
1. User opens `PlanningDrawer` (new or edit context from `ERPContext`).
2. Drawer resolves machine/bottle/section and computes metrics (`calculateProductionMetrics`, estimated completion, draw, good bottles).
3. On submit, drawer builds packaging rows and calls `saveJob` from `ERPContext`.
4. `ERPContext.saveJob` validates machine/config; creates one or more segment rows (for non-edit path) and calls repository methods (`createProductionJobsBatch` or `updateProductionJob`).
5. `planningRepository._postJob` maps frontend IDs/times to backend payload and posts to `POST /api/production/jobs/`.
6. Backend upserts by unique (`plan_date`,`machine_no`,`start_time`), computes qty/draw, replaces packaging rows, and commits.
7. Context re-initializes repository data for active date window and triggers planner refresh.

#### B) Save grid changes from planning register
1. User edits entries directly in `ProductionPlanningPage` local machine grid (`machineLists` + `completedJobMap`).
2. `handleSaveToDb` flattens rows into `ProductionJobRow` payload list, computing changeover/segment timings and packaging payloads.
3. Calls `planningRepository.createProductionJobsBatch` (parallel upserts).
4. Compares current grid keys to cached DB keys and deletes stale jobs with `deleteProductionJob`.
5. Reloads scoped jobs via `reloadJobsForWindow`; clears dirty flag.

#### C) Extend job workflow
1. UI action in planning grid triggers extend handler.
2. Current implementation in `ProductionPlanningPage` adjusts local rows (`handleExtendJob`) and marks dirty.
3. Persisting happens when user clicks save (batch upsert + stale deletion).
4. Backend also has dedicated `POST /jobs/extend/` and repository method `extendProductionJob`; this path is used from `ERPContext.extendJob` (drawer/context APIs), but not the main planning page flow in current code. **Needs verification** for intended canonical path.

### Key service/repository responsibilities
- `utils/api.ts`: shared fetch wrapper, auth header injection, error normalization.
- `services/planningRepository.ts`:
  - fetch/cache machines/bottles/configs/jobs (`init`),
  - normalize API ↔ UI row formats,
  - perform job CRUD/extend and master-data CRUD,
  - utility conversions for machine IDs and datetime formatting.
- `utils/planningCalculations.ts` and `utils/calculations.ts`: draw, quantity, good bottle, completion/date math.
- `utils/exportData.ts`: fetches jobs in selected range + previous day context and builds flattened export rows.

## 5. Known Issues and History
Primary source here: git history (`git log`/`git show`).

### Significant historical changes (Module 1)
1. **Authentication introduced** (`89dd41b`): added backend auth router + frontend auth context/login UI.
2. **Password handling changed** (`5a86e37`): commit message indicates hash function removed; current code comments show plain-text comparison/storage.
3. **Extend-job capability added** (`bb90936`): introduced backend `POST /jobs/extend/` and corresponding scheduling-shift logic.
4. **Revert of earlier job_id/continuation change** (`3785f01`): commit message says previous PR behavior was rolled back to “single row” direction.
5. **Schema/key model changed to surrogate job key** (`813a1bb`): `production_job` switched to `job_id` PK + unique (`plan_date`,`machine_no`,`start_time`), and `job_packaging` moved to `job_id` FK linkage.
6. **Later fixes aligned API operations to `job_id` linkage** (`813a1bb` diff): job update/delete/extend packaging operations moved from date/machine/start filters to `job_id` filters.
7. **Frontend data source changed to DB-backed repository** (`8c7ee2b`, plus earlier integration commits): bottle master/config and planning flows moved to API-backed reads/writes.

Where rationale was unclear from commit messages, interpretation above is from the changed diffs.

### Current open issues / ambiguity markers found in code
- `src/data/planningSchema.ts` includes `production_hours`, but backend create schema does not accept it explicitly. **Needs verification**.
- `Backend/app/schemas/audit_log.py` defines `user_id: int`, while model FK is string employee ID. **Needs verification**.
- `ProductionPlanningPage` local extend flow differs from repository/backend extend endpoint usage. **Needs verification** of intended single source of truth.
- Auth/session implementation uses in-memory session map (`SESSIONS`) in backend process; behavior across multi-instance deployment is **unclear from code**.
- One line in viewed `auth.py` response was masked by tooling during this pass; comments indicate plain-text password storage/comparison, but exact assignment statement display was partially redacted. **Needs verification**.

### TODO/FIXME/HACK scan result
- No explicit `TODO`/`FIXME`/`HACK` markers were found in application source files during this pass.
- Matches appeared in lockfiles due package names like `debug` (not actionable TODO markers).

## 6. Setup and Run
Derived from `package.json`, `Backend/requirements.txt`, Docker files, `.env.example`, and CI workflow.

### Option A: Local (separate backend + frontend)
1. **Backend setup**
   - `cd /home/runner/work/production-planningV05/production-planningV05/Backend`
   - Install dependencies: `pip install -r requirements.txt`
   - Configure env (optional): set `DATABASE_URL` (defaults to `sqlite:///./vitrumglass.db`).
   - Run backend: `uvicorn app.main:app --host 0.0.0.0 --port 8000`

2. **Frontend setup**
   - `cd /home/runner/work/production-planningV05/production-planningV05`
   - Install dependencies: `bun install` (CI path) or `npm install` (lockfile/scripts also present).
   - Set `VITE_API_URL` if needed (defaults to `http://127.0.0.1:8000` in code).
   - Run dev server: `bun run dev` or `npm run dev`.

3. **Build/lint commands (from scripts/CI)**
   - Lint/type-check: `bun run lint` / `npm run lint`
   - Build: `bun run build` / `npm run build`

### Option B: Docker Compose
From repo root:
- `docker compose up --build`

This starts:
- backend on `:8000` (with `DATABASE_URL` defaulting to sqlite file under `/app/data/vitrumglass.db` in volume `backend-data`),
- frontend on `:3000`.

### Environment variables present in repo/config
- Body: `{ bottle_name }`.
- Response: created bottle `{ bottle_id, bottle_name }`.
- Auth: authenticated + `Editor`.

#### `PUT /api/production/products/bottles/{bottle_id}`
- Body: `{ bottle_name }`.
- Response: updated bottle.
- Auth: authenticated + `Editor`.

#### `GET /api/production/products/configurations/`
- Response: array `{ machine_no, bottle_id, section, weight, speeds }`.
- Auth: authenticated.

#### `POST /api/production/products/configurations/`
- Body: `{ machine_no, bottle_id, section, weight, speeds }`.
- Response: created configuration row.
- Auth: authenticated + `Editor`.

#### `PUT /api/production/products/configurations/{machine_no}/{bottle_id}/{section}`
- Body: `{ machine_no, bottle_id, section, weight, speeds }`.
- Response: updated configuration row.
- Auth: authenticated + `Editor`.

#### `DELETE /api/production/products/configurations/{machine_no}/{bottle_id}/{section}`
- Response: `{ ok: true }`.
- Auth: authenticated + `Editor`.

### Jobs router (`/api/production/jobs`)
#### `GET /api/production/jobs/`
- Query params (all optional): `from_date`, `to_date`, `machine_no`, `limit`, `order_by`.
- Purpose: list jobs with `packaging` relation loaded.
- Response: array of job objects including packaging collection:
  - `job_id, plan_date, machine_no, start_time, bottle_id, section, weight, speeds, draw, quantity, required_bottles, estimated_completion, completion_time, changeover_minutes, status, packaging[]`.
- Auth: authenticated.

#### `POST /api/production/jobs/`
- Purpose: create or upsert by (`plan_date`,`machine_no`,`start_time`), compute quantity/draw from machine/config.
- Body (accepted schema): `plan_date, machine_no, start_time, bottle_id, section?, draw?, required_bottles?, estimated_completion?, completion_time?, changeover_minutes?, status?, packaging[]`.
- Response: saved job object (with packaging relation).
- Auth: authenticated + `Editor`.

#### `POST /api/production/jobs/extend/`
- Purpose: extend one job by `days`, shift subsequent same-machine jobs forward.
- Body: `{ plan_date, machine_no, start_time, days }`.
- Response: array of affected jobs for same machine from source date onward.
- Auth: authenticated + `Editor`.

#### `DELETE /api/production/jobs/{plan_date}/{machine_no}/{start_time}`
- Purpose: delete job, delete linked packaging, shift subsequent jobs backward to close gap.
- Response: HTTP 204 no body.
- Auth: authenticated + `Editor`.

### Audit logs router (`/api/production/audit-logs`)
#### `GET /api/production/audit-logs/`
- Purpose: latest 50 audit entries for notification panel.
- Response: array of `{ id, user_id, action, details, timestamp }`.
- Auth: authenticated.


### Holidays router (`/api/production/holidays`)
#### `GET /api/production/holidays/`
- Response: ordered array `{ holiday_date, holiday_name }`.
- Auth: authenticated.

#### `POST /api/production/holidays/`
- Body: `{ holiday_date, holiday_name }`.
- Response: created holiday.
- Auth: authenticated + `Editor`.

#### `PUT /api/production/holidays/{holiday_date}`
- Body: `{ holiday_date, holiday_name }`.
- Response: updated holiday.
- Auth: authenticated + `Editor`.

#### `DELETE /api/production/holidays/{holiday_date}`
- Response: `{ ok: true }`.
- Auth: authenticated + `Editor`.

### Frontend/backend API alignment notes
- Frontend calls found for auth, jobs, machines, bottles, configurations, holidays.
- Endpoint currently present but **not called by frontend code found in this pass**: `GET /api/production/audit-logs/`.
- Frontend sends `production_hours` in some job payloads, but backend `ProductionJobCreate` schema has no `production_hours` field. **Needs verification**.
- `AuditLogResponse.user_id` schema is typed `int`, while model stores `String` FK to `users.employee_id`. **Needs verification**.

## 4. Frontend Structure
Source: `src/*`.

### Top-level structure
- `App.tsx`: wraps app with `AuthProvider`; renders `LoginPage` if unauthenticated, else `ERPProvider` + main layout.
- `context/AuthContext.tsx`: login/signup/me/change-password/logout and token persistence via `localStorage`.
- `context/ERPContext.tsx`: main module state and orchestration around repository cache + planning actions.
- `services/planningRepository.ts`: API-backed data layer and in-memory cache for machines/bottles/configs/jobs.
- `components/layout/*`: header/sidebar module navigation.

### Major modules/components
- `components/planning/PlanningModule.tsx`: hosts `ProductionPlanningPage` and `PlanningDrawer`.
- `components/planning/ProductionPlanningPage.tsx`: grid/register UI, date filtering, month navigation, local editing state (`machineLists`, `completedJobMap`), save-to-DB batch flow, extend/delete/end-job flows, export/print.
- `components/planning/PlanningDrawer.tsx`: modal form for creating/editing jobs with machine+bottle+section selection, metrics preview, packaging allocation, pallet options; submits to `saveJob` in context.
- `components/planning/EditMachineModal.tsx`: grid cell edit modal for bottle/start-time/packing/required quantity.
- `components/planning/EndJobModal.tsx`: marks job completed and schedules next start with changeover delay.
- `components/machines/MachinesModule.tsx`: machine, bottle/config, and holiday master panels.
- `components/machines/BottleMasterPanel.tsx`: create bottle + upsert bottle configurations by machine sections.
- `components/machines/MachineMasterPanel.tsx`: update machine max sections.
- `components/machines/HolidayMasterPanel.tsx`: CRUD for holiday dates.
- `components/profile/ProfileModule.tsx`: view user and change password.
- `components/dashboard`, `components/settings`: minimal/placeholder.
- `components/reports`, `components/quality`: explicit “Not Developed Yet” placeholders.

### End-to-end core data flows
#### A) Create/edit a production job (drawer/context/repository/backend)
1. User opens `PlanningDrawer` (new or edit context from `ERPContext`).
2. Drawer resolves machine/bottle/section and computes metrics (`calculateProductionMetrics`, estimated completion, draw, good bottles).
3. On submit, drawer builds packaging rows and calls `saveJob` from `ERPContext`.
4. `ERPContext.saveJob` validates machine/config; creates one or more segment rows (for non-edit path) and calls repository methods (`createProductionJobsBatch` or `updateProductionJob`).
5. `planningRepository._postJob` maps frontend IDs/times to backend payload and posts to `POST /api/production/jobs/`.
6. Backend upserts by unique (`plan_date`,`machine_no`,`start_time`), computes qty/draw, replaces packaging rows, and commits.
7. Context re-initializes repository data for active date window and triggers planner refresh.

#### B) Save grid changes from planning register
1. User edits entries directly in `ProductionPlanningPage` local machine grid (`machineLists` + `completedJobMap`).
2. `handleSaveToDb` flattens rows into `ProductionJobRow` payload list, computing changeover/segment timings and packaging payloads.
3. Calls `planningRepository.createProductionJobsBatch` (parallel upserts).
4. Compares current grid keys to cached DB keys and deletes stale jobs with `deleteProductionJob`.
5. Reloads scoped jobs via `reloadJobsForWindow`; clears dirty flag.

#### C) Extend job workflow
1. UI action in planning grid triggers extend handler.
2. Current implementation in `ProductionPlanningPage` adjusts local rows (`handleExtendJob`) and marks dirty.
3. Persisting happens when user clicks save (batch upsert + stale deletion).
4. Backend also has dedicated `POST /jobs/extend/` and repository method `extendProductionJob`; this path is used from `ERPContext.extendJob` (drawer/context APIs), but not the main planning page flow in current code. **Needs verification** for intended canonical path.

### Key service/repository responsibilities
- `utils/api.ts`: shared fetch wrapper, auth header injection, error normalization.
- `services/planningRepository.ts`:
  - fetch/cache machines/bottles/configs/jobs (`init`),
  - normalize API ↔ UI row formats,
  - perform job CRUD/extend and master-data CRUD,
  - utility conversions for machine IDs and datetime formatting.
- `utils/planningCalculations.ts` and `utils/calculations.ts`: draw, quantity, good bottle, completion/date math.
- `utils/exportData.ts`: fetches jobs in selected range + previous day context and builds flattened export rows.

## 5. Known Issues and History
Primary source here: git history (`git log`/`git show`).

### Significant historical changes (Module 1)
1. **Authentication introduced** (`89dd41b`): added backend auth router + frontend auth context/login UI.
2. **Password handling changed** (`5a86e37`): commit message indicates hash function removed; current code comments show plain-text comparison/storage.
3. **Extend-job capability added** (`bb90936`): introduced backend `POST /jobs/extend/` and corresponding scheduling-shift logic.
4. **Revert of earlier job_id/continuation change** (`3785f01`): commit message says previous PR behavior was rolled back to “single row” direction.
5. **Schema/key model changed to surrogate job key** (`813a1bb`): `production_job` switched to `job_id` PK + unique (`plan_date`,`machine_no`,`start_time`), and `job_packaging` moved to `job_id` FK linkage.
6. **Later fixes aligned API operations to `job_id` linkage** (`813a1bb` diff): job update/delete/extend packaging operations moved from date/machine/start filters to `job_id` filters.
7. **Frontend data source changed to DB-backed repository** (`8c7ee2b`, plus earlier integration commits): bottle master/config and planning flows moved to API-backed reads/writes.

Where rationale was unclear from commit messages, interpretation above is from the changed diffs.

### Current open issues / ambiguity markers found in code
- `src/data/planningSchema.ts` includes `production_hours`, but backend create schema does not accept it explicitly. **Needs verification**.
- `Backend/app/schemas/audit_log.py` defines `user_id: int`, while model FK is string employee ID. **Needs verification**.
- `ProductionPlanningPage` local extend flow differs from repository/backend extend endpoint usage. **Needs verification** of intended single source of truth.
- Auth/session implementation uses in-memory session map (`SESSIONS`) in backend process; behavior across multi-instance deployment is **unclear from code**.
- One line in viewed `auth.py` response was masked by tooling during this pass; comments indicate plain-text password storage/comparison, but exact assignment statement display was partially redacted. **Needs verification**.

### TODO/FIXME/HACK scan result
- No explicit `TODO`/`FIXME`/`HACK` markers were found in application source files during this pass.
- Matches appeared in lockfiles due package names like `debug` (not actionable TODO markers).

## 6. Setup and Run
Derived from `package.json`, `Backend/requirements.txt`, Docker files, `.env.example`, and CI workflow.

### Option A: Local (separate backend + frontend)
1. **Backend setup**
   - `cd /home/runner/work/production-planningV05/production-planningV05/Backend`
   - Install dependencies: `pip install -r requirements.txt`
   - Configure env (optional): set `DATABASE_URL` (defaults to `sqlite:///./vitrumglass.db`).
   - Run backend: `uvicorn app.main:app --host 0.0.0.0 --port 8000`

2. **Frontend setup**
   - `cd /home/runner/work/production-planningV05/production-planningV05`
   - Install dependencies: `bun install` (CI path) or `npm install` (lockfile/scripts also present).
   - Set `VITE_API_URL` if needed (defaults to `http://127.0.0.1:8000` in code).
   - Run dev server: `bun run dev` or `npm run dev`.

3. **Build/lint commands (from scripts/CI)**
   - Lint/type-check: `bun run lint` / `npm run lint`
   - Build: `bun run build` / `npm run build`

### Option B: Docker Compose
From repo root:
- `docker compose up --build`

This starts:
- backend on `:8000` (with `DATABASE_URL` defaulting to sqlite file under `/app/data/vitrumglass.db` in volume `backend-data`),
- frontend on `:3000`.

### Environment variables present in repo/config
- `DATABASE_URL` (backend DB connection string).
- `VITE_API_URL` (frontend API base URL).
- `GEMINI_API_KEY` (root `.env.example`; appears unrelated to core planning module flows).
- `APP_URL` (root `.env.example`; app URL reference).

## Changelog

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
  - Backend Audit:
    - Audited all routers and services across the entire backend (including quality, HPR, machine master, and auth). Confirmed that all other date-based queries parse strings into `datetime.date` or `datetime` objects before querying, leaving `get_all_jobs` as the sole unparsed date filter.
- **Files Changed:**
  - `Backend/app/api/production/jobs.py` (function `get_all_jobs`)
  - `Backend/app/models/job.py` (model `JobMaster`)
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

### 2026-08-20 — Fix 500 Error on Job Deletion
- **What changed:** Parsed the `plan_date` and `start_time` string parameters into a proper Python `datetime` object before querying the database, fixing a Postgres type mismatch error when deleting jobs.
- **Files changed:** `Backend/app/api/production/jobs.py`
- **Why:** To resolve an `InvalidDatetimeFormat` error preventing job deletions.

## 7. Deployment to GitHub Pages

### Deploying the Frontend
The frontend application is configured for continuous deployment to GitHub Pages via GitHub Actions (`.github/workflows/deploy.yml`).

To configure and access the live application:
1. Ensure your code is pushed to the `main` branch. This automatically triggers the deployment workflow.
2. In your repository on GitHub, go to **Settings** → **Pages** (under the "Code and automation" section).
3. Under **Build and deployment**, set the **Source** to **Deploy from a branch**.
4. Set the **Branch** to `gh-pages` and the folder to `/(root)`, then click **Save**.
5. GitHub will now serve your application. Note the generated URL displayed at the top of the settings page (e.g., `https://<username>.github.io/<repo-name>/`).

### Backend/API Configuration
Because GitHub Pages only hosts static files, the FastAPI backend must be deployed separately (e.g., using Render, Railway, or AWS).

To connect the live frontend to a live backend:
1. In your GitHub repository, go to **Settings** → **Secrets and variables** → **Actions**.
2. Click on the **Variables** tab and add a new repository variable.
3. Name it `VITE_API_URL` and set its value to your live backend's URL (e.g., `https://my-backend.onrender.com`).
4. Re-run the deployment workflow (or push a new commit) so the frontend rebuilds with the new backend API URL injected.

# Analysis of `estimated_completion` Bug

## Issue Summary
The `handledSaveToDb` function in `ProductionPlanningPage.tsx` contained a rounding bug that could generate invalid time strings like `"21:60"`, causing backend 422 errors. The fix targeted only two lines in the function.

## Root Cause
- `Math.round(totalMins % 60)` could return `60` when `totalMins % 60` was `59.5`, violating backend validation rules.

## Fix Details
- **Lines Modified**: 575-585 in `ProductionPlanningPage.tsx`
- **Change**: Moved rounding to `totalMins` before decomposing:
  ```ts
  const roundedTotalMins = Math.round(totalMins);
  const ch = Math.floor(roundedTotalMins / 60) % 24;
  const cm = roundedTotalMins % 60;
  ```
- **Outcome**: Ensured `cm` always stays in `0-59` range.

## Compliance
- **Scope**: Single-file, single-location fix as required.
- **No Other Changes**: No modifications to `planningCalculations.ts`, `ERPContext.tsx`, or backend APIs.

<analysis>
The bug arose from unsafe rounding of fractional minutes in a critical time calculation. The fix adheres strictly to the user's constraints by isolating the correction to the precise location without broader codebase changes.
</analysis>

<summary>Fix applied to two lines in `handleSaveToDb` to prevent invalid minute values in `estimated_completion`. No off-target modifications made.</summary>