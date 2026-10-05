# pyrefly: ignore [missing-import]
from sqlalchemy import Column, BigInteger, Integer, String, Numeric, Date, DateTime, Boolean, ForeignKey, UniqueConstraint, Index, func, text, and_
# pyrefly: ignore [missing-import]
from sqlalchemy.orm import relationship, Session
from app.db.base import Base, production_fk, production_table_args


class JobMaster(Base):
    __tablename__ = "job_master"

    job_id = Column(BigInteger, primary_key=True, index=True)
    created_at = Column(DateTime, server_default=func.now())

    __table_args__ = (production_table_args(),)


class MachineJobSequence(Base):
    """Tracks the next job sequence number per machine.

    Each machine maintains its own monotonically-increasing counter.
    The job_id is generated as: machine_no * 100 + sequence.

    This table is NEVER decremented — deleted job sequences are never reused.
    """
    __tablename__ = "machine_job_sequence"

    machine_no = Column(Integer, primary_key=True)
    next_sequence = Column(Integer, nullable=False, default=1)

    __table_args__ = (production_table_args(),)


def generate_next_job_id(db: Session, machine_no: int) -> int:
    """Generate the next logical job_id for a machine.

    Returns machine_no * 100 + next_sequence, then increments the counter.
    Uses SELECT ... FOR UPDATE to ensure concurrency safety — two simultaneous
    requests will never receive the same job_id.
    """
    seq = db.query(MachineJobSequence).filter(
        MachineJobSequence.machine_no == machine_no
    ).with_for_update().first()

    if seq is None:
        seq = MachineJobSequence(machine_no=machine_no, next_sequence=1)
        db.add(seq)
        db.flush()

    job_id = machine_no * 100 + seq.next_sequence
    seq.next_sequence += 1
    db.flush()

    return job_id


class ProductionJob(Base):
    __tablename__ = "production_job"

    job_id = Column(BigInteger, ForeignKey(production_fk("job_master.job_id")), nullable=False, index=True)
    plan_date = Column(Date, nullable=False)
    machine_no = Column(Integer, nullable=False)
    start_time = Column(DateTime, nullable=False)
    bottle_id = Column(Integer, nullable=False)
    section = Column(Integer, nullable=False)
    weight = Column(Numeric(10, 2), nullable=False)
    speeds = Column(Numeric(10, 2), nullable=False)
    draw = Column(Numeric(10, 2), nullable=False)
    quantity = Column(Numeric(12, 2), nullable=False)
    required_bottles = Column(Numeric(14, 2), nullable=True)

    estimated_completion = Column(DateTime)
    completion_time = Column(DateTime)
    changeover_minutes = Column(Integer, default=0)
    status = Column(String(20), default="Planned")

    packaging = relationship(
        "JobPackaging",
        primaryjoin="and_(ProductionJob.job_id == JobPackaging.job_id, "
                    "ProductionJob.plan_date == JobPackaging.plan_date, "
                    "ProductionJob.machine_no == JobPackaging.machine_no, "
                    "ProductionJob.start_time == JobPackaging.start_time)",
        foreign_keys="JobPackaging.job_id",
        viewonly=False,
        cascade="all, delete-orphan",
    )

    __mapper_args__ = {
        "primary_key": [plan_date, machine_no, start_time, section],
    }

    __table_args__ = (
        UniqueConstraint('plan_date', 'machine_no', 'start_time', 'section', name='uix_production_job'),
        Index('ix_production_job_machine_plan', 'machine_no', 'plan_date'),
        production_table_args(),
    )


class JobPackaging(Base):
    __tablename__ = "job_packaging"

    job_id = Column(BigInteger, ForeignKey(production_fk("job_master.job_id")), primary_key=True)
    packaging_type = Column(String(2), primary_key=True)
    plan_date = Column(Date)
    machine_no = Column(Integer)
    bottle_id = Column(Integer)
    section = Column(Integer)
    start_time = Column(DateTime)
    quantity = Column(Numeric(12, 2), nullable=False)
    pallet_packing = Column(Boolean, default=False)
    pallet_quantity = Column(Numeric(12, 2))

    __table_args__ = (
        Index('ix_job_packaging_lookup', 'job_id', 'plan_date', 'machine_no', 'start_time'),
        production_table_args(),
    )
