import { useEffect, useState } from "react";
import api, { errorMessage, type Status, type User } from "../api/client";
import { CATEGORIES, DEPARTMENTS } from "../constants";

// CSV columns, in this order. The header row must be present (its wording is not checked).
const HEADERS = ["Requester Name", "Department", "Category", "Subject", "Description", "Priority",
  "Status", "Assigned IT Assistant", "Date Submitted", "Date Resolved"];
const MAX_ROWS = 500;

// Columns are found by their header name (any order, capital letters / spaces / punctuation ignored).
const norm = (t: string) => t.toLowerCase().replace(/[^a-z0-9]/g, "");
const ALIASES: string[][] = [
  ["requestername", "employeename", "requesteremployeename", "requester", "employee", "name"],
  ["department"],
  ["category", "issuecategory"],
  ["subject", "title"],
  ["description"],
  ["priority"],
  ["status", "ticketstatus"],
  ["assigneditassistant", "assignedto", "itassistant", "assignee", "technician"],
  ["datesubmitted", "originaldatesubmitted", "submitted", "datecreated"],
  ["dateresolved", "resolved", "resolveddate"],
];
const OPTIONAL = [9]; // Date Resolved may be left out entirely

// For each of the 10 fields, the position of its column in the file (-1 = not found).
function findColumns(header: string[]): number[] {
  const names = header.map(norm);
  return ALIASES.map((aliases) => names.findIndex((n) => aliases.includes(n)));
}

const STATUS_BY_TEXT: Record<string, Status> = {
  open: "OPEN", "in progress": "IN_PROGRESS", in_progress: "IN_PROGRESS", resolved: "RESOLVED",
};
const PRIORITY_BY_TEXT: Record<string, string> = {
  p1: "P1", critical: "P1", p2: "P2", high: "P2", p3: "P3", medium: "P3", p4: "P4", low: "P4",
};

type Payload = {
  requester_name: string; department: string; category: string; title: string; description: string;
  priority_level: string; status: Status; assigned_to_id: number; created_at: string; resolved_at: string | null;
};
type RowError = { row: number; message: string };

// Small CSV reader: quoted cells, commas / semicolons / tabs, line breaks inside quotes, Excel's BOM.
function parseCsv(text: string): string[][] {
  text = text.replace(/^﻿/, "");
  const firstLine = text.split(/\r?\n/, 1)[0] ?? "";
  const count = (c: string) => firstLine.split(c).length - 1;
  const delim = [",", ";", "\t"].sort((a, b) => count(b) - count(a))[0];
  const rows: string[][] = [];
  let row: string[] = [], cell = "", quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"') { if (text[i + 1] === '"') { cell += '"'; i++; } else quoted = false; }
      else cell += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === delim) { row.push(cell); cell = ""; }
    else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      row.push(cell); cell = "";
      rows.push(row); row = [];
    } else cell += ch;
  }
  if (cell !== "" || row.length) { row.push(cell); rows.push(row); }
  return rows.filter((r) => r.some((c) => c.trim() !== ""));
}

// "2026-10-05" or "2026-10-05 14:30" (also with "T"). Date only = 12:00 noon. Returns null if not valid.
function parseDate(text: string): Date | null {
  const m = text.trim().match(/^(\d{4})-(\d{1,2})-(\d{1,2})(?:[ T](\d{1,2}):(\d{2}))?$/);
  if (!m) return null;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const h = m[4] !== undefined ? Number(m[4]) : 12, mi = m[5] !== undefined ? Number(m[5]) : 0;
  const date = new Date(y, mo - 1, d, h, mi);
  const ok = date.getFullYear() === y && date.getMonth() === mo - 1 && date.getDate() === d && h < 24 && mi < 60;
  return ok ? date : null;
}

const pick = (list: string[], text: string) => list.find((x) => x.toLowerCase() === text.trim().toLowerCase());

