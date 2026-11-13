from typing import List, Optional
from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy import or_
from sqlalchemy.orm import Session, joinedload
from ..database import get_db
from .. import models, schemas
from ..auth import STAFF_ROLES, require_staff

router = APIRouter(prefix="/support-logs", tags=["support-logs"])


@router.get("", response_model=List[schemas.TicketOut])
def support_log_tickets(user_id: Optional[int] = None, db: Session = Depends(get_db),
                        me: models.User = Depends(require_staff)):
    """Tickets handled by IT staff, in every status (the page filters them by day, week or month).

    - IT assistant: always their own tickets (the primary OR the second technician).
      Asking for somebody else's logs is refused.
    - IT admin: user_id=<staff id> for one person's logs (an assistant, or the admin themself);
      no user_id for the overall logs of every ticket that has at least one technician.
    """
    if me.role != "ADMIN":
        if user_id is not None and user_id != me.id:
            raise HTTPException(status.HTTP_403_FORBIDDEN, "You can only view your own support logs")
        user_id = me.id
    elif user_id is not None:
        person = db.get(models.User, user_id)
        if not person or person.role not in STAFF_ROLES:
            raise HTTPException(status.HTTP_404_NOT_FOUND, "IT staff member not found")

    query = db.query(models.Ticket).options(
        joinedload(models.Ticket.reporter), joinedload(models.Ticket.assigned_to),
        joinedload(models.Ticket.assigned_to_2), joinedload(models.Ticket.last_edited_by),
        joinedload(models.Ticket.manual_entered_by))
    query = query.filter(models.Ticket.invalid_at.is_(None))  # invalid tickets are not counted
    if user_id is not None:
        query = query.filter(or_(models.Ticket.assigned_to_id == user_id,
                                 models.Ticket.assigned_to_2_id == user_id))
    else:
        query = query.filter(models.Ticket.assigned_to_id.isnot(None))
    return query.order_by(models.Ticket.created_at.desc()).all()
