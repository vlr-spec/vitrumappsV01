from pydantic import BaseModel


class PackagingBase(BaseModel):
    packaging_code: str
    packaging_description: str


class PackagingCreate(PackagingBase):
    pass


class PackagingUpdate(PackagingBase):
    pass


class PackagingResponse(PackagingBase):
    # Returned to the frontend as the internal key for UPDATE/DELETE only --
    # the Packaging Master UI never renders it.
    packaging_id: int

    class Config:
        from_attributes = True
