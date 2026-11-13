from datetime import datetime
from typing import Literal, Optional, List
from pydantic import BaseModel, ConfigDict, EmailStr, Field

CATEGORIES = [
  "Printer Connection Issue",
  "Printer Hardware Issue",
  "Internet Connection",
  "Software Installation",
  "Laptop/PC Hardware Issue",
  "Laptop/PC Software Issue",
  "Department Shared Folder",
  "Application/Software Assistance",
  "Account Credentials Support",
  "Backup Files",
  "Set-Up New Laptop",
]

DEPARTMENTS = [
   "Accounting",
  "Admin",
  "Aftersales",
  "Audit",
  "Baguio Office",
  "Billing",
  "Cebu Office",
  "CM",
  "CSG",
  "EDD",
  "ESG",
  "Finance",
  "Financial Services",
  "HR",
  "Insys",
  "IT",
  "Lobby",
  "Marketing",
  "MIS",
  "OP",
  "OVP",
  "Opulence Cafe Greenhills",
  "Opulence GreenBelt 2",
  "Opulence GreenBelt 5",
  "Opulence Greenhills (Connecticut)",
  "Opulence ITI",
  "Opulence Megamall",
  "Opulence Podium",
  "OVP",
  "PE-QS",
  "PED-QS",
  "PM-ES",
  "Progressive",
  "Purchasing",
  "QA",
  "QA-QC",
  "QA-QS",
  "RMA-SLA",
  "Sales Admin",
  "Supersam BGC",
  "Supersam Commissary",
  "Supersam Commonwealth",
  "Supersam Eastwood",
  "Supersam Greenhills",
  "Supersam ITI",
  "Supersam Parqal",
  "Supersam Tobias",
  "Trade",
  "Warehouse"
]

Category = Literal[tuple(CATEGORIES)]
Department = Literal[tuple(DEPARTMENTS)]
Status = Literal["OPEN", "IN_PROGRESS", "RESOLVED"]
PriorityLevel = Literal["P1", "P2", "P3", "P4"]


class StaffCreate(BaseModel):
    """Used by the main admin to add an IT assistant."""
    email: EmailStr
    password: str = Field(min_length=6, max_length=72)
    full_name: str = Field(min_length=1, max_length=255)
    department: Optional[Department] = None


class AccountDecision(BaseModel):
    decision: Literal["APPROVED", "REJECTED"]


class UserOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: int
    email: EmailStr
    full_name: str
    role: str
    department: Optional[str] = None
    account_status: str = "APPROVED"
    created_at: Optional[datetime] = None


class LoginRequest(BaseModel):
    email: EmailStr
    password: str


class Token(BaseModel):
    access_token: str
    token_type: str = "bearer"
    role: str
    user: UserOut


class CommentCreate(BaseModel):
    content: str = Field(min_length=1)
    is_internal: bool = False


class CommentOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: int
    ticket_id: int
    content: str
    is_internal: bool
    created_at: datetime
    user: UserOut


class PublicTicketCreate(BaseModel):
    """What an employee sends from the public form (no login)."""
    requester_name: str = Field(min_length=1, max_length=100)
    department: Department
    category: Category
    title: str = Field(min_length=1, max_length=255)
    description: str = Field(min_length=1, max_length=5000)
    website: Optional[str] = Field(default=None, max_length=200)  # hidden spam trap, humans leave it empty


class PublicTicketOut(BaseModel):
    """The only thing a public visitor ever gets back: no names, notes or account data."""
    model_config = ConfigDict(from_attributes=True)
    id: int
    title: str
    status: str
    created_at: datetime


class ManualTicketCreate(BaseModel):
    """A historical ticket encoded by IT staff (Tickets page > + Add Manual Ticket)."""
    requester_name: str = Field(min_length=1, max_length=255)
    department: Department
    category: Category
    title: str = Field(min_length=1, max_length=255)
    description: str = Field(min_length=1, max_length=5000)
    priority_level: PriorityLevel
    status: Status
    assigned_to_id: int
    assigned_to_2_id: Optional[int] = None  # optional second technician
    created_at: datetime  # Original Date Submitted (past dates allowed)
    resolved_at: Optional[datetime] = None  # Date Resolved, only for Resolved tickets


class InvalidMark(BaseModel):
    """Why a ticket is being marked Invalid (submitted by mistake, test, duplicate...)."""
    reason: str = Field(min_length=1, max_length=500)


class ManualTicketBatch(BaseModel):
    """Many manual tickets imported at once from a CSV file (saved all together or not at all)."""
    tickets: List[ManualTicketCreate] = Field(min_length=1, max_length=500)


class TicketUpdate(BaseModel):
    # Ticket information may be corrected by authenticated IT staff.
    title: Optional[str] = Field(default=None, min_length=1, max_length=255)
    description: Optional[str] = Field(default=None, min_length=1, max_length=5000)
    category: Optional[Category] = None
    department: Optional[Department] = None  # send explicit null to clear
    status: Optional[Status] = None
    assigned_to_id: Optional[int] = None  # send explicit null to unassign
    assigned_to_2_id: Optional[int] = None  # optional second technician; explicit null removes
    priority_level: Optional[PriorityLevel] = None  # send explicit null to clear


class TicketOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: int
    title: str
    description: str
    category: str
    department: Optional[str]
    status: str
    reporter_id: Optional[int] = None
    priority_level: Optional[str] = None
    requester_name: Optional[str] = None
    ip_address: Optional[str] = None
    is_manual: bool = False
    resolved_at: Optional[datetime] = None
    deleted_at: Optional[datetime] = None
    invalid_at: Optional[datetime] = None
    invalid_reason: Optional[str] = None
    invalid_by: Optional[UserOut] = None
    manual_entered_at: Optional[datetime] = None
    manual_entered_by: Optional[UserOut] = None
    assigned_to_id: Optional[int]
    assigned_to_2_id: Optional[int] = None
    created_at: datetime
    updated_at: datetime
    last_edited_at: Optional[datetime] = None
    last_edited_by: Optional[UserOut] = None
    reporter: Optional[UserOut] = None
    assigned_to: Optional[UserOut]
    assigned_to_2: Optional[UserOut] = None


class TicketDetail(TicketOut):
    comments: List[CommentOut] = []


class TicketDeletionLogOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: int
    original_ticket_id: int
    ticket_title: str
    ticket_description: str
    ticket_category: str
    ticket_department: Optional[str] = None
    ticket_status: str
    requester_name: Optional[str] = None
    assigned_to_id: Optional[int] = None
    assigned_to_name: Optional[str] = None
    assigned_to_2_id: Optional[int] = None
    assigned_to_2_name: Optional[str] = None
    ticket_created_at: Optional[datetime] = None
    deleted_by_id: int
    deleted_by_name: str
    deleted_at: datetime


class BulkDelete(BaseModel):
    ids: List[int] = Field(min_length=1, max_length=500)



class IPSubmissionLogOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: int
    ticket_id: int
    ip_address: str
    submitted_at: datetime
    user_agent: Optional[str] = None
