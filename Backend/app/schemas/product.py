from pydantic import BaseModel
from decimal import Decimal
from typing import List

class BottleMasterBase(BaseModel):
    bottle_name: str

class BottleMasterCreate(BottleMasterBase):
    pass

class BottleMasterResponse(BottleMasterBase):
    bottle_id: int
    class Config:
        from_attributes = True

class BottleOptionResponse(BottleMasterBase):
    """A bottle as it appears in a parent/child selection dropdown."""
    bottle_id: int
    class Config:
        from_attributes = True

class ParentChildMappingCreate(BaseModel):
    parent_bottle_id: int
    child_bottle_id: int

class ParentChildMappingUpdate(BaseModel):
    parent_bottle_id: int


class ParentChildMappingBulkCreate(BaseModel):
    """Assign several child bottles to one parent in a single request.

    The backend validates every child first and then applies all of them in
    one transaction, so saving N children costs one round-trip and one commit
    instead of N of each.
    """

    parent_bottle_id: int
    child_bottle_ids: List[int]

class ParentChildMappingResponse(BaseModel):
    """One saved parent -> child relationship resolved through bottle_master.group_id."""
    parent_bottle_id: int
    parent_bottle_name: str
    child_bottle_id: int
    child_bottle_name: str
    class Config:
        from_attributes = True

class BottleConfigurationBase(BaseModel):
    machine_no: int
    bottle_id: int
    section: int
    weight: Decimal
    speeds: Decimal

class BottleConfigurationCreate(BottleConfigurationBase):
    pass

class BottleConfigurationBulkRequest(BaseModel):
    configurations: List[BottleConfigurationCreate]

class BottleConfigurationResponse(BottleConfigurationBase):
    class Config:
        from_attributes = True
