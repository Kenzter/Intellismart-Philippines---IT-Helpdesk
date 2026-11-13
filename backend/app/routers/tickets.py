from datetime import datetime, timedelta, timezone
from typing import List, Optional
from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy import func, or_
from sqlalchemy.orm import Session, joinedload
from ..database import get_db
from .. import models, schemas
from ..auth import STAFF_ROLES, require_admin, require_staff

router = APIRouter(prefix="/tickets", tags=["tickets"])


def _filtered(db: Session, status_: Optional[str], department: Optional[str],
              category: Optional[str], q: Optional[str]):
    query = db.query(models.Ticket).options(
        joinedload(models.Ticket.reporter), joinedload(models.Ticket.assigned_to),
        joinedload(models.Ticket.assigned_to_2), joinedload(models.Ticket.last_edited_by),
        joinedload(models.Ticket.manual_entered_by), joinedload(models.Ticket.invalid_by)).filter(models.Ticket.deleted_at.is_(None))
    if status_:
        query = query.filter(models.Ticket.status == status_.upper())
    if department:
        query = query.filter(models.Ticket.department == department)
    if category:
        query = query.filter(models.Ticket.category == category)
    if q:
        like = f"%{q.strip()}%"
        clauses = [models.Ticket.title.ilike(like), models.Ticket.description.ilike(like),
                   models.Ticket.requester_name.ilike(like)]
        if q.strip().isdigit():
            clauses.append(models.Ticket.id == int(q.strip()))
        query = query.filter(or_(*clauses))
    return query


@router.get("", response_model=List[schemas.TicketOut])
def list_all_tickets(status: Optional[str] = None, department: Optional[str] = None,
                     category: Optional[str] = None, q: Optional[str] = None,
                     assigned_to_id: Optional[int] = None,
                     db: Session = Depends(get_db), _: models.User = Depends(require_staff)):
    query = _filtered(db, status, department, category, q)
    if assigned_to_id:
        query = query.filter(or_(models.Ticket.assigned_to_id == assigned_to_id,
                                 models.Ticket.assigned_to_2_id == assigned_to_id))
    return query.order_by(models.Ticket.created_at.desc()).all()


@router.get("/assigned-count")
def my_assigned_count(db: Session = Depends(get_db), user: models.User = Depends(require_staff)):
    """Tickets assigned to me that are still being worked on (Open or In Progress)."""
    n = db.query(models.Ticket).filter(
        or_(models.Ticket.assigned_to_id == user.id, models.Ticket.assigned_to_2_id == user.id),
        models.Ticket.status.in_(["OPEN", "IN_PROGRESS"]),
        models.Ticket.deleted_at.is_(None), models.Ticket.invalid_at.is_(None),
    ).count()
    return {"count": n}


# Light check used by the live "new ticket" pop-up every few seconds: returns only the highest ticket number
# and the few new tickets, instead of the whole ticket list. Must stay ABOVE "/{ticket_id}".
@router.get("/alerts")
def new_ticket_alerts(after_id: Optional[int] = None, db: Session = Depends(get_db),
                      _: models.User = Depends(require_staff)):
    visible = db.query(models.Ticket.id).filter(models.Ticket.deleted_at.is_(None))
    max_id = visible.with_entities(func.max(models.Ticket.id)).scalar() or 0
    new = []
    if after_id is not None and max_id > after_id:
        # Only real, new, open tickets alert: manual entries and invalid tickets never do.
        rows = (db.query(models.Ticket.id, models.Ticket.title)
                .filter(models.Ticket.id > after_id, models.Ticket.deleted_at.is_(None),
                        models.Ticket.status == "OPEN", models.Ticket.is_manual.is_(False),
                        models.Ticket.invalid_at.is_(None))
                .order_by(models.Ticket.id).limit(50).all())
        new = [{"id": r.id, "title": r.title} for r in rows]
    return {"max_id": max_id, "new": new}


# Must stay ABOVE "/{ticket_id}" so "deletion-logs" is not parsed as a ticket id.
@router.get("/deletion-logs", response_model=List[schemas.TicketDeletionLogOut])
def list_deletion_logs(db: Session = Depends(get_db), _: models.User = Depends(require_admin)):
    """Permanent history of deleted tickets (main admin only), newest deletion first."""
    return db.query(models.TicketDeletionLog).order_by(
        models.TicketDeletionLog.deleted_at.desc(), models.TicketDeletionLog.id.desc()).all()


@router.get("/ip-logs", response_model=List[schemas.IPSubmissionLogOut])
def list_ip_submission_logs(db: Session = Depends(get_db), _: models.User = Depends(require_staff)):
    """Submission IP history (main admin only), newest submission first."""
    return db.query(models.IPSubmissionLog).order_by(
        models.IPSubmissionLog.submitted_at.desc(), models.IPSubmissionLog.id.desc()).all()


