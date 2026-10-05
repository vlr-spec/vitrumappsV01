# pyrefly: ignore [missing-import]
from fastapi import APIRouter, Depends, HTTPException
# pyrefly: ignore [missing-import]
from sqlalchemy import and_, or_
# pyrefly: ignore [missing-import]
from sqlalchemy.orm import Session, selectinload
from typing import List, Optional
from decimal import Decimal
from datetime import date, datetime, timedelta

from app.db.session import get_db
from app.models.job import JobMaster, ProductionJob, JobPackaging, MachineJobSequence, generate_next_job_id
from app.models.machine import MachineMaster
from app.models.product import BottleConfiguration
from app.models.audit_log import AuditLog
from app.schemas.job import ProductionJobResponse, ProductionJobCreate, ExtendJobRequest, ProductionJobBulkRequest, ProductionJobBulkDeleteRequest, ProductionJobBulkDeleteResponse
from app.api.permissions import require_module_read, require_module_edit, MODULE_PRODUCTION_PLANNING
from app.models.auth import AuthUser

router = APIRouter(prefix="/jobs", tags=["Production Jobs"])

@router.get("/", response_model=List[ProductionJobResponse])
def get_all_jobs(
    db: Session = Depends(get_db),
    _user: AuthUser = Depends(require_module_read(MODULE_PRODUCTION_PLANNING)),
    from_date: Optional[date] = None,
    to_date: Optional[date] = None,
    machine_no: Optional[int] = None,
    limit: Optional[int] = None,
    order_by: Optional[str] = None,
):
    """
    Fetch all production jobs.
    """
    # Defensive coercion if passed as str in direct function invocations
    parsed_from = from_date
    if isinstance(parsed_from, str):
        try:
            parsed_from = date.fromisoformat(parsed_from)
        except ValueError:
            raise HTTPException(status_code=422, detail="Invalid from_date format. Expected YYYY-MM-DD.")

    parsed_to = to_date
    if isinstance(parsed_to, str):
        try:
            parsed_to = date.fromisoformat(parsed_to)
        except ValueError:
            raise HTTPException(status_code=422, detail="Invalid to_date format. Expected YYYY-MM-DD.")

    if parsed_from and parsed_to and parsed_from > parsed_to:
        raise HTTPException(
            status_code=422,
            detail="from_date must be less than or equal to to_date",
        )

    query = db.query(ProductionJob).options(selectinload(ProductionJob.packaging))
    if parsed_from:
        query = query.filter(ProductionJob.plan_date >= parsed_from)
    if parsed_to:
        query = query.filter(ProductionJob.plan_date <= parsed_to)
    if machine_no:
        query = query.filter(ProductionJob.machine_no == machine_no)
    if order_by == "desc":
        query = query.order_by(ProductionJob.plan_date.desc(), ProductionJob.start_time.desc())
    if limit:
        query = query.limit(limit)
    return query.all()

