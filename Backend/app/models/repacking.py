# pyrefly: ignore [missing-import]
from sqlalchemy import Column, Integer, SmallInteger, BigInteger, String, Text, Date, Time, DateTime, ForeignKey, func
from app.db.base import Base, sqc_table_args, sqc_fk, production_fk, hpr_fk


def _autoinc_bigint():
    return BigInteger().with_variant(Integer, "sqlite")


class RepackingNumbering(Base):
    __tablename__ = "repacking_numbering"
    __table_args__ = (sqc_table_args(),)

    entry_id = Column(_autoinc_bigint(), primary_key=True, index=True)
    production_date = Column(Date, nullable=False, index=True)
    machine_no = Column(SmallInteger, nullable=False, index=True)
    job_id = Column(String, nullable=False, index=True)
    bottle_id = Column(Integer, ForeignKey(production_fk("bottle_master.bottle_id")), nullable=True)
    pack_type = Column(String, nullable=True)
    shift = Column(SmallInteger, nullable=False)
    entry_time = Column(Time, nullable=False)
    pcs_per_pack = Column(Integer, nullable=True)
    cartons = Column(Integer, nullable=True)
    defective_bottles = Column(Integer, nullable=True)
    defect_id = Column(BigInteger, ForeignKey(hpr_fk("defect_master.defect_id")), nullable=True)
    mould = Column(String, nullable=True)
    section_no = Column(String, nullable=True)
    # Live schema: FK -> hpr.employee_master.employee_id (not production.users).
    checker_id = Column(String, ForeignKey(hpr_fk("employee_master.employee_id")), nullable=True)
    # The free-text remarks cell of the report. The table has no QA-executive
    # column on the live database, so nothing else is mapped here.
    remarks = Column(Text, nullable=True)
    created_at = Column(DateTime(timezone=True), nullable=True, server_default=func.now())
    updated_at = Column(DateTime(timezone=True), nullable=True, server_default=func.now(), onupdate=func.now())


class RepackingSqcQcHold(Base):
    __tablename__ = "repacking_sqc_qc_hold"
    __table_args__ = (sqc_table_args(),)

    entry_id = Column(_autoinc_bigint(), primary_key=True, index=True)
    production_date = Column(Date, nullable=False, index=True)
    machine_no = Column(SmallInteger, nullable=False, index=True)
    job_id = Column(String, nullable=False, index=True)
    bottle_id = Column(Integer, ForeignKey(production_fk("bottle_master.bottle_id")), nullable=True)
    pack_type = Column(String, nullable=True)
    lot_no = Column(String, nullable=True)
    shift = Column(SmallInteger, nullable=False)
    entry_time = Column(Time, nullable=False)
    pcs_per_pack = Column(Integer, nullable=True)
    cartons = Column(Integer, nullable=True)
    defective_bottles = Column(Integer, nullable=True)
    defect_id = Column(BigInteger, ForeignKey(hpr_fk("defect_master.defect_id")), nullable=True)
    mould = Column(String, nullable=True)
    section_no = Column(String, nullable=True)
    # Live schema: FK -> hpr.employee_master.employee_id (not production.users).
    checker_id = Column(String, ForeignKey(hpr_fk("employee_master.employee_id")), nullable=True)
    # Free-text remarks cell of the report; no QA-executive column exists.
    remarks = Column(Text, nullable=True)
    created_at = Column(DateTime(timezone=True), nullable=True, server_default=func.now())
    updated_at = Column(DateTime(timezone=True), nullable=True, server_default=func.now(), onupdate=func.now())
