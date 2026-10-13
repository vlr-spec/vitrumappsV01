from sqlalchemy import Column, Integer, String, Numeric, ForeignKey
from app.db.base import Base, production_fk, production_table_args

class BottleMaster(Base):
    __tablename__ = "bottle_master"
    __table_args__ = production_table_args()

    bottle_id = Column(Integer, primary_key=True, index=True)
    bottle_name = Column(String(150), nullable=False)
    # Parent/child grouping already present on production.bottle_master.
    #   group_id == bottle_id -> the bottle is a parent (an unmapped bottle).
    #   group_id == <other bottle_id> -> the bottle is a child of that parent.
    # Nullable only so bottles created before the column existed still load;
    # create_bottle always writes group_id = bottle_id for a new record.
    # This column is purely a grouping pointer: it never copies, overrides or
    # replaces bottle_configuration rows, machine assignments or production
    # job bottle_ids.
    group_id = Column(Integer, nullable=True)


class BottleConfiguration(Base):
    __tablename__ = "bottle_configuration"
    __table_args__ = production_table_args()

    machine_no = Column(Integer, ForeignKey(production_fk("machine_master.machine_no")), primary_key=True)
    bottle_id = Column(Integer, ForeignKey(production_fk("bottle_master.bottle_id")), primary_key=True)
    section = Column(Integer, primary_key=True)
    
    weight = Column(Numeric(10, 2), nullable=False)
    speeds = Column(Numeric(10, 2), nullable=False)