@router.post("/", response_model=ProductionJobResponse)
def create_job(
    job_in: ProductionJobCreate, 
    db: Session = Depends(get_db),
    _user: AuthUser = Depends(require_module_edit(MODULE_PRODUCTION_PLANNING))
):
    """
    Add a new job. The Backend Calculation Engine automatically computes Quantity and Tonnage.
    Supports upsert: if a job with the same date/machine/start_time/section exists, it will be updated.
    """
    try:
        # 1. Resolve or create the logical job_id via job_master
        if job_in.job_id is not None:
            # Frontend supplies an existing job_id — validate it exists
            jm = db.query(JobMaster).filter(JobMaster.job_id == job_in.job_id).first()
            if not jm:
                raise HTTPException(status_code=404, detail=f"job_master.job_id={job_in.job_id} not found")
            resolved_job_id = job_in.job_id
        else:
            # Genuinely new logical job — generate machine-specific job_id
            # Format: machine_no * 100 + sequence (e.g. Machine 1 → 101, 102, ...)
            resolved_job_id = generate_next_job_id(db, job_in.machine_no)
            jm = JobMaster(job_id=resolved_job_id)
            db.add(jm)
            db.flush()

        # 2. Fetch Machine and Bottle Configuration from the DB.
        #    Strict composite-key validation against bottle_configuration:
        #    production_job is keyed on (bottle_id, machine_no, section) through
        #    fk_production_job_configuration, so THAT EXACT combination must
        #    exist in bottle_configuration.  Never fall back to another section
        #    or another machine's row: that would silently substitute a
        #    different configuration and still violate the foreign key.
        machine = db.query(MachineMaster).filter(MachineMaster.machine_no == job_in.machine_no).first()
        bottle_config = db.query(BottleConfiguration).filter(
            BottleConfiguration.machine_no == job_in.machine_no,
            BottleConfiguration.bottle_id == job_in.bottle_id,
            BottleConfiguration.section == job_in.section
        ).first()

        if not bottle_config:
            raise HTTPException(
                status_code=400,
                detail=(
                    f"Invalid bottle configuration for job {resolved_job_id} "
                    f"on {job_in.plan_date}: no bottle_configuration row for "
                    f"bottle_id={job_in.bottle_id}, machine_no={job_in.machine_no}, "
                    f"section={job_in.section}. Configure this bottle for this "
                    f"machine and section first."
                ),
            )

        # The requested section is the section that gets stored.
        resolved_section = job_in.section

        # 3. Execute Factory Formula (The Calculation Engine)
        running_minutes = 1440 - job_in.changeover_minutes
        speed = bottle_config.speeds
        gob = machine.gob_type if machine else (3 if job_in.machine_no in (1, 4) else 2)
        calculated_qty = speed * gob * running_minutes
        calculated_draw = (calculated_qty * bottle_config.weight) / Decimal("1000000")

        # 4. Create or Update the Job (Upsert by plan_date + machine_no + start_time + section)
        existing_job = db.query(ProductionJob).filter_by(
            plan_date=job_in.plan_date,
            machine_no=job_in.machine_no,
            start_time=job_in.start_time,
            section=resolved_section,
        ).first()

        if existing_job:
            existing_job.job_id = resolved_job_id
            existing_job.bottle_id = job_in.bottle_id
            existing_job.weight = bottle_config.weight
            existing_job.speeds = speed
            existing_job.draw = job_in.draw if job_in.draw else calculated_draw
            existing_job.quantity = calculated_qty
            existing_job.required_bottles = job_in.required_bottles
            existing_job.estimated_completion = job_in.estimated_completion
            existing_job.completion_time = job_in.completion_time
            existing_job.changeover_minutes = job_in.changeover_minutes
            if job_in.status:
                existing_job.status = job_in.status

            # new_job = existing_job
        else:
            new_job = ProductionJob(
                job_id=resolved_job_id,
                plan_date=job_in.plan_date,
                machine_no=job_in.machine_no,
                start_time=job_in.start_time,
                bottle_id=job_in.bottle_id,
                section=resolved_section,
                weight=bottle_config.weight,
                speeds=speed,
                draw=job_in.draw if job_in.draw else calculated_draw,
                quantity=calculated_qty,
                required_bottles=job_in.required_bottles,
                estimated_completion=job_in.estimated_completion,
                completion_time=job_in.completion_time,
                changeover_minutes=job_in.changeover_minutes,
                status=job_in.status or "Planned",
            )
            db.add(new_job)
            db.flush()
            db.refresh(new_job)

        # 5. Handle Packaging (if provided) — preserve existing records
        for pack in job_in.packaging:
            # Only insert if a packaging record with this (job_id, packaging_type) does not already exist
            existing_pack = db.query(JobPackaging).filter_by(
                job_id=resolved_job_id,
                packaging_type=pack.packaging_type,
            ).first()
            if existing_pack is None:
                db.add(JobPackaging(
                    job_id=resolved_job_id,
                    plan_date=job_in.plan_date,
                    machine_no=job_in.machine_no,
                    bottle_id=job_in.bottle_id,
                    section=resolved_section,
                    start_time=job_in.start_time,
                    packaging_type=pack.packaging_type,
                    quantity=pack.quantity,
                    pallet_packing=pack.pallet_packing,
                    pallet_quantity=pack.pallet_quantity,
                ))

        db.commit()
        db.refresh(new_job)
        return new_job
    except HTTPException:
        db.rollback()
        raise
    except Exception as e:
        db.rollback()
        raise HTTPException(status_code=500, detail=f"Failed to create job: {str(e)}")