MANUAL_ENTRY_IP = None  # shown in the IP Address column instead of a real address


def _aware(dt: datetime) -> datetime:
    """Dates from the form arrive with a time zone; treat any naive value as Philippine time (UTC+8)."""
    return dt if dt.tzinfo else dt.replace(tzinfo=timezone(timedelta(hours=8)))


def _prepare_manual_ticket(data: schemas.ManualTicketCreate, actor: models.User, db: Session) -> models.Ticket:
    """Validate one manual entry and build it WITHOUT saving (so a rejected row never uses up a ticket number). created_at = original date submitted,
    so the Dashboard (monthly / yearly / overall) and Support Logs count it on the right date automatically."""
    name = " ".join(data.requester_name.split())
    title = " ".join(data.title.split())
    description = data.description.strip()
    if not name or not title or not description:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Name, subject and description cannot be empty.")

    now = datetime.now(timezone.utc)
    submitted = _aware(data.created_at)
    resolved = _aware(data.resolved_at) if data.resolved_at else None
    if submitted > now + timedelta(minutes=5):
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Original Date Submitted cannot be in the future.")
    if resolved is not None:
        if data.status != "RESOLVED":
            raise HTTPException(status.HTTP_400_BAD_REQUEST, "Date Resolved only applies to Resolved tickets.")
        if resolved < submitted:
            raise HTTPException(status.HTTP_400_BAD_REQUEST, "Date Resolved cannot be earlier than the Original Date Submitted.")
        if resolved > now + timedelta(minutes=5):
            raise HTTPException(status.HTTP_400_BAD_REQUEST, "Date Resolved cannot be in the future.")

    tech = db.get(models.User, data.assigned_to_id)
    if not tech or tech.role not in STAFF_ROLES or tech.account_status != "APPROVED":
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Assignee must be an IT agent")
    if tech.role == "ADMIN" and actor.role != "ADMIN":
        raise HTTPException(status.HTTP_403_FORBIDDEN, "Only the main admin can assign tickets to the IT admin")

    tech2 = None
    if data.assigned_to_2_id is not None:
        if data.assigned_to_2_id == tech.id:
            raise HTTPException(status.HTTP_400_BAD_REQUEST, "The second technician must be a different person")
        tech2 = db.get(models.User, data.assigned_to_2_id)
        if not tech2 or tech2.role not in STAFF_ROLES or tech2.account_status != "APPROVED":
            raise HTTPException(status.HTTP_400_BAD_REQUEST, "Assignee must be an IT agent")
        if tech2.role == "ADMIN" and actor.role != "ADMIN":
            raise HTTPException(status.HTTP_403_FORBIDDEN, "Only the main admin can assign tickets to the IT admin")

    # Re-importing the same file (or saving the same entry twice) must not create duplicates.
    if db.query(models.Ticket.id).filter(
            models.Ticket.is_manual.is_(True), models.Ticket.requester_name == name,
            models.Ticket.title == title, models.Ticket.description == description,
            models.Ticket.created_at == submitted).first():
        raise HTTPException(status.HTTP_400_BAD_REQUEST,
                            "A manual ticket with the same employee, subject, description and date submitted already exists.")

    ticket = models.Ticket(
        requester_name=name, title=title, description=description,
        category=data.category, department=data.department,
        status=data.status, priority_level=data.priority_level,
        reporter_id=None, assigned_to_id=tech.id, assigned_to_2_id=tech2.id if tech2 else None,
        created_at=submitted, updated_at=resolved or submitted, resolved_at=resolved,
        ip_address=MANUAL_ENTRY_IP,
        is_manual=True, manual_entered_by_id=actor.id, manual_entered_at=now)
    return ticket


# Must stay ABOVE "/{ticket_id}" routes. Deliberately separate from /public/tickets: no rate limit,
# no IP submission log, and the ticket is flagged is_manual so the live "new ticket" alert skips it.
@router.post("/manual", response_model=schemas.TicketOut, status_code=201)
def create_manual_ticket(data: schemas.ManualTicketCreate, db: Session = Depends(get_db),
                         actor: models.User = Depends(require_staff)):
    """IT staff encode one historical ticket."""
    try:
        ticket = _prepare_manual_ticket(data, actor, db)
        db.add(ticket)
        db.commit()
    except Exception:
        db.rollback()
        raise
    db.refresh(ticket)
    return ticket


