# Vitrum Glass Production Planning ERP — Technical Documentation

## Table of Contents
- [1. Overview](#1-overview)
- [2. Architecture & Deployment](#2-architecture--deployment)
- [3. Setup & Run](#3-setup--run)
- [4. Configuration](#4-configuration)
- [5. Database Schema](#5-database-schema)
- [6. API Reference & Conventions](#6-api-reference--conventions)
- [7. Authentication, Roles & Security](#7-authentication-roles--security)
- [8. Frontend Structure](#8-frontend-structure)
- [9. Testing & CI](#9-testing--ci)
- [10. Troubleshooting](#10-troubleshooting)
- [11. Known Issues](#11-known-issues)
- [Changelog](#changelog)

---

## 1. Overview
The Vitrum Glass application is an enterprise production-planning ERP specialized for glass container manufacturing plants. The platform coordinates manufacturing runs across multi-section production lines, manages bottle and machine technical specifications, tracks hourly quality and defect inspections, and provides dynamic role-based access control (RBAC).

### Core Capabilities
- **Production Schedule Planning**: Multi-machine calendar scheduling, forward-cascading schedule adjustments, automatic changeover calculation, cumulative good bottle projections, and batch persistence with optimistic concurrency.
- **Master Data Management**: Machine master configurations (Machines 1–4, Double/Triple Gob, maximum sections), bottle master specifications (catalog names, shared bottle weights), machine-specific section speed calibrations, and factory holiday management.
- **Quality Control (HPR)**: Hourly inspection registers, three-tier defect categorization (Critical, Major, Minor), weight distribution tracking (Front, Middle, Rear, Average), Weight Efficiency (% WT EFF), carton counts, and shift assignment logging.
- **Reporting & Exporting**: Branded executive export generation for daily schedules, bottle catalogs, and inspection records to Excel and PDF formats.
- **Dynamic Access Control**: Database-backed permissions governing read and edit capabilities per employee across functional modules.

### Tech Stack
- **Frontend**: React 19, TypeScript, Vite, Tailwind CSS, Lucide icons, ExcelJS, jsPDF.
- **Backend**: FastAPI, SQLAlchemy 2.0, Pydantic v2, Uvicorn.
- **Database**: PostgreSQL (production on AWS RDS / Render) with multi-schema partitioning (`production`, `auth`, `hpr`); SQLite fallback for local development and CI unit tests.

### Project History
For the complete dated log of all historical changes, architectural decisions, and bug fixes, refer to [CHANGELOG.md](file:///d:/V10/production-planningV05/CHANGELOG.md).

---

## 2. Architecture & Deployment

The application runs as a decoupled single-page application (SPA) communicating over HTTPS with a RESTful backend API.

```
+------------------------------------+           +------------------------------------+
|          Frontend Client           |           |          Backend Service           |
|  GitHub Pages (Static SPA)         |  HTTPS    |  Render Web Service (Linux Docker) |
|  React 19 + TypeScript + Vite      | --------> |  FastAPI + Uvicorn                 |
|  Environment: VITE_API_URL         |  Bearer   |  Port: 8000                        |
+------------------------------------+           +------------------------------------+
                                                                    |
                                                                    | psycopg3 (SSL)
                                                                    v
                                                 +------------------------------------+
                                                 |         PostgreSQL Database        |
                                                 |  AWS RDS / Managed Postgres        |
                                                 |  Schemas: production, auth, hpr    |
                                                 +------------------------------------+
```

### Hosting Environments
1. **Frontend Hosting (GitHub Pages)**
   - Deployed continuously via GitHub Actions (`.github/workflows/deploy.yml`) on pushes to `main`.
   - Static assets are compiled with `bun run build` and published to the `gh-pages` branch.
   - The backend API target is injected at build time via the repository variable `VITE_API_URL`.
2. **Backend Hosting (Render)**
   - Deployed as a Docker container using `Backend/Dockerfile`.
   - Runs `uvicorn app.main:app --host 0.0.0.0 --port 8000`.
   - Connects to managed PostgreSQL using the `DATABASE_URL` environment variable.
3. **Database Architecture**
   - Live PostgreSQL instances utilize three distinct schemas:
     - `production`: Manufacturing schedule jobs, machines, bottles, configurations, holidays, and audit logs.
     - `auth`: User authentication records, module catalog, and employee permissions.
     - `hpr`: Hourly production reports, shift assignments, defect master, and quality inspection metrics.

---

## 3. Setup & Run

### Prerequisites
- Node.js (v20+) or Bun (v1.1+)
- Python 3.11 or 3.12
- Git

### Option A: Local Development (Separate Services)

#### 1. Backend Service
```bash
cd Backend
python -m venv venv
# On Windows:
.\venv\Scripts\activate
# On Linux/macOS:
source venv/bin/activate

pip install -r requirements.txt
uvicorn app.main:app --host 0.0.0.0 --port 8000 --reload
```
*By default, the backend connects to a local SQLite database at `Backend/vitrumglass.db`.*

#### 2. Frontend Client
```bash
# From repository root:
bun install
# Or: npm install

# Start local Vite development server:
bun run dev
# Or: npm run dev
```
*The development server opens on `http://localhost:5173`. Set `VITE_API_URL=http://localhost:8000` in a `.env.local` file if connecting to an alternate backend.*

### Option B: Docker Compose
Run the entire stack locally in containers:
```bash
docker compose up --build
```
- Frontend: Accessible on `http://localhost:3000`
- Backend API: Accessible on `http://localhost:8000`
- Persistent SQLite data is mapped into the `backend-data` volume at `/app/data/vitrumglass.db`.

---

## 4. Configuration

### Environment Variables

| Variable | Scope | Purpose | Required in Prod | Example / Default |
| :--- | :--- | :--- | :---: | :--- |
| `DATABASE_URL` | Backend | PostgreSQL connection string | Yes | `postgresql://user:password@db-host:5432/dbname` (Defaults to `sqlite:///./vitrumglass.db`) |
| `SESSION_IDLE_TIMEOUT_DAYS` | Backend | Inactivity window before an idle session token is invalidated | No | `30` (Default: `30`) |
| `VITE_API_URL` | Frontend | Target backend API base URL | Yes | `https://api.example.com` (Default: `http://127.0.0.1:8000`) |

> **Security Note:** Never commit `.env` files containing live credentials. Store production connection strings securely in Render Environment Variables or GitHub Actions Secrets.

*Note on repository artifacts:* The root `.env.example` mentions `GEMINI_API_KEY` and `APP_URL`. These are Google AI Studio template artifacts and are not consumed by the core planning or quality modules.

---

## 5. Database Schema

Tables are mapped across three PostgreSQL schemas using SQLAlchemy models. When running against SQLite, schema namespaces are flattened automatically via `production_table_args()`, `auth_table_args()`, and `hpr_table_args()`.

### Schema: `production`

#### `production.users`
*Legacy user profile table used for employee department and display role.*
- `employee_id` (`String`, **PK**, index, non-null)
- `employee_name` (`String`, non-null)
- `department` (`String`, non-null)
- `email` (`String`, unique, index, non-null)
- `phone_number` (`String`, index, non-null)
- `password` (`String`, non-null) — *Note: Stored in plain text.*
- `role` (`String`, non-null) — *Display role: `"Editor"` or `"Viewer"`.*
- `is_active` (`Boolean`, default `True`, non-null)
- `created_at` (`DateTime(timezone=True)`, server default `now()`, non-null)

#### `production.machine_master`
*Physical glass forming machines.*
- `machine_no` (`Integer`, **PK**, index, non-null) — *Factory machines: 1, 2, 3, 4.*
- `gob_type` (`Integer`, non-null) — *`2` (Double Gob) or `3` (Triple Gob).*
- `max_section` (`Integer`, non-null) — *Total operational sections (e.g. 6, 8, 10).*

#### `production.bottle_master`
*Catalog of manufactured glass bottles.*
- `bottle_id` (`Integer`, **PK**, index, non-null)
- `bottle_name` (`String(150)`, non-null)
- `weight` (`Numeric(10,2)`, nullable) — *Shared bottle weight in grams.*

#### `production.bottle_configuration`
*Machine and section speed calibration per bottle.*
- `machine_no` (`Integer`, **PK**, **FK** → `machine_master.machine_no`)
- `bottle_id` (`Integer`, **PK**, **FK** → `bottle_master.bottle_id`)
- `section` (`Integer`, **PK**)
- `weight` (`Numeric(10,2)`, non-null) — *Operational weight.*
- `speeds` (`Numeric(10,2)`, non-null) — *Cuts per minute.*

#### `production.job_master`
*Surrogate registry for manufacturing job sequence identifiers.*
- `job_id` (`BigInteger`, **PK**, index, non-null)
- `created_at` (`DateTime`, server default `now()`)

#### `production.machine_job_sequence`
*Monotonically increasing sequence counters per machine.*
- `machine_no` (`Integer`, **PK**, non-null)
- `next_sequence` (`Integer`, default `1`, non-null)
*Job IDs are computed as `machine_no * 100 + sequence` and reserved concurrency-safely via `SELECT ... FOR UPDATE`.*

#### `production.production_job`
*Scheduled production segments on the calendar grid.*
- **Model Mapper PK**: Composite (`plan_date`, `machine_no`, `start_time`, `section`)
- `job_id` (`BigInteger`, **FK** → `job_master.job_id`, index, non-null)
- `plan_date` (`Date`, non-null)
- `machine_no` (`Integer`, non-null)
- `start_time` (`DateTime`, non-null)
- `bottle_id` (`Integer`, non-null)
- `section` (`Integer`, non-null)
- `weight` (`Numeric(10,2)`, non-null)
- `speeds` (`Numeric(10,2)`, non-null)
- `draw` (`Numeric(10,2)`, non-null) — *Furnace tonnage draw.*
- `quantity` (`Numeric(12,2)`, non-null) — *Gross projected bottle output.*
- `required_bottles` (`Numeric(14,2)`, nullable) — *Customer order requirement.*
- `estimated_completion` (`DateTime`, nullable)
- `completion_time` (`DateTime`, nullable)
- `changeover_minutes` (`Integer`, default `0`)
- `status` (`String(20)`, default `"Planned"`)
- **Constraints & Indexes**:
  - `uix_production_job`: Unique on (`plan_date`, `machine_no`, `start_time`, `section`)
  - `ix_production_job_machine_plan`: Index on (`machine_no`, `plan_date`)
- `TODO(verify)`: Check whether live PostgreSQL production schema uses `job_id` as the physical table primary key with a unique constraint on schedule coordinates, or whether the composite key is enforced at the DDL level.

#### `production.job_packaging`
*Packaging allocations tied to production jobs.*
- **Composite PK**: (`job_id`, `packaging_type`)
- `job_id` (`BigInteger`, **PK**, **FK** → `job_master.job_id`)
- `packaging_type` (`String(2)`, **PK**) — *e.g., `"C1"`, `"C2"`, `"P"`.*
- `plan_date` (`Date`, nullable)
- `machine_no` (`Integer`, nullable)
- `bottle_id` (`Integer`, nullable)
- `section` (`Integer`, nullable)
- `start_time` (`DateTime`, nullable)
- `quantity` (`Numeric(12,2)`, non-null)
- `pallet_packing` (`Boolean`, default `False`)
- `pallet_quantity` (`Numeric(12,2)`, nullable)
- **Indexes**: `ix_job_packaging_lookup` on (`job_id`, `plan_date`, `machine_no`, `start_time`).

#### `production.audit_logs`
*System event and modification trail.*
- `id` (`Integer`, **PK**, index, non-null)
- `user_id` (`String`, **FK** → `users.employee_id`, nullable)
- `action` (`String`, non-null)
- `details` (`String`, nullable)
- `timestamp` (`DateTime(timezone=True)`, server default `now()`)

#### `production.holiday_master`
*Factory calendar non-working days.*
- `holiday_date` (`Date`, **PK**, non-null)
- `holiday_name` (`String(150)`, non-null)

---

### Schema: `auth`
*Auth schema models inherit from `AuthBase` (DeclarativeBase) to prevent `Base.metadata.create_all()` from altering server-provisioned security tables.*

#### `auth.users`
*Authoritative credentials and authentication source.*
- `employee_id` (`String`, **PK**, non-null)
- `employee_name` (`String`, non-null)
- `email` (`String`, nullable)
- `phone_number` (`String`, nullable)
- `password` (`String`, non-null) — *Note: Plain text.*
- `is_active` (`Boolean`, default `True`, non-null)
- `created_at` (`DateTime(timezone=True)`, server default `now()`, non-null)

#### `auth.module_master`
*Catalog of application functional modules.*
- `module_id` (`Integer`, **PK**, non-null)
- `module_name` (`String`, non-null) — *e.g. `"Production Planning"`, `"Quality Control"`, `"Bottle Master"`, `"Holiday Master"`.*
- `parent_module_id` (`Integer`, nullable)
- `is_active` (`Boolean`, default `True`, non-null)

#### `auth.user_module_permissions`
*Per-employee granular permissions.*
- `permission_id` (`Integer`, **PK**, non-null)
- `employee_id` (`String`, index, non-null)
- `module_id` (`Integer`, index, non-null)
- `can_read` (`Boolean`, default `False`, non-null)
- `can_edit` (`Boolean`, default `False`, non-null)

---

### Schema: `hpr` (Hourly Production Report & Quality)

#### `hpr.defect_master`
*Defect catalog classified by severity.*
- `defect_id` (`BigInteger`, **PK**, index, non-null)
- `defect_type` (`String(20)`, non-null) — *`"Critical"`, `"Major"`, `"Minor"`.*
- `defect_sr` (`Integer`, non-null) — *Display order sequence.*
- `defect_name` (`String(255)`, unique, non-null)
- `is_active` (`Boolean`, default `True`, non-null)
- **Constraints**: `uq_defect_type_sr` on (`defect_sr`, `defect_type`).

#### `hpr.hourly_production_report`
*Daily quality report container.*
- `report_id` (`BigInteger`, **PK**, index, non-null)
- `production_date` (`Date`, unique, non-null) — *9:00 AM to 8:59 AM next day.*

#### `hpr.shift_master`
*Factory shift schedule definitions.*
- `shift_id` (`SmallInteger`, **PK**, index, non-null)
- `shift_name` (`String(20)`, unique, non-null) — *e.g. `"Shift A"`, `"Shift B"`, `"Shift C"`.*
- `start_time` (`Time`, non-null)
- `end_time` (`Time`, non-null)

#### `hpr.shift_assignment`
*Supervisory staff assignment per shift and daily report.*
- `assignment_id` (`BigInteger`, **PK**, index, non-null)
- `report_id` (`BigInteger`, **FK** → `hourly_production_report.report_id`, non-null)
- `shift_id` (`SmallInteger`, **FK** → `shift_master.shift_id`, non-null)
- `supervisor` (`String(255)`, nullable)
- `executive` (`String(255)`, nullable)
- **Constraints**: `uq_report_shift` on (`report_id`, `shift_id`).

#### `hpr.hourly_production`
*Hourly machine inspection entries.*
- `entry_id` (`BigInteger`, **PK**, index, non-null)
- `report_id` (`BigInteger`, **FK** → `hourly_production_report.report_id`, non-null)
- `machine_no` (`Integer`, **FK** → `machine_master.machine_no`, non-null)
- `shift_id` (`SmallInteger`, **FK** → `shift_master.shift_id`, non-null)
- `production_time` (`DateTime`, non-null)
- `bottle_id` (`Integer`, **FK** → `bottle_master.bottle_id`, nullable)
- `weight_front` (`Numeric(10,2)`, nullable)
- `weight_middle` (`Numeric(10,2)`, nullable)
- `weight_rear` (`Numeric(10,2)`, nullable)
- `weight_avg` (`Numeric(10,2)`, nullable)
- `speed_per_min` (`Numeric(10,2)`, nullable)
- `packing_category` (`String(100)`, nullable)
- `packing_size` (`Integer`, nullable)
- `cartons` (`Integer`, nullable)
- `bottles_in_nos` (`Integer`, nullable)
- `efficiency_percent` (`Numeric(5,2)`, nullable)
- `weight_efficiency` (`Numeric(10,2)`, nullable)
- `sqc` (`Integer`, nullable)
- `qc_hold` (`Integer`, nullable)
- `num` (`Integer`, nullable)
- `remarks` (`Text`, nullable)
- `job_id` (`String(20)`, non-null) — *Model defines `nullable=False`, stored as `""` if unassigned.*
- **Constraints**: `uq_hpr_machine_hour` on (`production_time`, `machine_no`, `report_id`).
- `TODO(verify)`: Check whether live PostgreSQL table constraint `hourly_production_job_id_not_null` enforces `NOT NULL` in all deployed databases or whether any legacy rows allow `NULL`.

#### `hpr.hourly_production_defect`
*Join table recording defects observed during hourly checks.*
- `entry_id` (`BigInteger`, **PK**, **FK** → `hourly_production.entry_id`)
- `defect_id` (`BigInteger`, **PK**, **FK** → `defect_master.defect_id`)

#### `hpr.hpr_job`
*Quality module job lookup record.*
- `job_id` (`String(20)`, **PK**, index, non-null)
- `machine_no` (`Integer`, non-null)
- `bottle_id` (`Integer`, non-null)
- `job_start_time` (`DateTime`, non-null)
- `job_end_time` (`DateTime`, nullable)
- `status` (`String(20)`, non-null)
- `remarks` (`Text`, nullable)
- `created_at` (`DateTime`, server default `now()`, non-null)
- `updated_at` (`DateTime`, server default `now()`, non-null)

---

## 6. API Reference & Conventions

### Conventions
1. **Authentication**: All endpoints under `/api/production/*` require an HTTP `Authorization: Bearer <token>` header. Missing or expired tokens return HTTP `401 Unauthorized`.
2. **Authorization**: Mutating operations (POST, PUT, DELETE) require edit permissions on the corresponding module (`require_module_edit`); view operations require read permissions (`require_module_read`). Insufficient permissions return HTTP `403 Forbidden`.
3. **Date Parameters**: Query parameters representing calendar dates (`from_date`, `to_date`, `date`) must be formatted strictly as ISO-8601 strings (`YYYY-MM-DD`). Inverted date ranges (`from_date > to_date`) or malformed strings return HTTP `422 Unprocessable Entity`.
4. **Error Responses**: All HTTP exceptions follow the standard FastAPI format:
   ```json
   {
     "detail": "Error description message"
   }
   ```

---

### Route Catalog

#### Health Probe
- `GET /health`
  - **Auth**: None (Public)
  - **Response**: `{ "status": "healthy", "service": "vitrumglass-api", "db_url": "<string>" }`
  - *Note: Exposes database credentials in live deployment; see Known Issues.*

#### Authentication Router (`/api/auth`)
- `POST /api/auth/login`
  - **Auth**: None
  - **Body**: `{ "user_id": "<employee_id|email|phone>", "password": "<plain_text>" }`
  - **Response**: `{ "token": "<token_32_bytes>", "user": { "employee_id", "employee_name", "department", "email", "phone_number", "role", "modules", "permissions" } }`
- `POST /api/auth/signup`
  - **Auth**: None
  - **Body**: `{ "employee_id", "employee_name", "department", "email", "phone_number", "password", "role": "Editor"|"Viewer" }`
  - **Response**: HTTP 201 `{ "message": "Account created successfully" }`
- `GET /api/auth/me`
  - **Auth**: Authenticated User
  - **Response**: Current user profile with permissions dictionary.
- `GET /api/auth/permissions`
  - **Auth**: Authenticated User
  - **Response**: Active module catalog and effective permissions. Polled by frontend to reflect dynamic privilege updates without logout.
- `POST /api/auth/change-password`
  - **Auth**: Authenticated User
  - **Body**: `{ "current_password", "new_password" }`
  - **Response**: `{ "message": "Password updated successfully" }`
- `POST /api/auth/logout`
  - **Auth**: Optional Bearer token
  - **Response**: HTTP 204 No Content

#### Machines Router (`/api/production/machines`)
- `GET /api/production/machines/`
  - **Guard**: Read access to `Production Planning` or `Bottle Master`
  - **Response**: `[ { "machine_no", "gob_type", "max_section" }, ... ]`
- `POST /api/production/machines/`
  - **Guard**: Edit access to `Production Planning`
  - **Body**: `{ "machine_no": 1..4, "gob_type": 2|3, "max_section": >=1 }`
- `PUT /api/production/machines/{machine_no}`
  - **Guard**: Edit access to `Production Planning`
  - **Body**: `{ "gob_type": 2|3, "max_section": >=1 }`

#### Products Router (`/api/production/products`)
- `GET /api/production/products/bottles/`
  - **Guard**: Read access to `Production Planning` or `Bottle Master`
  - **Response**: `[ { "bottle_id", "bottle_name", "weight" }, ... ]`
- `POST /api/production/products/bottles/`
  - **Guard**: Edit access to `Bottle Master`
  - **Body**: `{ "bottle_name", "weight": optional }`
- `PUT /api/production/products/bottles/{bottle_id}`
  - **Guard**: Edit access to `Bottle Master`
  - **Body**: `{ "bottle_name", "weight": optional }`
- `GET /api/production/products/configurations/`
  - **Guard**: Read access to `Production Planning` or `Bottle Master`
  - **Query**: `machine_no` (optional)
  - **Response**: `[ { "machine_no", "bottle_id", "section", "weight", "speeds" }, ... ]`
- `POST /api/production/products/configurations/`
  - **Guard**: Edit access to `Bottle Master`
  - **Body**: `{ "machine_no", "bottle_id", "section", "weight", "speeds" }`
- `PUT /api/production/products/configurations/{machine_no}/{bottle_id}/{section}`
  - **Guard**: Edit access to `Bottle Master`
  - **Body**: `{ "weight", "speeds" }`
- `DELETE /api/production/products/configurations/{machine_no}/{bottle_id}/{section}`
  - **Guard**: Edit access to `Bottle Master`
  - **Response**: `{ "ok": true }`
- `POST /api/production/products/configurations/bulk/`
  - **Guard**: Edit access to `Bottle Master`
  - **Body**: `{ "configurations": [ { "machine_no", "bottle_id", "section", "weight", "speeds" }, ... ] }`
  - **Response**: `{ "ok": true, "saved": <count> }`

#### Jobs Router (`/api/production/jobs`)
- `GET /api/production/jobs/`
  - **Guard**: Read access to `Production Planning`
  - **Query**: `from_date` (ISO date), `to_date` (ISO date), `machine_no`, `limit`, `order_by`
  - **Response**: Array of job objects with nested `packaging` collections.
- `POST /api/production/jobs/`
  - **Guard**: Edit access to `Production Planning`
  - **Body**: Single job object with `packaging` array. Upserts by schedule coordinate key.
- `POST /api/production/jobs/bulk/`
  - **Guard**: Edit access to `Production Planning`
  - **Body**: `{ "jobs": [ ... ] }` (Atomic bulk upsert of jobs and packaging rows).
- `GET /api/production/jobs/next-id/{machine_no}`
  - **Guard**: Read access to `Production Planning`
  - **Response**: `{ "machine_no", "next_job_id" }`
- `POST /api/production/jobs/reserve-id/{machine_no}`
  - **Guard**: Edit access to `Production Planning`
  - **Response**: `{ "machine_no", "job_id" }` (Advances counter in `machine_job_sequence` via `SELECT FOR UPDATE`).
- `POST /api/production/jobs/extend/`
  - **Guard**: Edit access to `Production Planning`
  - **Body**: `{ "plan_date", "machine_no", "start_time", "days" }`
  - **Response**: Array of affected jobs shifted forward on the same machine.
- `DELETE /api/production/jobs/{plan_date}/{machine_no}/{start_time}`
  - **Guard**: Edit access to `Production Planning`
  - **Query**: `job_id`, `section` (optional)
  - **Response**: HTTP 204 No Content (shifts subsequent jobs backward to close schedule gap).
- `POST /api/production/jobs/bulk-delete/`
  - **Guard**: Edit access to `Production Planning`
  - **Body**: `{ "items": [ { "plan_date", "machine_no", "start_time", "job_id", "section" }, ... ] }`
  - **Response**: `{ "ok": true, "deleted": <count> }`

#### Audit Logs Router (`/api/production/audit-logs`)
- `GET /api/production/audit-logs/`
  - **Guard**: Read access to any active module
  - **Response**: Array of latest 50 audit entries.
  - *Note: Subject to 500 serialization error due to schema int vs model string user_id; see Known Issues.*

#### Holidays Router (`/api/production/holidays`)
- `GET /api/production/holidays/`
  - **Guard**: Read access to `Holiday Master` or `Production Planning`
  - **Response**: `[ { "holiday_date", "holiday_name" }, ... ]`
- `POST /api/production/holidays/`
  - **Guard**: Edit access to `Holiday Master`
  - **Body**: `{ "holiday_date", "holiday_name" }`
- `PUT /api/production/holidays/{holiday_date}`
  - **Guard**: Edit access to `Holiday Master`
  - **Body**: `{ "holiday_name" }`
- `DELETE /api/production/holidays/{holiday_date}`
  - **Guard**: Edit access to `Holiday Master`
  - **Response**: `{ "ok": true }`

#### Quality Defects Router (`/api/production/quality/defects`)
- `GET /api/production/quality/defects/`
  - **Guard**: Read access to `Quality Control`
  - **Query**: `active_only` (`true`|`false`)
  - **Response**: `[ { "defect_id", "defect_type", "defect_sr", "defect_name", "is_active" }, ... ]`
- `POST /api/production/quality/defects/`
  - **Guard**: Edit access to `Quality Control`
  - **Body**: `{ "defect_type": "Critical"|"Major"|"Minor", "defect_sr", "defect_name" }`
- `PUT /api/production/quality/defects/{defect_id}`
  - **Guard**: Edit access to `Quality Control`
  - **Body**: Update fields.

#### Quality Daily Router (`/api/production/quality/daily`)
- `GET /api/production/quality/daily/`
  - **Guard**: Read access to `Quality Control`
  - **Query**: `date=YYYY-MM-DD`
  - **Response**: Daily quality report with hourly entries across all 4 machines and 3 shifts.
- `GET /api/production/quality/daily/jobs/`
  - **Guard**: Read access to `Quality Control`
  - **Query**: `date=YYYY-MM-DD`
  - **Response**: Job-wise summary of production and quality runs for the selected manufacturing day.
- `POST /api/production/quality/daily/`
  - **Guard**: Edit access to `Quality Control`
  - **Body**: Complete daily report payload with shift supervisor assignments and hourly machine records.

---

## 7. Authentication, Roles & Security

### User Identification & Verification
Sign-in resolution is handled by [`find_user_by_identifier`](file:///d:/V10/production-planningV05/Backend/app/api/auth.py):
1. **Employee ID**: Exact match against `auth.users.employee_id`.
2. **Email Address**: Case-insensitive match (`func.lower(AuthUser.email) == email.lower()`) if an `@` symbol is detected.
3. **Mobile Phone Number**: Stripped digit match against `auth.users.phone_number`.

### Dynamic Database-Driven RBAC
Access control does not use static code roles. Instead, permissions are loaded from the database at request time:
- `auth.module_master`: Contains the catalog of modules.
- `auth.user_module_permissions`: Contains per-employee rows specifying `can_read` and `can_edit`.

Enforcement is applied via FastAPI dependencies in [`app/api/permissions.py`](file:///d:/V10/production-planningV05/Backend/app/api/permissions.py):
- `require_module_read(module_name)`: Enforces `can_read == True`.
- `require_module_edit(module_name)`: Enforces `can_read == True` and `can_edit == True`.
- `require_any_module_read([modules])`: Allows read access if user has read permission on any listed module.

### Public Signup Isolation
Anyone can invoke `POST /api/auth/signup` to register an account. However:
- Signup inserts rows into `auth.users` and `production.users`.
- **Zero permissions** are created in `auth.user_module_permissions`.
- When a newly registered user logs in, their effective permissions dictionary is empty (`{}`).
- Consequently, all functional business endpoints (`/api/production/*`) return **HTTP 403 Forbidden** until a database developer or system administrator inserts permission records into `auth.user_module_permissions`.
- The user can only access `/api/auth/me`, `/api/auth/permissions`, and change their password.

### Sessions & Lifespan
- Authenticated requests generate an opaque 32-byte URL-safe string stored in the server's in-memory dictionary `SESSIONS`.
- Implements a **sliding idle window**: Every authenticated request pushes the expiration timestamp forward by `SESSION_IDLE_TIMEOUT_DAYS` (default 30 days). Active plant operators are never logged out mid-shift.
- *Limitation*: Because `SESSIONS` is held in process memory, all sessions are invalidated whenever the backend container restarts or redeploys on Render.

---

## 8. Frontend Structure

Source code is located under `src/`.

### Directory Architecture
- `src/components/`
  - `planning/`: Calendar grid register, `PlanningDrawer`, `EditMachineModal`, `EndJobModal`.
  - `master-management/`: `MachinesModule`, `BottleMasterPanel`, `BottleExportPanel`, `HolidayMasterPanel`.
  - `quality/`: `ProductionQualityMonitor` (hourly checks, defects, weight efficiency).
  - `profile/`: User profile display, password change modal.
  - `layout/`: Top navigation bar, sidebar, and module tab switcher.
- `src/context/`
  - `AuthContext.tsx`: Token management, profile storage in `localStorage`, login/logout flows.
  - `ERPContext.tsx`: Module switching, active cache management, planning batch operations.
- `src/services/`
  - `planningRepository.ts`: Central data repository caching machines, bottles, configs, jobs, and holidays; coordinates batch saving and deletes.
  - `qualityRepository.ts`: Quality defect and daily inspection report fetching and saving.
- `src/utils/`
  - `api.ts`: Centralized `fetch` wrapper injecting bearer tokens, request timeouts (30s), and error formatting.
  - `planningCalculations.ts` & `calculations.ts`: Furnace draw, output tonnage, speed, and time estimations.
  - `reportHeader.ts`: Centralized enterprise branding utility providing corporate headers across PDF/Excel exports.
  - `exportData.ts`: Formatted dataset exports for Excel and PDF.

### Navigation & Routing
The frontend operates without a router library, using bidirectional URL hash synchronization:
- Supported hashes: `#production`, `#quality`, `#master-management`, `#machines`, `#settings`, `#profile`, `#dashboard`.
- Handled by `getModuleFromHash` and `setHashForModule` in `ERPContext.tsx`. Logout clears the URL hash.

### Production Hours Client-Side Field
The field `production_hours` appears in `src/data/planningSchema.ts` and `ProductionJobRow` interfaces:
- It is a **client-side computation and display helper** representing operational segment duration.
- It is never serialized or transmitted to the backend in `planningRepository._buildJobBody`.
- It does not exist as a column in the backend database.

---

## 9. Testing & CI

### Continuous Integration Pipeline
Automated through GitHub Actions (`.github/workflows/ci.yml`) on pushes to `main`:
1. **Frontend Job (`frontend-tests`)**:
   - Environment: Ubuntu latest, Bun runtime.
   - Executes: `bun install`, `bun run lint`, `bun run build`.
2. **Backend Job (`backend-tests`)**:
   - Environment: Ubuntu latest, Python 3.11.
   - Executes:
     ```bash
     pip install -r Backend/requirements.txt
     pip install pytest
     pytest Backend/tests/
     ```
3. **Container Build Job (`build-and-push`)**:
   - Triggers on successful test completion.
   - Builds frontend and backend Docker containers and pushes tagged images to GitHub Container Registry (GHCR).

### Testing Constraints & SQLite Divergence
- **CI Test Database**: The CI workflow does not spin up a PostgreSQL service container. Tests execute against SQLite.
- **Risk**: Postgres-specific dialect behaviors (such as strict `psycopg3` type casting, date operators, or custom schema namespaces) are not exercised in CI and can only be caught in staging/production environments.

---

## 10. Troubleshooting

### 1. HTTP 500 Internal Server Error on API Calls
- **Diagnosis**: Check Render application logs under the **Logs** tab to view the Python exception traceback.
- **Common Cause**: Mismatched data types between SQL queries and database column types (e.g. comparing `DATE` columns with string parameters or casting strings to integers in schema serializers).

### 2. Schedule Grid Auto-Save Rejection (HTTP 422)
- **Diagnosis**: Validate that `plan_date` is properly formatted (`YYYY-MM-DD`) and that `estimated_completion` has valid minute values (`00` to `59`).
- **Fix**: Verify that timestamps do not contain rounded values like `"21:60"`.

### 3. User Receives HTTP 403 Forbidden on All Modules After Signup
- **Diagnosis**: Expected behavior. Newly signed-up users are created without module permission rows in `auth.user_module_permissions`.
- **Resolution**: An administrator must insert rows into `auth.user_module_permissions` granting `can_read` and `can_edit` for the required modules.

### 4. Sessions Disconnecting Unexpectedly
- **Diagnosis**: Render free-tier or standard container restarts discard the backend process memory.
- **Resolution**: In-memory `SESSIONS` dictionary is cleared on server reboot. Re-login is required until session storage is backed by a database or Redis cache.

---

## 11. Known Issues

| Issue | Severity | Impact | Status |
| :--- | :---: | :--- | :---: |
| **`GET /health` Credential Leak** | **Critical** | Public endpoint returns `settings.DATABASE_URL` containing database host, username, and password. | **Open** *(Separate fix task in progress)* |
| **Plain-Text Password Storage** | **High** | Passwords in `auth.users` and `production.users` are stored without hashing and compared directly. | **Open** |
| **In-Memory Session Map (`SESSIONS`)** | **High** | Sessions stored in a local process dictionary; restarting container or scaling across instances logs all users out. | **Open** |
| **`AuditLogResponse.user_id` Type Mismatch** | **Medium** | Schema defines `user_id: int`, while model stores alphanumeric employee ID string (`users.employee_id`). Calling `GET /api/production/audit-logs/` triggers a 500 serialization error. | **Open** |
| **Unpinned & Duplicated Dependencies** | **Medium** | `Backend/requirements.txt` has unpinned ranges (`>=`), duplicates `pydantic-settings` 3 times, and installs both `psycopg2-binary` and `psycopg[binary]`. | **Open** |
| **CI Tests Restricted to SQLite** | **Medium** | GitHub Actions pipeline runs tests against SQLite only. PostgreSQL-specific SQL syntax and driver quirks bypass CI checks. | **Open** |
| **Public Signup Lacks Self-Service Onboarding** | **Low** | Anyone can sign up, but new accounts have no default module permissions and encounter 403 on all functional screens. | **Open** *(By Design)* |
| **`production_hours` Exists Only in Frontend** | **Low** | Present in TypeScript interfaces for grid math but absent from database tables and backend schemas. | **Documented** |

---

## Changelog
For the complete historical changelog from inception to the present, see [CHANGELOG.md](file:///d:/V10/production-planningV05/CHANGELOG.md).