@router.post("/bulk/", response_model=List[ProductionJobResponse])
def create_jobs_bulk(
    bulk_in: ProductionJobBulkRequest,
    db: Session = Depends(get_db),
    _user: AuthUser = Depends(require_module_edit(MODULE_PRODUCTION_PLANNING)),
):
    """
    Upsert many production jobs in ONE transaction.

    Identical logic to POST /api/production/jobs/ per row, but avoids N
    separate HTTP round-trips.  Rows are processed in order so job_id
    generation matches the sequential single-POST behaviour.
    """
    jobs_in = bulk_in.jobs
    if not jobs_in:
        return []

    try:
        # ── 1. Pre-load lookup tables ONCE ────────────────────────────────────
        machines = {m.machine_no: m for m in db.query(MachineMaster).all()}

        configs = db.query(BottleConfiguration).all()
        configs_by_key: dict[tuple, BottleConfiguration] = {}
        for c in configs:
            configs_by_key[(c.machine_no, c.bottle_id, c.section)] = c

        # Lock sequence rows to prevent concurrent job_id collisions
        seq_rows = db.query(MachineJobSequence).with_for_update().all()
        sequences = {s.machine_no: s for s in seq_rows}

        # ── 2. Validate EVERY row BEFORE anything is written ─────────────────
        #     production_job has an FK on (bottle_id, machine_no, section):
        #     fk_production_job_configuration.  A row referencing a combination
        #     that is absent from bottle_configuration would otherwise be
        #     rejected by the database with an opaque foreign-key error, so it
        #     is rejected here with a message naming the job, bottle, machine
        #     and section.  No fallback to another section/machine is attempted.
        for index, job_in in enumerate(jobs_in, start=1):
            if (job_in.machine_no, job_in.bottle_id, job_in.section) not in configs_by_key:
                raise HTTPException(
                    status_code=400,
                    detail=(
                        f"Invalid bottle configuration for job "
                        f"{job_in.job_id if job_in.job_id is not None else f'row {index}'} "
                        f"on {job_in.plan_date}: no bottle_configuration row for "
                        f"bottle_id={job_in.bottle_id}, machine_no={job_in.machine_no}, "
                        f"section={job_in.section}. Configure this bottle for this "
                        f"machine and section first."
                    ),
                )

        # ── 3. Process each job in order (same logic as create_job) ──────────
        results: list[dict] = []

        for job_in in jobs_in:
            # Resolve job_id
            if job_in.job_id is not None:
                jm = db.query(JobMaster).filter(JobMaster.job_id == job_in.job_id).first()
                if not jm:
                    raise HTTPException(status_code=404, detail=f"job_master.job_id={job_in.job_id} not found")
                resolved_job_id = job_in.job_id
            else:
                machine_no_int = job_in.machine_no
                seq_obj = sequences.get(machine_no_int)
                if seq_obj is None:
                    seq_obj = MachineJobSequence(machine_no=machine_no_int, next_sequence=1)
                    db.add(seq_obj)
                    db.flush()
                    sequences[machine_no_int] = seq_obj
                resolved_job_id = machine_no_int * 100 + seq_obj.next_sequence
                seq_obj.next_sequence += 1
                db.add(JobMaster(job_id=resolved_job_id))
                db.flush()

            machine = machines.get(job_in.machine_no)

            # Bottle config: EXACT composite key only (validated above).
            bottle_config = configs_by_key[(job_in.machine_no, job_in.bottle_id, job_in.section)]

            resolved_section = job_in.section

            # Factory formula
            running_minutes = 1440 - job_in.changeover_minutes
            speed = bottle_config.speeds
            gob = machine.gob_type if machine else (3 if job_in.machine_no in (1, 4) else 2)
            calculated_qty = speed * gob * running_minutes
            calculated_draw = (calculated_qty * bottle_config.weight) / Decimal("1000000")

            # Upsert production_job
            existing_job = db.query(ProductionJob).filter_by(
                plan_date=job_in.plan_date,
                machine_no=job_in.machine_no,
                start_time=job_in.start_time,
                section=resolved_section,
            ).first()

            if existing_job:
                existing_job.job_id = resolved_job_id
                existing_job.bottle_id = job_in.bottle_id
                existing_job.weight = bottle_config.weight
                existing_job.speeds = speed
                existing_job.draw = job_in.draw if job_in.draw else calculated_draw
                existing_job.quantity = calculated_qty
                existing_job.required_bottles = job_in.required_bottles
                existing_job.estimated_completion = job_in.estimated_completion
                existing_job.completion_time = job_in.completion_time
                existing_job.changeover_minutes = job_in.changeover_minutes
                if job_in.status:
                    existing_job.status = job_in.status
                result_job = existing_job
            else:
                result_job = ProductionJob(
                    job_id=resolved_job_id,
                    plan_date=job_in.plan_date,
                    machine_no=job_in.machine_no,
                    start_time=job_in.start_time,
                    bottle_id=job_in.bottle_id,
                    section=resolved_section,
                    weight=bottle_config.weight,
                    speeds=speed,
                    draw=job_in.draw if job_in.draw else calculated_draw,
                    quantity=calculated_qty,
                    required_bottles=job_in.required_bottles,
                    estimated_completion=job_in.estimated_completion,
                    completion_time=job_in.completion_time,
                    changeover_minutes=job_in.changeover_minutes,
                    status=job_in.status or "Planned",
                )
                db.add(result_job)
                db.flush()
                db.refresh(result_job)

            # Packaging — preserve existing records; only insert if not already present
            for pack in job_in.packaging:
                existing_pack = db.query(JobPackaging).filter_by(
                    job_id=resolved_job_id,
                    packaging_type=pack.packaging_type,
                ).first()
                if existing_pack is None:
                    db.add(JobPackaging(
                        job_id=resolved_job_id,
                        plan_date=job_in.plan_date,
                        machine_no=job_in.machine_no,
                        bottle_id=job_in.bottle_id,
                        section=resolved_section,
                        start_time=job_in.start_time,
                        packaging_type=pack.packaging_type,
                        quantity=pack.quantity,
                        pallet_packing=pack.pallet_packing,
                        pallet_quantity=pack.pallet_quantity,
                    ))

            results.append({
                "job_id": resolved_job_id,
                "plan_date": job_in.plan_date,
                "machine_no": job_in.machine_no,
                "start_time": job_in.start_time,
                "bottle_id": job_in.bottle_id,
                "section": resolved_section,
                "weight": bottle_config.weight,
                "speeds": speed,
                "draw": job_in.draw if job_in.draw else calculated_draw,
                "quantity": calculated_qty,
                "required_bottles": job_in.required_bottles,
                "estimated_completion": job_in.estimated_completion,
                "completion_time": job_in.completion_time,
                "changeover_minutes": job_in.changeover_minutes,
                "status": job_in.status or "Planned",
                "packaging": [
                    {
                        "packaging_type": p.packaging_type,
                        "quantity": p.quantity,
                        "pallet_packing": p.pallet_packing,
                        "pallet_quantity": p.pallet_quantity,
                    }
                    for p in job_in.packaging
                ],
            })

        db.commit()
        return results
    except HTTPException:
        db.rollback()
        raise
    except Exception as e:
        db.rollback()
        raise HTTPException(status_code=500, detail=f"Failed to bulk save jobs: {str(e)}")


