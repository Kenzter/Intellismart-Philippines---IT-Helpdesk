from datetime import datetime, timezone
from sqlalchemy import Column, Integer, String, Text, DateTime, ForeignKey, Boolean
from sqlalchemy.orm import relationship
from .database import Base


def utcnow():
    return datetime.now(timezone.utc)


class User(Base):
    __tablename__ = "users"
    id = Column(Integer, primary_key=True, index=True)
    email = Column(String(255), unique=True, index=True, nullable=False)
    hashed_password = Column(String(255), nullable=False)
    full_name = Column(String(255), nullable=False)
    role = Column(String(10), nullable=False, default="USER")  # USER | ASSISTANT | ADMIN
    department = Column(String(50), nullable=True)
    # PENDING (waiting for admin) | APPROVED (can sign in) | REJECTED (cannot sign in)
    account_status = Column(String(10), nullable=False, default="APPROVED")
    created_at = Column(DateTime(timezone=True), default=utcnow)


class Ticket(Base):
    __tablename__ = "tickets"
    id = Column(Integer, primary_key=True, index=True)
    title = Column(String(255), nullable=False)
    description = Column(Text, nullable=False)
    category = Column(String(60), nullable=False)   # see CATEGORIES in schemas.py
    department = Column(String(50), nullable=True)  # see DEPARTMENTS in schemas.py
    status = Column(String(15), nullable=False, default="OPEN")
    # Set by IT staff: P1 Critical | P2 High | P3 Medium | P4 Low. Empty until staff choose one.
    # NOTE: must not be named "priority" - migrate() in main.py drops a legacy column with that name.
    priority_level = Column(String(2), nullable=True)
    # Employees no longer have accounts: their name is stored on the ticket itself.
    # reporter_id is only filled for older tickets that were created by a logged-in employee.
    requester_name = Column(String(255), nullable=True)
    reporter_id = Column(Integer, ForeignKey("users.id"), nullable=True)
    assigned_to_id = Column(Integer, ForeignKey("users.id"), nullable=True)
    # Optional second technician working on the same ticket (primary stays in assigned_to_id).
    assigned_to_2_id = Column(Integer, ForeignKey("users.id"), nullable=True)
    created_at = Column(DateTime(timezone=True), default=utcnow)
    updated_at = Column(DateTime(timezone=True), default=utcnow, onupdate=utcnow)
    # Last staff member who changed employee-submitted ticket information.
    last_edited_by_id = Column(Integer, ForeignKey("users.id"), nullable=True)
    last_edited_at = Column(DateTime(timezone=True), nullable=True)
    ip_address = Column(String(45), nullable=True)
    # Manual Entry: historical tickets encoded by IT staff (not submitted through the public form).
    # For these, created_at holds the ORIGINAL submission date, ip_address is "Manual Entry",
    # and resolved_at holds the original resolution date (when one applies).
    is_manual = Column(Boolean, nullable=False, default=False)
    manual_entered_by_id = Column(Integer, ForeignKey("users.id"), nullable=True)
    manual_entered_at = Column(DateTime(timezone=True), nullable=True)
    resolved_at = Column(DateTime(timezone=True), nullable=True)
    # Set when an admin deletes the ticket. The row stays so Dashboard and Support Logs keep counting it;
    # every ticket list / detail page hides it. (The full snapshot is in ticket_deletion_logs.)
    deleted_at = Column(DateTime(timezone=True), nullable=True)
    # "Invalid" = submitted by mistake / test / duplicate. Kept for review but NOT counted in the Dashboard or Support Logs.
    invalid_at = Column(DateTime(timezone=True), nullable=True)
    invalid_by_id = Column(Integer, ForeignKey("users.id"), nullable=True)
    invalid_reason = Column(String(500), nullable=True)

    reporter = relationship("User", foreign_keys=[reporter_id])
    assigned_to = relationship("User", foreign_keys=[assigned_to_id])
    assigned_to_2 = relationship("User", foreign_keys=[assigned_to_2_id])
    last_edited_by = relationship("User", foreign_keys=[last_edited_by_id])
    manual_entered_by = relationship("User", foreign_keys=[manual_entered_by_id])
    invalid_by = relationship("User", foreign_keys=[invalid_by_id])
    comments = relationship("Comment", back_populates="ticket",
                            order_by="Comment.created_at", cascade="all, delete-orphan")


class TicketDeletionLog(Base):
    """Permanent snapshot of a ticket at the moment an admin deleted it.

    Deliberately has NO foreign keys (not to tickets, not to users): the audit row must
    survive the deletion of the ticket and any later change to the admin's account.
    """
    __tablename__ = "ticket_deletion_logs"
    id = Column(Integer, primary_key=True, index=True)
    original_ticket_id = Column(Integer, nullable=False, index=True)
    ticket_title = Column(String(255), nullable=False)
    ticket_description = Column(Text, nullable=False)
    ticket_category = Column(String(60), nullable=False)
    ticket_department = Column(String(50), nullable=True)
    ticket_status = Column(String(15), nullable=False)
    requester_name = Column(String(255), nullable=True)
    assigned_to_id = Column(Integer, nullable=True)
    assigned_to_name = Column(String(255), nullable=True)
    assigned_to_2_id = Column(Integer, nullable=True)
    assigned_to_2_name = Column(String(255), nullable=True)
    ticket_created_at = Column(DateTime(timezone=True), nullable=True)
    deleted_by_id = Column(Integer, nullable=False)
    deleted_by_name = Column(String(255), nullable=False)
    deleted_at = Column(DateTime(timezone=True), nullable=False, default=utcnow, index=True)


class Comment(Base):
    __tablename__ = "comments"
    id = Column(Integer, primary_key=True, index=True)
    ticket_id = Column(Integer, ForeignKey("tickets.id"), nullable=False, index=True)
    user_id = Column(Integer, ForeignKey("users.id"), nullable=False)
    content = Column(Text, nullable=False)
    is_internal = Column(Boolean, nullable=False, default=False)
    created_at = Column(DateTime(timezone=True), default=utcnow)

    ticket = relationship("Ticket", back_populates="comments")
    user = relationship("User")



class IPSubmissionLog(Base):
    """Separate submission history; deliberately survives deletion of its ticket."""
    __tablename__ = "ip_submission_logs"
    id = Column(Integer, primary_key=True, index=True)
    ticket_id = Column(Integer, nullable=False, index=True)
    ip_address = Column(String(45), nullable=False, index=True)
    submitted_at = Column(DateTime(timezone=True), nullable=False, default=utcnow, index=True)
    user_agent = Column(String(512), nullable=True)
