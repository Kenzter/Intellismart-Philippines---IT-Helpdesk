import { useEffect, useState, type FormEvent } from "react";
import api, { errorMessage, type Status, type Ticket, type User } from "../api/client";
import { CATEGORIES, DEPARTMENTS } from "../constants";
import { PRIORITIES } from "./PriorityBadge";
import { statusLabels } from "./StatusBadge";

const pad = (n: number) => String(n).padStart(2, "0");
// Value for <input type="datetime-local"> in the browser's local time.
const localValue = (d: Date) =>
  `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;

const STATUSES: Status[] = ["OPEN", "IN_PROGRESS", "RESOLVED"];

const emptyForm = {
  requester_name: "", department: "", category: "", title: "", description: "",
  priority_level: "", status: "RESOLVED" as Status, created_at: "", resolved_at: "",
};

// Window for IT staff to encode ONE historical ticket at a time (Tickets page > "+ Add Manual Ticket").
export default function ManualTicketModal({ onClose, onCreated }: { onClose: () => void; onCreated: () => void }) {
  const [form, setForm] = useState(emptyForm);
  const [assignee, setAssignee] = useState(""); // kept between tickets: the same person often encodes a batch
  const [assignee2, setAssignee2] = useState(""); // optional second technician
  const [agents, setAgents] = useState<User[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [saved, setSaved] = useState<Ticket | null>(null);
  const set = (k: keyof typeof emptyForm) => (e: { target: { value: string } }) => setForm((f) => ({ ...f, [k]: e.target.value }));

  useEffect(() => {
    api.get<User[]>("/users", { params: { staff: true } }).then((r) => setAgents(r.data)).catch(() => {});
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape" && !busy) onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [busy, onClose]);

  const finished = form.status === "RESOLVED";
  const nowValue = localValue(new Date());

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError("");
    setSaved(null);
    if (!form.created_at) return setError("Please enter the Original Date Submitted.");
    if (new Date(form.created_at) > new Date()) return setError("Original Date Submitted cannot be in the future.");
    if (finished && form.resolved_at) {
      if (new Date(form.resolved_at) < new Date(form.created_at)) return setError("Date Resolved cannot be earlier than the Original Date Submitted.");
      if (new Date(form.resolved_at) > new Date()) return setError("Date Resolved cannot be in the future.");
    }
    setBusy(true);
    try {
      const { data } = await api.post<Ticket>("/tickets/manual", {
        requester_name: form.requester_name.trim(),
        department: form.department,
        category: form.category,
        title: form.title.trim(),
        description: form.description.trim(),
        priority_level: form.priority_level,
        status: form.status,
        assigned_to_id: Number(assignee),
        assigned_to_2_id: assignee2 && assignee2 !== assignee ? Number(assignee2) : null,
        created_at: new Date(form.created_at).toISOString(),
        resolved_at: finished && form.resolved_at ? new Date(form.resolved_at).toISOString() : null,
      });
      setSaved(data);
      setForm(emptyForm);
      onCreated();
    } catch (err) {
      setError(errorMessage(err, "Could not save the ticket."));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/50 px-4 py-8"
         role="dialog" aria-modal="true" aria-labelledby="manual-ticket-title">
      <div className="card w-full max-w-2xl p-6 shadow-2xl">
        <h2 id="manual-ticket-title" className="text-lg font-semibold text-ink">Add Manual Ticket</h2>
        <p className="mt-1 text-sm text-slate-600">Encode one past ticket. It is counted on its original date in the Dashboard and Support Logs.</p>

        {saved && (
          <p role="status" className="mt-4 rounded-md bg-emerald-50 px-3 py-2 text-sm text-emerald-800">
            Ticket #{saved.id} saved. You can encode another one below.
          </p>
        )}
        {error && <p role="alert" className="mt-4 rounded-md bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>}

        <form onSubmit={submit} className="mt-4 grid gap-4 sm:grid-cols-2">
          <div>
            <label htmlFor="mt-name" className="label">Requester / Employee Name</label>
            <input id="mt-name" className="input" maxLength={255} required value={form.requester_name} onChange={set("requester_name")} />
          </div>
          <div>
            <label htmlFor="mt-dept" className="label">Department</label>
            <select id="mt-dept" className="input" required value={form.department} onChange={set("department")}>
              <option value="">Select department</option>
              {DEPARTMENTS.map((d) => <option key={d} value={d}>{d}</option>)}
            </select>
          </div>
          <div>
            <label htmlFor="mt-cat" className="label">Issue Category</label>
            <select id="mt-cat" className="input" required value={form.category} onChange={set("category")}>
              <option value="">Select category</option>
              {CATEGORIES.map((c) => <option key={c} value={c}>{c}</option>)}
            </select>
          </div>
          <div>
            <label htmlFor="mt-title" className="label">Subject</label>
            <input id="mt-title" className="input" maxLength={255} required value={form.title} onChange={set("title")} />
          </div>
          <div className="sm:col-span-2">
            <label htmlFor="mt-desc" className="label">Description</label>
            <textarea id="mt-desc" className="input" rows={4} maxLength={5000} required value={form.description} onChange={set("description")} />
          </div>
          <div>
            <label htmlFor="mt-priority" className="label">Priority</label>
            <select id="mt-priority" className="input" required value={form.priority_level} onChange={set("priority_level")}>
              <option value="">Select priority</option>
              {PRIORITIES.map((p) => <option key={p.key} value={p.key}>{p.key} - {p.label}</option>)}
            </select>
          </div>
          <div>
            <label htmlFor="mt-status" className="label">Ticket Status</label>
            <select id="mt-status" className="input" required value={form.status} onChange={set("status")}>
              {STATUSES.map((s) => <option key={s} value={s}>{statusLabels[s]}</option>)}
            </select>
          </div>
          <div>
            <label htmlFor="mt-tech" className="label">Assigned IT Assistant</label>
            <select id="mt-tech" className="input" required value={assignee} onChange={(e) => setAssignee(e.target.value)}>
              <option value="">Select IT assistant</option>
              {agents.map((a) => <option key={a.id} value={a.id}>{a.full_name}</option>)}
            </select>
          </div>

          <div>
            <label htmlFor="mt-tech2" className="label">Second Technician (optional)</label>
            <select id="mt-tech2" className="input" disabled={!assignee} value={assignee2 !== assignee ? assignee2 : ""}
                    onChange={(e) => setAssignee2(e.target.value)}>
              <option value="">None</option>
              {agents.filter((a) => String(a.id) !== assignee).map((a) => <option key={a.id} value={a.id}>{a.full_name}</option>)}
            </select>
          </div>

          <div>
            <label htmlFor="mt-submitted" className="label">Original Date Submitted</label>
            <input id="mt-submitted" type="datetime-local" className="input" required max={nowValue}
                   value={form.created_at} onChange={set("created_at")} />
          </div>
          <div>
            <label htmlFor="mt-resolved" className="label">Date Resolved (if applicable)</label>
            <input id="mt-resolved" type="datetime-local" className="input" disabled={!finished}
                   min={form.created_at || undefined} max={nowValue}
                   value={finished ? form.resolved_at : ""} onChange={set("resolved_at")} />
          </div>
          <div className="flex flex-wrap items-end justify-end gap-2 sm:col-span-2">
            <button type="button" className="btn-ghost" disabled={busy} onClick={onClose}>{saved ? "Close" : "Cancel"}</button>
            <button type="submit" className="btn-primary" disabled={busy}>{busy ? "Saving..." : "Save Ticket"}</button>
          </div>
        </form>
      </div>
    </div>
  );
}