@router.get("/next-id/{machine_no}")
def get_next_job_id(
    machine_no: int,
    db: Session = Depends(get_db),
    _user: AuthUser = Depends(require_module_read(MODULE_PRODUCTION_PLANNING)),
):
    """
    Return the next available job_id for a machine WITHOUT consuming it.

    Format: machine_no * 100 + next_sequence
    Useful for frontend preview or diagnostics.
    """
    from app.models.job import MachineJobSequence

    seq = db.query(MachineJobSequence).filter(
        MachineJobSequence.machine_no == machine_no
    ).first()

    if seq is None:
        next_seq = 1
    else:
        next_seq = seq.next_sequence

    return {
        "machine_no": machine_no,
        "next_sequence": next_seq,
        "job_id": machine_no * 100 + next_seq,
    }


@router.post("/reserve-id/{machine_no}")
def reserve_next_job_id(
    machine_no: int,
    db: Session = Depends(get_db),
    _user: AuthUser = Depends(require_module_edit(MODULE_PRODUCTION_PLANNING))
):
    """
    Reserve the next job_id for a machine WITHOUT persisting a production job.

    Uses the exact existing generation architecture (machine_no * 100 +
    sequence, concurrency-safe SELECT ... FOR UPDATE) and registers the id in
    job_master so it is a valid business Job ID that later saves can reuse.

    The frontend calls this when a brand-new job is created so the Job ID is
    available immediately (before anything is saved) and continuation rows
    created with "+" inherit the same id.
    """
    resolved_job_id = generate_next_job_id(db, machine_no)
    db.add(JobMaster(job_id=resolved_job_id))
    db.commit()
    return {
        "machine_no": machine_no,
        "job_id": resolved_job_id,
    }


