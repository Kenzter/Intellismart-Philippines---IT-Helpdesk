import os
from contextlib import asynccontextmanager
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from .database import Base, engine, SessionLocal
from . import models
from .auth import SECRET_KEY, hash_password
from sqlalchemy import inspect, text
from .routers import auth, tickets, users, stats, public, support_logs


def seed_admin():
    """Create a default IT agent on first run (override with ADMIN_EMAIL / ADMIN_PASSWORD)."""
    db = SessionLocal()
    try:
        if not db.query(models.User).filter(models.User.role == "ADMIN").first():
            db.add(models.User(
                email=os.getenv("ADMIN_EMAIL", "admin@example.com"),
                full_name="IT Admin",
                hashed_password=hash_password(os.getenv("ADMIN_PASSWORD", "Your_Password_Here")),
                role="ADMIN"))
            db.commit()
    finally:
        db.close()


def _sqlite_make_reporter_optional(conn):
    """SQLite cannot drop NOT NULL in place, so copy the tickets into a corrected table (all data kept)."""
    conn.execute(text("""CREATE TABLE tickets_new (
        id INTEGER NOT NULL PRIMARY KEY, title VARCHAR(255) NOT NULL, description TEXT NOT NULL,
        category VARCHAR(60) NOT NULL, department VARCHAR(50), requester_name VARCHAR(255),
        status VARCHAR(15) NOT NULL, reporter_id INTEGER, assigned_to_id INTEGER,
        created_at DATETIME, updated_at DATETIME,
        FOREIGN KEY(reporter_id) REFERENCES users (id), FOREIGN KEY(assigned_to_id) REFERENCES users (id))"""))
    cols = "id, title, description, category, department, requester_name, status, reporter_id, assigned_to_id, created_at, updated_at"
    conn.execute(text(f"INSERT INTO tickets_new ({cols}) SELECT {cols} FROM tickets"))
    conn.execute(text("DROP TABLE tickets"))
    conn.execute(text("ALTER TABLE tickets_new RENAME TO tickets"))
    conn.execute(text("CREATE INDEX IF NOT EXISTS ix_tickets_id ON tickets (id)"))