@router.post("/manual/batch", status_code=201)
def create_manual_tickets_batch(data: schemas.ManualTicketBatch, db: Session = Depends(get_db),
                                actor: models.User = Depends(require_staff)):
    """Import many historical tickets at once (from the CSV import window). All or nothing:
    if any row is invalid, nothing is saved and the error names the row."""
    # Pass 1: check EVERY row first. Nothing is written yet, so a bad file uses up no ticket numbers.
    prepared, seen = [], set()
    for i, item in enumerate(data.tickets):
        try:
            ticket = _prepare_manual_ticket(item, actor, db)
            key = (ticket.requester_name, ticket.title, ticket.description, ticket.created_at)
            if key in seen:
                raise HTTPException(status.HTTP_400_BAD_REQUEST,
                                    "The same ticket appears more than once in this file.")
            seen.add(key)
        except HTTPException as exc:
            # Row 1 is the header row of the CSV file, so the first ticket is row 2.
            raise HTTPException(exc.status_code, f"Row {i + 2}: {exc.detail}")
        prepared.append(ticket)
    # Pass 2: save them all together, in file order, so the numbers are consecutive.
    try:
        ids = []
        for t in prepared:  # one at a time, in file order, so ticket numbers follow the file order
            db.add(t)
            db.flush()
            ids.append(t.id)
        db.commit()
    except Exception:
        db.rollback()
        raise
    return {"created": len(ids), "ids": ids}


def _get_ticket(ticket_id: int, db: Session) -> models.Ticket:
    ticket = db.get(models.Ticket, ticket_id)
    if not ticket or ticket.deleted_at is not None:  # deleted tickets are hidden everywhere except the counts
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Ticket not found")
    return ticket


@router.get("/{ticket_id}", response_model=schemas.TicketDetail)
def get_ticket(ticket_id: int, db: Session = Depends(get_db), _: models.User = Depends(require_staff)):
    return db.query(models.Ticket).options(
        joinedload(models.Ticket.reporter),
        joinedload(models.Ticket.assigned_to),
        joinedload(models.Ticket.assigned_to_2),
        joinedload(models.Ticket.last_edited_by),
        joinedload(models.Ticket.manual_entered_by),
        joinedload(models.Ticket.invalid_by),
    ).filter(models.Ticket.id == ticket_id, models.Ticket.deleted_at.is_(None)).first() or _get_ticket(ticket_id, db)


@router.patch("/{ticket_id}", response_model=schemas.TicketOut)
def update_ticket(ticket_id: int, data: schemas.TicketUpdate, db: Session = Depends(get_db),
                  actor: models.User = Depends(require_staff)):
    ticket = _get_ticket(ticket_id, db)
    changes = data.model_dump(exclude_unset=True)
    # Record an audit stamp only when ticket information actually changes.
    info_fields = {"title", "description", "category", "department"}
    info_changed = any(field in changes and getattr(ticket, field) != changes[field]
                       for field in info_fields)
    if info_changed:
        ticket.last_edited_by_id = actor.id
        ticket.last_edited_at = models.utcnow()
    for key in ("assigned_to_id", "assigned_to_2_id"):
        if key in changes and changes[key] is not None:
            tech = db.get(models.User, changes[key])
            if not tech or tech.role not in STAFF_ROLES:
                raise HTTPException(status.HTTP_400_BAD_REQUEST, "Assignee must be an IT agent")
            if tech.role == "ADMIN" and actor.role != "ADMIN":
                raise HTTPException(status.HTTP_403_FORBIDDEN, "Only the main admin can assign tickets to the IT admin")
    # Second technician rules, checked against the final result (existing values + this request).
    if "assigned_to_id" in changes or "assigned_to_2_id" in changes:
        primary = changes["assigned_to_id"] if "assigned_to_id" in changes else ticket.assigned_to_id
        second = changes["assigned_to_2_id"] if "assigned_to_2_id" in changes else ticket.assigned_to_2_id
        if primary is None and "assigned_to_id" in changes and "assigned_to_2_id" not in changes:
            second = None  # unassigning the primary technician also clears the second one
            changes["assigned_to_2_id"] = None
        if second is not None and primary is None:
            raise HTTPException(status.HTTP_400_BAD_REQUEST, "Assign a primary technician before adding a second one")
        if second is not None and second == primary:
            raise HTTPException(status.HTTP_400_BAD_REQUEST, "The second technician must be a different person")
    for field, value in changes.items():
        if field == "status" and value is None:
            continue
        setattr(ticket, field, value)
    db.commit()
    db.refresh(ticket)
    return ticket