@router.post("/extend/", response_model=List[ProductionJobResponse])
def extend_job(
    req: ExtendJobRequest,
    db: Session = Depends(get_db),
    _user: AuthUser = Depends(require_module_edit(MODULE_PRODUCTION_PLANNING)),
    user_role: Optional[str] = None,
):
    """
    Extend a production job by N extra days.

    - A continuation row for the selected job is inserted on each of the next N
      calendar days (same daily production window as the source job).
    - Every subsequent job on the same machine — including jobs that start later
      on the source's own day and jobs on strictly later days — is shifted
      forward by N days so no job is overwritten and the original order is kept.
    - The selected job itself and all other jobs remain unchanged.
    """
    days = max(1, min(int(req.days) if req.days else 1, 10))

    source = db.query(ProductionJob).filter_by(
        plan_date=req.plan_date,
        machine_no=req.machine_no,
        start_time=req.start_time,
    ).first()

    if not source:
        raise HTTPException(status_code=404, detail="Job not found")

    # Snapshot the source fields now — the session identity map is cleared below.
    # The daily production window comes from the actual job data (estimated
    # completion, falling back to the real completion time for ended jobs),
    # never a hardcoded time.
    src_end = source.estimated_completion or source.completion_time
    src = {
        "job_id": source.job_id,
        "bottle_id": source.bottle_id,
        "section": source.section,
        "weight": source.weight,
        "speeds": source.speeds,
        "draw": source.draw,
        "quantity": source.quantity,
        "required_bottles": source.required_bottles,
        "estimated_completion": source.estimated_completion,
        "completion_time": source.completion_time,
        "window_end": src_end,
        "changeover_minutes": source.changeover_minutes,
    }

    # ── 1. Shift every subsequent job on this machine forward by N days ─────────
    # "Subsequent" means any job that comes after the selected job in the
    # machine's production sequence: a job that starts later on the same day OR
    # a job on a strictly later day.
    # Process in descending order so each destination slot is vacated before we
    # write into it (a job may be moving onto the key a later job just vacated).
    subsequent = (
        db.query(ProductionJob)
        .filter(
            ProductionJob.machine_no == req.machine_no,
            or_(
                ProductionJob.plan_date > req.plan_date,
                and_(
                    ProductionJob.plan_date == req.plan_date,
                    ProductionJob.start_time > req.start_time,
                ),
            ),
        )
        .order_by(ProductionJob.plan_date.desc(), ProductionJob.start_time.desc())
        .all()
    )

    for job in subsequent:
        new_plan = job.plan_date + timedelta(days=days)
        new_start = job.start_time + timedelta(days=days)

        db.query(JobPackaging).filter_by(
            job_id=job.job_id,
            plan_date=job.plan_date,
            machine_no=job.machine_no,
            start_time=job.start_time,
        ).update(
            {"plan_date": new_plan, "start_time": new_start},
            synchronize_session=False,
        )
        db.flush()

        db.query(ProductionJob).filter_by(
            plan_date=job.plan_date,
            machine_no=job.machine_no,
            start_time=job.start_time,
            section=job.section,
        ).update(
            {
                "plan_date": new_plan,
                "start_time": new_start,
                "estimated_completion": (
                    (job.estimated_completion + timedelta(days=days))
                    if job.estimated_completion else None
                ),
                "completion_time": (
                    (job.completion_time + timedelta(days=days))
                    if job.completion_time else None
                ),
            },
            synchronize_session=False,
        )
        db.flush()

    # Drop the stale in-memory copies of the rows that were moved, so inserting
    # a continuation at a vacated (plan_date, start_time) key never collides
    # with an old identity-map entry.
    db.expire_all()
    db.flush()

    # ── 2. Insert a continuation row for the selected job on each of the next N days
    for d in range(1, days + 1):
        new_plan = req.plan_date + timedelta(days=d)
        new_start = req.start_time + timedelta(days=d)

        existing = db.query(ProductionJob).filter_by(
            plan_date=new_plan,
            machine_no=req.machine_no,
            start_time=new_start,
        ).first()
        if existing:
            continue

        db.add(ProductionJob(
            job_id=src["job_id"],
            plan_date=new_plan,
            machine_no=req.machine_no,
            start_time=new_start,
            bottle_id=src["bottle_id"],
            section=src["section"],
            weight=src["weight"],
            speeds=src["speeds"],
            draw=src["draw"],
            quantity=src["quantity"],
            required_bottles=src["required_bottles"],
            estimated_completion=(
                (src["window_end"] + timedelta(days=d))
                if src["window_end"] else None
            ),
            completion_time=None,
            changeover_minutes=src["changeover_minutes"],
            status="Planned",
        ))

    db.commit()

    affected = (
        db.query(ProductionJob)
        .options(selectinload(ProductionJob.packaging))
        .filter(
            ProductionJob.machine_no == req.machine_no,
            ProductionJob.plan_date >= req.plan_date,
        )
        .order_by(ProductionJob.plan_date, ProductionJob.start_time)
        .all()
    )
    return affected