def migrate():
    """Upgrade an older database in place. Existing tickets, comments and accounts are kept."""
    insp = inspect(engine)
    if "tickets" not in insp.get_table_names():
        return
    cols = {c["name"]: c for c in insp.get_columns("tickets")}
    ucols = {c["name"] for c in insp.get_columns("users")}
    with engine.begin() as conn:
        if "department" not in ucols:
            conn.execute(text("ALTER TABLE users ADD COLUMN department VARCHAR(50)"))
        if "account_status" not in ucols:  # everyone who already exists stays approved
            conn.execute(text("ALTER TABLE users ADD COLUMN account_status VARCHAR(10) NOT NULL DEFAULT 'APPROVED'"))
        if "department" not in cols:
            conn.execute(text("ALTER TABLE tickets ADD COLUMN department VARCHAR(50)"))
        # The new category names are longer than the old 20-character column (PostgreSQL enforces this).
        if engine.dialect.name == "postgresql":
            cat = cols.get("category")
            if cat is not None and (getattr(cat["type"], "length", None) or 60) < 60:
                conn.execute(text("ALTER TABLE tickets ALTER COLUMN category TYPE VARCHAR(60)"))
        if "priority" in cols:
            conn.execute(text("ALTER TABLE tickets DROP COLUMN priority"))
        # Public tickets store the employee's name on the ticket. Older tickets keep their reporter's name.
        if "requester_name" not in cols:
            conn.execute(text("ALTER TABLE tickets ADD COLUMN requester_name VARCHAR(255)"))
        conn.execute(text("UPDATE tickets SET requester_name = (SELECT full_name FROM users WHERE users.id = tickets.reporter_id) "
                          "WHERE requester_name IS NULL AND reporter_id IS NOT NULL"))
        # Public tickets have no reporter account, so reporter_id must be allowed to be empty.
        if cols["reporter_id"].get("nullable") is False:
            if engine.dialect.name == "postgresql":
                conn.execute(text("ALTER TABLE tickets ALTER COLUMN reporter_id DROP NOT NULL"))
            elif engine.dialect.name == "sqlite":
                _sqlite_make_reporter_optional(conn)
        # Persist who last corrected the employee-submitted ticket information.
        current_cols = {c["name"] for c in inspect(conn).get_columns("tickets")}
        if "last_edited_by_id" not in current_cols:
            conn.execute(text("ALTER TABLE tickets ADD COLUMN last_edited_by_id INTEGER REFERENCES users (id)"))
        if "last_edited_at" not in current_cols:
            timestamp_type = "TIMESTAMP WITH TIME ZONE" if engine.dialect.name == "postgresql" else "DATETIME"
            conn.execute(text(f"ALTER TABLE tickets ADD COLUMN last_edited_at {timestamp_type}"))
        # Priority level (P1-P4) chosen by IT staff. Existing tickets stay empty (not set).
        if "priority_level" not in current_cols:
            conn.execute(text("ALTER TABLE tickets ADD COLUMN priority_level VARCHAR(2)"))
        # Optional second technician on a ticket. Existing tickets stay single-technician (empty).
        if "assigned_to_2_id" not in current_cols:
            conn.execute(text("ALTER TABLE tickets ADD COLUMN assigned_to_2_id INTEGER REFERENCES users (id)"))
        # Store the originating IP on the ticket for direct display in the Tickets table.
        if "ip_address" not in current_cols:
            conn.execute(text("ALTER TABLE tickets ADD COLUMN ip_address VARCHAR(45)"))
        # Manual Entry feature: historical tickets encoded by IT staff. Existing tickets stay is_manual = false.
        timestamp_type = "TIMESTAMP WITH TIME ZONE" if engine.dialect.name == "postgresql" else "DATETIME"
        if "is_manual" not in current_cols:
            false_default = "FALSE" if engine.dialect.name == "postgresql" else "0"
            conn.execute(text(f"ALTER TABLE tickets ADD COLUMN is_manual BOOLEAN NOT NULL DEFAULT {false_default}"))
        if "manual_entered_by_id" not in current_cols:
            conn.execute(text("ALTER TABLE tickets ADD COLUMN manual_entered_by_id INTEGER REFERENCES users (id)"))
        if "manual_entered_at" not in current_cols:
            conn.execute(text(f"ALTER TABLE tickets ADD COLUMN manual_entered_at {timestamp_type}"))
        if "resolved_at" not in current_cols:
            conn.execute(text(f"ALTER TABLE tickets ADD COLUMN resolved_at {timestamp_type}"))
        # Deleted tickets stay in the table (hidden) so Dashboard / Support Logs counts never drop.
        if "deleted_at" not in current_cols:
            conn.execute(text(f"ALTER TABLE tickets ADD COLUMN deleted_at {timestamp_type}"))
            conn.execute(text("CREATE INDEX IF NOT EXISTS ix_tickets_deleted_at ON tickets (deleted_at)"))
        # "Invalid" flag: tickets submitted by mistake. Not counted in the Dashboard / Support Logs.
        if "invalid_at" not in current_cols:
            conn.execute(text(f"ALTER TABLE tickets ADD COLUMN invalid_at {timestamp_type}"))
        if "invalid_by_id" not in current_cols:
            conn.execute(text("ALTER TABLE tickets ADD COLUMN invalid_by_id INTEGER REFERENCES users (id)"))
        if "invalid_reason" not in current_cols:
            conn.execute(text("ALTER TABLE tickets ADD COLUMN invalid_reason VARCHAR(500)"))
        # The "Closed" status was removed: tickets that were Closed are now Resolved (same meaning, nothing lost).
        conn.execute(text("UPDATE tickets SET status = 'RESOLVED' WHERE status = 'CLOSED'"))
        # The deletion log keeps a snapshot of the second technician too.
        if "ticket_deletion_logs" in insp.get_table_names():
            log_cols = {c["name"] for c in inspect(conn).get_columns("ticket_deletion_logs")}
            if "assigned_to_2_id" not in log_cols:
                conn.execute(text("ALTER TABLE ticket_deletion_logs ADD COLUMN assigned_to_2_id INTEGER"))
            if "assigned_to_2_name" not in log_cols:
                conn.execute(text("ALTER TABLE ticket_deletion_logs ADD COLUMN assigned_to_2_name VARCHAR(255)"))