function convert(rows: string[][], agents: User[], col: number[]): { items: Payload[]; errors: RowError[] } {
  const items: Payload[] = [], errors: RowError[] = [];
  const now = new Date();
  rows.forEach((cells, idx) => {
    const row = idx + 2; // row 1 is the header
    const c = (i: number) => (col[i] >= 0 ? cells[col[i]] ?? "" : "").trim();
    const problems: string[] = [];
    const department = pick(DEPARTMENTS, c(1));
    const category = pick(CATEGORIES, c(2));
    const priority = PRIORITY_BY_TEXT[c(5).toLowerCase().split(/\s*-\s*/)[0]];
    const status = STATUS_BY_TEXT[c(6).toLowerCase()];
    const agent = agents.find((a) => a.full_name.toLowerCase() === c(7).toLowerCase() || a.email.toLowerCase() === c(7).toLowerCase());
    const submitted = parseDate(c(8));
    const resolved = c(9) ? parseDate(c(9)) : null;
    if (!c(0)) problems.push("Requester Name is empty");
    if (!department) problems.push(`Department "${c(1)}" is not in the department list`);
    if (!category) problems.push(`Category "${c(2)}" is not in the category list`);
    if (!c(3)) problems.push("Subject is empty");
    if (!c(4)) problems.push("Description is empty");
    if (!priority) problems.push(`Priority "${c(5)}" must be P1, P2, P3 or P4`);
    if (!status) problems.push(`Status "${c(6)}" must be Open, In Progress or Resolved`);
    if (!agent) problems.push(`Assigned IT Assistant "${c(7)}" does not match an IT staff account`);
    if (!submitted) problems.push(`Date Submitted "${c(8)}" must look like 2026-10-05 or 2026-10-05 14:30`);
    else if (submitted > now) problems.push("Date Submitted is in the future");
    if (c(9) && !resolved) problems.push(`Date Resolved "${c(9)}" must look like 2026-10-06 or 2026-10-06 16:00`);
    if (resolved && submitted) {
      if (status && status !== "RESOLVED") problems.push("Date Resolved only applies to Resolved tickets");
      if (resolved < submitted) problems.push("Date Resolved is earlier than Date Submitted");
      if (resolved > now) problems.push("Date Resolved is in the future");
    }
    if (problems.length || !department || !category || !priority || !status || !agent || !submitted) {
      errors.push({ row, message: problems.join("; ") });
      return;
    }
    items.push({
      requester_name: c(0), department, category, title: c(3), description: c(4), priority_level: priority, status,
      assigned_to_id: agent.id, created_at: submitted.toISOString(), resolved_at: resolved ? resolved.toISOString() : null,
    });
  });
  return { items, errors };
}