def _delete_job_slot(
    db: Session,
    plan_date: str,
    machine_no: int,
    start_time: str,
    job_id: Optional[int] = None,
    section: Optional[int] = None,
    commit: bool = True,
) -> bool:
    """
    Delete the production job row(s) belonging to ONE specific day/slot.

    production_job.job_id is NOT unique: an extended job intentionally shares
    the same logical job_id across multiple dates, machines and sections. This
    deletion is therefore ALWAYS scoped to the exact day (plan_date + machine_no
    + start_time), optionally narrowed to a specific job_id and section. Rows
    for other dates that share the same job_id are never touched and job_master
    is only removed once NO production_job rows reference it anymore.

    - Missing rows are an idempotent no-op (returns False): the caller may
      remove a day that was never persisted, and should not be told it
      "could not be removed".
    - The backward-shift that closes a scheduling gap is applied ONLY for
      standalone jobs. When the removed day belongs to a multi-day extended job
      (other dates still reference the same job_id), the remaining continuation
      days stay exactly where they are.

    Returns True when at least one row was deleted.  With ``commit=False`` the
    caller owns the transaction (used by the bulk endpoint to commit once).
    """
    try:
        parsed_date = datetime.strptime(plan_date, "%Y-%m-%d").date()
        parsed_time = datetime.strptime(start_time, "%H:%M").time()
        parsed_start_time = datetime.combine(parsed_date, parsed_time)
    except ValueError:
        raise HTTPException(status_code=422, detail="Invalid plan_date or start_time format")

    match_query = db.query(ProductionJob).filter(
        ProductionJob.plan_date == parsed_date,
        ProductionJob.machine_no == machine_no,
        ProductionJob.start_time == parsed_start_time,
    )
    if job_id is not None:
        match_query = match_query.filter(ProductionJob.job_id == job_id)
    if section is not None:
        match_query = match_query.filter(ProductionJob.section == section)

    matched = match_query.all()

    # Idempotent delete: the exact day rows are already absent, nothing to do.
    if not matched:
        return False

    affected_job_ids = {row.job_id for row in matched}

    # Is any of the removed day's job_ids still used by an OTHER date? If so,
    # this is a partial deletion of an extended job and the other continuation
    # days must be left exactly where they are (no backward shift).
    extended_deletion = (
        db.query(ProductionJob)
        .filter(
            ProductionJob.job_id.in_(list(affected_job_ids)),
            ProductionJob.plan_date != parsed_date,
        )
        .first()
        is not None
    )

    # Snapshot the deleted slot's timing before removal
    first = matched[0]
    deleted_start = first.start_time
    deleted_plan = first.plan_date

    # ── 1. Delete packaging + production rows for the removed day only ─────────
    for job_row in matched:
        db.query(JobPackaging).filter_by(
            job_id=job_row.job_id,
            plan_date=job_row.plan_date,
            machine_no=job_row.machine_no,
            start_time=job_row.start_time,
        ).delete()
        db.flush()

        db.delete(job_row)
        db.flush()

    # ── 2. Shift subsequent jobs backward ONLY for standalone jobs ─────────────
    if not extended_deletion:
        # Fresh query so we read from the DB state that already excludes the
        # deleted rows.
        subsequent = (
            db.query(ProductionJob)
            .filter(
                ProductionJob.machine_no == machine_no,
                or_(
                    ProductionJob.plan_date > deleted_plan,
                    and_(
                        ProductionJob.plan_date == deleted_plan,
                        ProductionJob.start_time > deleted_start,
                    ),
                ),
            )
            .order_by(ProductionJob.plan_date, ProductionJob.start_time)
            .all()
        )

        if subsequent:
            # The gap to close is the time between the deleted job's start
            # and the next job's start.  Shifting every subsequent job backward
            # by this amount makes the first remaining job start exactly where
            # the deleted job used to start.
            delta = subsequent[0].start_time - deleted_start

        for job in subsequent:
            new_start = job.start_time - delta
            new_plan = new_start.date()

            db.query(JobPackaging).filter_by(
                job_id=job.job_id,
                plan_date=job.plan_date,
                machine_no=job.machine_no,
                start_time=job.start_time,
            ).update(
                {"plan_date": new_plan, "start_time": new_start},
                synchronize_session=False,
            )
            db.flush()

            db.query(ProductionJob).filter_by(
                plan_date=job.plan_date,
                machine_no=job.machine_no,
                start_time=job.start_time,
                section=job.section,
            ).update(
                {
                    "plan_date": new_plan,
                    "start_time": new_start,
                    "estimated_completion": (
                        (job.estimated_completion - delta)
                        if job.estimated_completion else None
                    ),
                    "completion_time": (
                        (job.completion_time - delta)
                        if job.completion_time else None
                    ),
                },
                synchronize_session=False,
            )
            db.flush()

    # ── 3. Clean up job_master only when NO production_job rows remain ─────────
    for affected_id in affected_job_ids:
        still_referenced = (
            db.query(ProductionJob)
            .filter(ProductionJob.job_id == affected_id)
            .first()
        )
        if still_referenced is None:
            # Drop orphaned packaging before removing the master row (FK-safe).
            db.query(JobPackaging).filter(
                JobPackaging.job_id == affected_id
            ).delete()
            db.flush()
            db.query(JobMaster).filter(
                JobMaster.job_id == affected_id
            ).delete()
            db.flush()

    if commit:
        db.commit()
    return True