def restore_deleted_counts():
    """Tickets deleted BEFORE soft-delete existed are gone from the tickets table. Put each one back as a hidden
    (deleted) row, rebuilt from its Deletion Log snapshot, so it counts in the Dashboard and Support Logs again.
    Safe to run on every start: a ticket that already exists is skipped."""
    insp = inspect(engine)
    if "tickets" not in insp.get_table_names() or "ticket_deletion_logs" not in insp.get_table_names():
        return
    false = "FALSE" if engine.dialect.name == "postgresql" else "0"
    with engine.begin() as conn:
        added = conn.execute(text(f"""
            INSERT INTO tickets (id, title, description, category, department, status, requester_name,
                                 assigned_to_id, assigned_to_2_id, created_at, updated_at, deleted_at, is_manual)
            SELECT l.original_ticket_id, l.ticket_title, l.ticket_description, l.ticket_category, l.ticket_department,
                   l.ticket_status, l.requester_name,
                   (SELECT u.id FROM users u WHERE u.id = l.assigned_to_id),
                   (SELECT u.id FROM users u WHERE u.id = l.assigned_to_2_id),
                   l.ticket_created_at, l.deleted_at, l.deleted_at, {false}
            FROM ticket_deletion_logs l
            WHERE l.ticket_created_at IS NOT NULL
              AND l.id = (SELECT MIN(l2.id) FROM ticket_deletion_logs l2 WHERE l2.original_ticket_id = l.original_ticket_id)
              AND NOT EXISTS (SELECT 1 FROM tickets t WHERE t.id = l.original_ticket_id)""")).rowcount
        if added and engine.dialect.name == "postgresql":
            # Never let the ticket-number counter fall behind the highest ticket number.
            seq = conn.execute(text("SELECT pg_get_serial_sequence('tickets', 'id')")).scalar()
            if seq:
                conn.execute(text(f"SELECT setval('{seq}', GREATEST((SELECT MAX(id) FROM tickets), (SELECT last_value FROM {seq})))"))


@asynccontextmanager
async def lifespan(_: FastAPI):
    Base.metadata.create_all(bind=engine)
    migrate()
    restore_deleted_counts()
    if SECRET_KEY == "change-me-in-production":
        print("WARNING: SECRET_KEY is not set. Set a long random SECRET_KEY before using this on a real network.")
    seed_admin()
    yield


# Addresses of the website that may talk to this server. Set ALLOWED_ORIGINS to a
# comma-separated list for deployment, e.g. "http://helpdesk.mycompany.com".
ALLOWED_ORIGINS = [o.strip() for o in os.getenv(
    "ALLOWED_ORIGINS", "http://192.168.5.249:5080,http://localhost:5173,http://127.0.0.1:5173").split(",") if o.strip()]

_docs_off = os.getenv("DISABLE_DOCS") == "1"  # set DISABLE_DOCS=1 on the real server
app = FastAPI(title="IT Helpdesk API", version="1.0.0", lifespan=lifespan,
              docs_url=None if _docs_off else "/docs", redoc_url=None if _docs_off else "/redoc",
              openapi_url=None if _docs_off else "/openapi.json")

app.add_middleware(
    CORSMiddleware,
    allow_origins=ALLOWED_ORIGINS,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(auth.router)
app.include_router(public.router)
app.include_router(tickets.router)
app.include_router(users.router)
app.include_router(stats.router)
app.include_router(support_logs.router)


@app.get("/")
def health():
    return {"status": "ok"}