const csvCell = (v: string) => (/[",\r\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);

// Window to import many historical tickets from a CSV file (Tickets page > "Import CSV").
export default function ManualTicketImportModal({ onClose, onCreated }: { onClose: () => void; onCreated: () => void }) {
  const [agents, setAgents] = useState<User[]>([]);
  const [fileName, setFileName] = useState("");
  const [items, setItems] = useState<Payload[]>([]);
  const [errors, setErrors] = useState<RowError[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [done, setDone] = useState<number | null>(null);

  useEffect(() => {
    api.get<User[]>("/users", { params: { staff: true } }).then((r) => setAgents(r.data)).catch(() => {});
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape" && !busy) onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [busy, onClose]);

  const downloadTemplate = () => {
    const example = ["Juan Dela Cruz", "Accounting", "Printer Connection Issue", "Printer offline",
      "Printer could not be reached from my PC.", "P3", "Resolved", agents[0]?.full_name ?? "IT Assistant Name", "2026-10-05 09:30", "2026-10-05 11:00"];
    const csv = [HEADERS, example].map((r) => r.map(csvCell).join(",")).join("\r\n") + "\r\n";
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob(["﻿" + csv], { type: "text/csv" }));
    a.download = "manual-tickets-template.csv";
    a.click();
    URL.revokeObjectURL(a.href);
  };

  const onFile = async (file: File | undefined) => {
    setError(""); setDone(null); setItems([]); setErrors([]); setFileName("");
    if (!file) return;
    setFileName(file.name);
    const all = parseCsv(await file.text());
    const col = findColumns(all[0] ?? []);
    const missing = HEADERS.filter((_, i) => col[i] < 0 && !OPTIONAL.includes(i));
    if (missing.length) return setError(`These columns were not found in the header row: ${missing.join(", ")}.`);
    const rows = all.slice(1); // drop the header row
    if (rows.length === 0) return setError("The file has no ticket rows below the header row.");
    if (rows.length > MAX_ROWS) return setError(`The file has ${rows.length} rows. Import at most ${MAX_ROWS} at a time.`);
    const result = convert(rows, agents, col);
    setItems(result.items);
    setErrors(result.errors);
  };

  const submit = async () => {
    setBusy(true); setError("");
    try {
      const { data } = await api.post<{ created: number }>("/tickets/manual/batch", { tickets: items });
      setDone(data.created); setItems([]); setFileName("");
      onCreated();
    } catch (err) {
      setError(errorMessage(err, "Could not import the tickets. Nothing was saved."));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/50 px-4 py-8"
         role="dialog" aria-modal="true" aria-labelledby="manual-import-title">
      <div className="card w-full max-w-2xl p-6 shadow-2xl">
        <h2 id="manual-import-title" className="text-lg font-semibold text-ink">Import Manual Tickets (CSV)</h2>
        <p className="mt-1 text-sm text-slate-600">
          Fill in one row per ticket in Excel or Google Sheets, save it as CSV, then choose the file. Every row is checked first;
          nothing is saved unless all rows are valid.
        </p>
        <ul className="mt-3 list-disc space-y-1 pl-5 text-xs text-slate-600">
          <li>Columns are matched by their header names, so they can be in any order.</li>
          <li>Departments, categories and IT assistant names must match the system exactly (capital letters don't matter).</li>
          <li>Priority: P1-P4. Status: Open, In Progress or Resolved.</li>
          <li>Dates: <span className="font-mono">2026-10-05</span> or <span className="font-mono">2026-10-05 14:30</span>. Date Resolved can be left empty.</li>
          <li>Up to {MAX_ROWS} tickets per file. Importing the same file twice is blocked.</li>
        </ul>

        <div className="mt-4 flex flex-wrap items-center gap-3">
          <button type="button" className="btn-ghost" onClick={downloadTemplate}>Download template</button>
          <input aria-label="Choose CSV file" type="file" accept=".csv,text/csv" className="text-sm"
                 disabled={busy || agents.length === 0} onChange={(e) => onFile(e.target.files?.[0])} />
        </div>

        {done !== null && (
          <p role="status" className="mt-4 rounded-md bg-emerald-50 px-3 py-2 text-sm text-emerald-800">
            {done} {done === 1 ? "ticket" : "tickets"} imported.
          </p>
        )}
        {error && <p role="alert" className="mt-4 rounded-md bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>}

        {fileName && !error && (items.length > 0 || errors.length > 0) && (
          <div className="mt-4 space-y-3 text-sm">
            <p className="font-medium text-slate-700">
              {fileName}: {items.length} ready, {errors.length} with problems
            </p>
            {errors.length > 0 && (
              <div role="alert" className="max-h-56 overflow-y-auto rounded-md border border-red-200 bg-red-50 px-3 py-2 text-red-700">
                <p className="mb-1 font-semibold">Fix these rows in your file, then choose it again:</p>
                <ul className="space-y-1">
                  {errors.slice(0, 50).map((e) => <li key={e.row}>Row {e.row}: {e.message}</li>)}
                  {errors.length > 50 && <li>...and {errors.length - 50} more rows.</li>}
                </ul>
              </div>
            )}
          </div>
        )}

        <div className="mt-5 flex flex-wrap justify-end gap-2">
          <button type="button" className="btn-ghost" disabled={busy} onClick={onClose}>{done !== null ? "Close" : "Cancel"}</button>
          <button type="button" className="btn-primary" disabled={busy || items.length === 0 || errors.length > 0} onClick={submit}>
            {busy ? "Importing..." : `Import ${items.length || ""} ${items.length === 1 ? "ticket" : "tickets"}`}
          </button>
        </div>
      </div>
    </div>
  );
}
