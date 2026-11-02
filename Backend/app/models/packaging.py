# pyrefly: ignore [missing-import]
from sqlalchemy import Column, Integer, String
from app.db.base import Base, hpr_table_args


class PackagingMaster(Base):
    """ORM mapping of the existing ``hpr.packaging_master`` table.

    The table is provisioned in the database with ``packaging_id`` SERIAL
    PRIMARY KEY, ``packaging_code`` VARCHAR(20) UNIQUE NOT NULL and
    ``packaging_description`` VARCHAR(150) NOT NULL.  This model only maps
    those columns -- no schema is created or altered against PostgreSQL:
    ``Base.metadata.create_all`` skips tables that already exist (it only
    issues DDL for missing tables, and never ALTERs an existing one), exactly
    like every other mapped table in this application.  The SQLite fallback
    used for local development gets the table created on first boot so the
    panel works without a PostgreSQL instance.
    """

    __tablename__ = "packaging_master"
    __table_args__ = hpr_table_args()

    packaging_id = Column(Integer, primary_key=True)
    packaging_code = Column(String(20), nullable=False, unique=True)
    packaging_description = Column(String(150), nullable=False)
