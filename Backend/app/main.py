# pyrefly: ignore [missing-import]
from fastapi import Depends, FastAPI
from fastapi.middleware.cors import CORSMiddleware
from sqlalchemy import inspect, text
from app.core.config import settings

# Import the router we just built!
from app.api.production import machines
from app.api.production import products
from app.api.production import jobs
from app.api.production import audit_logs
from app.api.production import holidays
from app.api.production import packaging
from app.api.production import quality_defects
from app.api.production import quality_daily
from app.api.production import repacking
from app.api import auth
from app.api.auth import get_current_user

# Import Database tools
from app.db.session import engine
from app.db.base import Base

# We must import all models here so SQLAlchemy knows about them before creating tables
from app.models.user import User
from app.models.machine import MachineMaster
from app.models.product import BottleMaster, BottleConfiguration
from app.models.job import JobMaster, ProductionJob, JobPackaging, MachineJobSequence
from app.models.audit_log import AuditLog
from app.models.holiday import HolidayMaster
from app.models.packaging import PackagingMaster
from app.models.quality import DefectMaster, HourlyProductionReport, ShiftMaster, ShiftAssignment, HourlyProduction, HourlyProductionDefect
from app.models.repacking import RepackingNumbering, RepackingSqcQcHold

# Auth schema models live on their own base so Base.metadata.create_all never
# touches the server-provisioned auth.users / module_master / permissions tables.
from app.models.auth import AuthBase

def _ensure_hourly_production_weight_efficiency_column() -> None:
    """Adds hourly_production.weight_efficiency to databases that predate the column."""
    schema = settings.hpr_schema
    table_name = "hourly_production"
    try:
        columns = {c["name"] for c in inspect(engine).get_columns(table_name, schema=schema or None)}
        if "weight_efficiency" in columns:
            return
    except Exception as exc:
        print(f"Warning: could not inspect {table_name} columns: {exc}")
        return

    target = f'"{schema}"."{table_name}"' if schema else table_name
    try:
        with engine.begin() as connection:
            connection.execute(text(f"ALTER TABLE {target} ADD COLUMN weight_efficiency NUMERIC(10, 2)"))
    except Exception as exc:
        print(f"Warning: could not add {table_name}.weight_efficiency column: {exc}")


def _ensure_hourly_production_split_group_column() -> None:
    """Adds hourly_production.split_group_id to databases that predate the column.

    Logical grouping identifier for manual-split time segments (see
    HourlyProduction.split_group_id). Nullable, never read by any calculation,
    so backfilling is unnecessary — pre-split rows simply stay NULL.
    """
    schema = settings.hpr_schema
    table_name = "hourly_production"
    try:
        columns = {c["name"] for c in inspect(engine).get_columns(table_name, schema=schema or None)}
        if "split_group_id" in columns:
            return
    except Exception as exc:
        print(f"Warning: could not inspect {table_name} columns: {exc}")
        return

    target = f'"{schema}"."{table_name}"' if schema else table_name
    try:
        with engine.begin() as connection:
            connection.execute(text(f"ALTER TABLE {target} ADD COLUMN split_group_id VARCHAR(40)"))
    except Exception as exc:
        print(f"Warning: could not add {table_name}.split_group_id column: {exc}")


def _ensure_hourly_production_is_locked_column() -> None:
    """Adds hourly_production.is_locked to databases that predate the column.

    Row lock (see HourlyProduction.is_locked): BOOLEAN NOT NULL DEFAULT FALSE,
    so every pre-existing row is born unlocked and the write APIs can read the
    flag without a NULL check. ALTER is a no-op when the column is already
    there, and any failure is reported and swallowed so a database user
    without ALTER rights can still boot the API exactly as before.
    """
    schema = settings.hpr_schema
    table_name = "hourly_production"
    try:
        columns = {c["name"] for c in inspect(engine).get_columns(table_name, schema=schema or None)}
        if "is_locked" in columns:
            return
    except Exception as exc:
        print(f"Warning: could not inspect {table_name} columns: {exc}")
        return

    target = f'"{schema}"."{table_name}"' if schema else table_name
    try:
        with engine.begin() as connection:
            connection.execute(text(f"ALTER TABLE {target} ADD COLUMN is_locked BOOLEAN NOT NULL DEFAULT FALSE"))
    except Exception as exc:
        print(f"Warning: could not add {table_name}.is_locked column: {exc}")