@router.delete("/{plan_date}/{machine_no}/{start_time}", status_code=204)
def delete_job(
    plan_date: str,
    machine_no: int,
    start_time: str,
    job_id: Optional[int] = None,
    section: Optional[int] = None,
    db: Session = Depends(get_db),
    _user: AuthUser = Depends(require_module_edit(MODULE_PRODUCTION_PLANNING)),
    user_role: Optional[str] = None,
):
    """
    Delete ONE day/slot of a production job.  Idempotent: an absent day is a
    204 no-op.  See _delete_job_slot for the scoping and shift rules.
    """
    _delete_job_slot(db, plan_date, machine_no, start_time, job_id, section)


@router.post("/bulk-delete/", response_model=ProductionJobBulkDeleteResponse)
def delete_jobs_bulk(
    req: ProductionJobBulkDeleteRequest,
    db: Session = Depends(get_db),
    _user: AuthUser = Depends(require_module_edit(MODULE_PRODUCTION_PLANNING)),
    user_role: Optional[str] = None,
):
    """
    Delete many production job slots in ONE transaction.

    Applies exactly the same per-slot logic as DELETE /jobs/{plan_date}/{machine_no}/{start_time}
    (extended-job protection, scheduling-gap close, job_master cleanup) in the
    order the keys are sent, but avoids one HTTP round-trip and one commit per
    row.  Missing rows stay idempotent no-ops.
    """
    if not req.keys:
        return {"deleted": 0}

    deleted = 0
    try:
        for key in req.keys:
            if _delete_job_slot(
                db,
                key.plan_date.isoformat(),
                key.machine_no,
                key.start_time,
                key.job_id,
                key.section,
                commit=False,
            ):
                deleted += 1
        db.commit()
    except HTTPException:
        db.rollback()
        raise
    except Exception as e:
        db.rollback()
        raise HTTPException(status_code=500, detail=f"Failed to bulk delete jobs: {str(e)}")
    return {"deleted": deleted}