@router.post("/{ticket_id}/invalid", response_model=schemas.TicketOut)
def mark_invalid(ticket_id: int, data: schemas.InvalidMark, db: Session = Depends(get_db),
                 actor: models.User = Depends(require_staff)):
    """Any IT staff can flag a ticket as Invalid (mistake / test / duplicate). It stops counting in the
    Dashboard and Support Logs, but stays on record with who flagged it and why."""
    ticket = _get_ticket(ticket_id, db)
    if ticket.invalid_at is not None:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "This ticket is already marked as invalid")
    reason = " ".join(data.reason.split())
    if not reason:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Please give a reason")
    ticket.invalid_at = models.utcnow()
    ticket.invalid_by_id = actor.id
    ticket.invalid_reason = reason
    db.commit()
    db.refresh(ticket)
    return ticket


@router.delete("/{ticket_id}/invalid", response_model=schemas.TicketOut)
def restore_invalid(ticket_id: int, db: Session = Depends(get_db), _: models.User = Depends(require_staff)):
    """Any IT staff can undo it: the ticket counts again."""
    ticket = _get_ticket(ticket_id, db)
    if ticket.invalid_at is None:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "This ticket is not marked as invalid")
    ticket.invalid_at = None
    ticket.invalid_by_id = None
    ticket.invalid_reason = None
    db.commit()
    db.refresh(ticket)
    return ticket


@router.post("/{ticket_id}/comments", response_model=schemas.CommentOut, status_code=201)
def add_comment(ticket_id: int, data: schemas.CommentCreate, db: Session = Depends(get_db),
                user: models.User = Depends(require_staff)):
    ticket = _get_ticket(ticket_id, db)
    comment = models.Comment(ticket_id=ticket.id, user_id=user.id,
                             content=data.content, is_internal=data.is_internal)
    db.add(comment)
    db.commit()
    db.refresh(comment)
    return comment


def _delete_if_resolved(db: Session, ticket: models.Ticket, admin: models.User) -> None:
    """Stage an audit snapshot AND the deletion. The caller commits both in one transaction."""
    db.add(models.TicketDeletionLog(
        original_ticket_id=ticket.id,
        ticket_title=ticket.title,
        ticket_description=ticket.description,
        ticket_category=ticket.category,
        ticket_department=ticket.department,
        ticket_status=ticket.status,
        requester_name=ticket.requester_name or (ticket.reporter.full_name if ticket.reporter else None),
        assigned_to_id=ticket.assigned_to_id,
        assigned_to_name=ticket.assigned_to.full_name if ticket.assigned_to else None,
        assigned_to_2_id=ticket.assigned_to_2_id,
        assigned_to_2_name=ticket.assigned_to_2.full_name if ticket.assigned_to_2 else None,
        ticket_created_at=ticket.created_at,
        deleted_by_id=admin.id,
        deleted_by_name=admin.full_name,
        deleted_at=models.utcnow(),
    ))
    # Soft delete: the ticket row stays (hidden) so Dashboard / Support Logs counts do not drop.
    ticket.deleted_at = models.utcnow()
    db.query(models.Comment).filter(models.Comment.ticket_id == ticket.id).delete()  # its comments are removed


def _commit_or_rollback(db: Session) -> None:
    """Audit rows and deletions are saved together or not at all."""
    try:
        db.commit()
    except Exception:
        db.rollback()
        raise HTTPException(status.HTTP_500_INTERNAL_SERVER_ERROR,
                            "Could not delete the ticket(s). Nothing was changed.")


@router.post("/bulk-delete")
def bulk_delete_resolved(data: schemas.BulkDelete, db: Session = Depends(get_db),
                         admin: models.User = Depends(require_admin)):
    """Permanently delete the chosen tickets, but only ones that are Resolved."""
    ids = set(data.ids)  # duplicates in the request must not create duplicate audit rows
    tickets = db.query(models.Ticket).filter(models.Ticket.id.in_(ids), models.Ticket.deleted_at.is_(None)).all()
    deleted = 0
    for t in tickets:
        if t.status == "RESOLVED" or t.invalid_at is not None:  # Resolved or Invalid tickets can be deleted
            _delete_if_resolved(db, t, admin)
            deleted += 1
    _commit_or_rollback(db)
    return {"deleted": deleted, "skipped": len(ids) - deleted}


@router.delete("/{ticket_id}", status_code=204)
def delete_resolved_ticket(ticket_id: int, db: Session = Depends(get_db),
                           admin: models.User = Depends(require_admin)):
    ticket = db.get(models.Ticket, ticket_id)
    if not ticket or ticket.deleted_at is not None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Ticket not found")
    if ticket.status != "RESOLVED" and ticket.invalid_at is None:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Only Resolved or Invalid tickets can be deleted")
    _delete_if_resolved(db, ticket, admin)
    _commit_or_rollback(db)