def _ensure_hourly_production_type2_packing_columns() -> None:
    """Adds the independent TYPE 2 packing columns when the database predates them.

    TYPE 1 keeps using packing_category / packing_size / cartons unchanged. The
    TYPE 2 columns are nullable and are only read/written by the Hourly
    Production Report, so pre-existing rows simply have no TYPE 2 entry.
    """
    schema = settings.hpr_schema
    table_name = "hourly_production"
    additions = {
        "packing_category_2": "VARCHAR(100)",
        "packing_size_2": "INTEGER",
        "cartons_2": "INTEGER",
    }
    try:
        columns = {c["name"] for c in inspect(engine).get_columns(table_name, schema=schema or None)}
    except Exception as exc:
        print(f"Warning: could not inspect {table_name} columns: {exc}")
        return

    missing = {name: ddl for name, ddl in additions.items() if name not in columns}
    if not missing:
        return

    target = f'"{schema}"."{table_name}"' if schema else table_name
    try:
        with engine.begin() as connection:
            for name, ddl in missing.items():
                connection.execute(text(f"ALTER TABLE {target} ADD COLUMN {name} {ddl}"))
    except Exception as exc:
        print(f"Warning: could not add TYPE 2 packing columns to {table_name}: {exc}")


def initialize_database() -> None:
    if settings.production_schema:
        with engine.begin() as connection:
            connection.execute(text(f'CREATE SCHEMA IF NOT EXISTS "{settings.production_schema}"'))
    if settings.hpr_schema:
        with engine.begin() as connection:
            connection.execute(text(f'CREATE SCHEMA IF NOT EXISTS "{settings.hpr_schema}"'))
    if settings.sqc_schema:
        with engine.begin() as connection:
            connection.execute(text(f'CREATE SCHEMA IF NOT EXISTS "{settings.sqc_schema}"'))
    Base.metadata.create_all(bind=engine)
    _ensure_hourly_production_weight_efficiency_column()
    _ensure_hourly_production_split_group_column()
    _ensure_hourly_production_is_locked_column()
    _ensure_hourly_production_type2_packing_columns()
    # Safe no-op against the production Postgres (auth tables already exist);
    # creates a local sqlite fallback so local development still works.
    AuthBase.metadata.create_all(bind=engine)

app = FastAPI(
    title="VitrumGlass Manufacturing API",
    description="Backend for production tracking, yield calculations, and RBAC.",
    version="1.0.0"
)

# 2. Add CORS Middleware to whitelist the Frontend!
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],  # In production, change this to your specific domain
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)

# This plugs the modules into the main application with the correct /api/production prefix
app.include_router(machines.router, prefix="/api/production", dependencies=[Depends(get_current_user)])
app.include_router(products.router, prefix="/api/production", dependencies=[Depends(get_current_user)])
app.include_router(jobs.router, prefix="/api/production", dependencies=[Depends(get_current_user)])
app.include_router(audit_logs.router, prefix="/api/production", dependencies=[Depends(get_current_user)])
app.include_router(holidays.router, prefix="/api/production", dependencies=[Depends(get_current_user)])
app.include_router(packaging.router, prefix="/api/production", dependencies=[Depends(get_current_user)])
app.include_router(quality_defects.router, prefix="/api/production/quality/defects", dependencies=[Depends(get_current_user)])
app.include_router(quality_daily.router, prefix="/api/production/quality/daily", dependencies=[Depends(get_current_user)])
app.include_router(repacking.router, prefix="/api/production/repacking", dependencies=[Depends(get_current_user)])
app.include_router(auth.router)


@app.on_event("startup")
def on_startup() -> None:
    initialize_database()

@app.get("/health")
def health_check():
    return {"status": "healthy", "service": "vitrumglass-api"}
