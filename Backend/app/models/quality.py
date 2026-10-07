# pyrefly: ignore [missing-import]
from sqlalchemy import Column, Integer, SmallInteger, BigInteger, String, Numeric, Date, Time, DateTime, Boolean, ForeignKey, UniqueConstraint, Text, func
# pyrefly: ignore [missing-import]
from sqlalchemy.orm import relationship
from app.db.base import Base, hpr_fk, hpr_table_args, production_fk


def _autoinc_bigint():
    # SQLite only auto-increments an exact INTEGER PRIMARY KEY (a rowid
    # alias); a BIGINT PRIMARY KEY is not one, so every INSERT fails with
    # "NOT NULL constraint failed" — that would block the Quality Module's
    # own report/entry/shift-assignment creation on the default SQLite URL.
    # with_variant keeps BIGINT on every other dialect (PostgreSQL DDL and
    # behaviour are untouched) and switches only SQLite to INTEGER.
    return BigInteger().with_variant(Integer, "sqlite")


class DefectMaster(Base):
    __tablename__ = "defect_master"

    defect_id = Column(BigInteger, primary_key=True, index=True)
    defect_type = Column(String(20), nullable=False)
    defect_sr = Column(Integer, nullable=False)
    defect_name = Column(String(255), nullable=False, unique=True)
    is_active = Column(Boolean, nullable=False, default=True)

    __table_args__ = (
        UniqueConstraint('defect_sr', 'defect_type', name='uq_defect_type_sr'),
        hpr_table_args()
    )


class HourlyProductionReport(Base):
    __tablename__ = "hourly_production_report"

    report_id = Column(_autoinc_bigint(), primary_key=True, index=True)
    production_date = Column(Date, nullable=False, unique=True)

    __table_args__ = (hpr_table_args(),)


class ShiftMaster(Base):
    __tablename__ = "shift_master"

    shift_id = Column(SmallInteger, primary_key=True, index=True)
    shift_name = Column(String(20), nullable=False, unique=True)
    start_time = Column(Time, nullable=False)
    end_time = Column(Time, nullable=False)

    __table_args__ = (hpr_table_args(),)


class ShiftAssignment(Base):
    __tablename__ = "shift_assignment"

    assignment_id = Column(_autoinc_bigint(), primary_key=True, index=True)
    report_id = Column(
        _autoinc_bigint(), ForeignKey(hpr_fk("hourly_production_report.report_id")), nullable=False
    )
    shift_id = Column(SmallInteger, ForeignKey(hpr_fk("shift_master.shift_id")), nullable=False)
    supervisor = Column(String(255), nullable=True)
    executive = Column(String(255), nullable=True)

    __table_args__ = (
        UniqueConstraint('report_id', 'shift_id', name='uq_report_shift'),
        hpr_table_args()
    )


class HourlyProduction(Base):
    __tablename__ = "hourly_production"

    entry_id = Column(_autoinc_bigint(), primary_key=True, index=True)
    report_id = Column(
        _autoinc_bigint(), ForeignKey(hpr_fk("hourly_production_report.report_id")), nullable=False
    )
    machine_no = Column(Integer, ForeignKey(production_fk("machine_master.machine_no")), nullable=False)
    shift_id = Column(SmallInteger, ForeignKey(hpr_fk("shift_master.shift_id")), nullable=False)
    production_time = Column(DateTime, nullable=False)
    
    bottle_id = Column(Integer, ForeignKey(production_fk("bottle_master.bottle_id")), nullable=True)

    weight_front = Column(Numeric(10, 2), nullable=True)
    weight_middle = Column(Numeric(10, 2), nullable=True)
    weight_rear = Column(Numeric(10, 2), nullable=True)
    weight_avg = Column(Numeric(10, 2), nullable=True)
    speed_per_min = Column(Numeric(10, 2), nullable=True)
    
    # hpr.hourly_production.packing_category is VARCHAR(100): the options are
    # joined with ", " (all five PACKING_OPTIONS = 87 chars), so anything longer
    # would be rejected by the database and roll back the whole save.
    packing_category = Column(String(100), nullable=True)
    packing_size = Column(Integer, nullable=True)
    cartons = Column(Integer, nullable=True)
    bottles_in_nos = Column(Integer, nullable=True)
    efficiency_percent = Column(Numeric(5, 2), nullable=True)
    weight_efficiency = Column(Numeric(10, 2), nullable=True)

    sqc = Column(Integer, nullable=True)
    qc_hold = Column(Integer, nullable=True)
    num = Column(Integer, nullable=True)
    remarks = Column(Text, nullable=True)
    # NOT NULL in hpr.hourly_production (constraint hourly_production_job_id_not_null).
    # There is no foreign key on this column — hpr_job is the job table and
    # production.production_job.job_id is a BIGINT, unrelated to this VARCHAR.
    # A row that does not belong to a job yet must therefore be stored as "",
    # never NULL, or every row for the day is lost to a rolled-back transaction.
    job_id = Column(String(20), nullable=False)
    # Row lock. TRUE freezes the row: every write API rejects updates and
    # deletes of a locked row with "This row is locked and cannot be edited."
    # Only the dedicated lock endpoint flips this flag, so the database stays
    # the source of truth even when a client bypasses the frontend checkbox.
    is_locked = Column(Boolean, nullable=False, default=False)
    # Logical grouping of time segments created by one manual split
    # (e.g. a 2:00-3:00 PM hour split at 2:30 PM yields a 2:00-2:30 PM row and
    # a 2:30-3:00 PM row carrying the same split_group_id such as "SG001").
    # Grouping/history only: every segment keeps its own unique entry_id and
    # its own row, and no calculation or report may use this column — reports
    # sum the separate time segments exactly as before.
    split_group_id = Column(String(40), nullable=True)

    defects = relationship("DefectMaster", secondary=lambda: HourlyProductionDefect.__table__, lazy="selectin")

    __table_args__ = (
        UniqueConstraint('production_time', 'machine_no', 'report_id', name='uq_hpr_machine_hour'),
        hpr_table_args()
    )


class HourlyProductionDefect(Base):
    __tablename__ = "hourly_production_defect"

    entry_id = Column(
        _autoinc_bigint(), ForeignKey(hpr_fk("hourly_production.entry_id")), primary_key=True
    )
    defect_id = Column(BigInteger, ForeignKey(hpr_fk("defect_master.defect_id")), primary_key=True)

    __table_args__ = (hpr_table_args(),)


class HprJob(Base):
    __tablename__ = "hpr_job"

    job_id = Column(String(20), primary_key=True, index=True)
    machine_no = Column(Integer, nullable=False)
    bottle_id = Column(Integer, nullable=False)
    job_start_time = Column(DateTime, nullable=False)
    job_end_time = Column(DateTime, nullable=True)
    status = Column(String(20), nullable=False)
    remarks = Column(Text, nullable=True)
    created_at = Column(DateTime, nullable=False, server_default=func.now())
    updated_at = Column(DateTime, nullable=False, server_default=func.now(), onupdate=func.now())

    __table_args__ = hpr_table_args()

