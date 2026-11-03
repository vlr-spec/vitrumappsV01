from sqlalchemy.orm import DeclarativeBase
from app.core.config import settings

class Base(DeclarativeBase):
    pass


def production_fk(table_and_column: str) -> str:
    schema = settings.production_schema
    return f"{schema}.{table_and_column}" if schema else table_and_column


def production_table_args() -> dict[str, str]:
    schema = settings.production_schema
    return {"schema": schema} if schema else {}


def hpr_fk(table_and_column: str) -> str:
    schema = settings.hpr_schema
    return f"{schema}.{table_and_column}" if schema else table_and_column


def hpr_table_args() -> dict[str, str]:
    schema = settings.hpr_schema
    return {"schema": schema} if schema else {}


def auth_fk(table_and_column: str) -> str:
    schema = settings.auth_schema
    return f"{schema}.{table_and_column}" if schema else table_and_column


def auth_table_args() -> dict[str, str]:
    schema = settings.auth_schema
    return {"schema": schema} if schema else {}


def sqc_fk(table_and_column: str) -> str:
    schema = settings.sqc_schema
    return f"{schema}.{table_and_column}" if schema else table_and_column


def sqc_table_args() -> dict[str, str]:
    schema = settings.sqc_schema
    return {"schema": schema} if schema else {}
