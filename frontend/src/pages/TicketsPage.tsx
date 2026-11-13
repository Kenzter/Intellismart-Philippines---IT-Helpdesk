import { useEffect, useRef, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import api, { errorMessage, hasStaffAccess, requesterName, type Status, type Ticket } from "../api/client";
import { useAuth } from "../App";
import { CATEGORIES, DEPARTMENTS } from "../constants";
import StatusBadge from "../components/StatusBadge";
import PriorityBadge from "../components/PriorityBadge";
import PriorityLegend from "../components/PriorityLegend";
import ManualTicketModal from "../components/ManualTicketModal";
import ManualTicketImportModal from "../components/ManualTicketImportModal";

type TabKey = "ALL" | Status | "INVALID";
const TABS: { key: TabKey; label: string }[] = [
  { key: "ALL", label: "All" },
  { key: "OPEN", label: "Open" },
  { key: "IN_PROGRESS", label: "In Progress" },
  { key: "RESOLVED", label: "Resolved" },
  { key: "INVALID", label: "Invalid" }, // flagged as a mistake: not counted anywhere else
];

const fmtDate = (iso: string) => new Date(iso).toLocaleDateString([], { dateStyle: "medium" });

// Month filter: a key like "2026-11" means tickets submitted in November 2026 (in the viewer's local time).
const monthKey = (iso: string) => {
  const d = new Date(iso);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
};

const monthLabel = (key: string) => {
  const [y, m] = key.split("-").map(Number);
  return new Date(y, m - 1, 1).toLocaleDateString([], { month: "long", year: "numeric" });
};

export default function TicketsPage() {
  const { user } = useAuth();
  const isStaff = hasStaffAccess(user);
  const canDelete = user?.role === "ADMIN"; // IT assistants cannot delete
  const canViewIp = user?.role === "ADMIN" || user?.role === "ASSISTANT";
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const requested = params.get("tab");
  const tab = TABS.some((t) => t.key === requested) ? (requested as TabKey) : "ALL";

  const [tickets, setTickets] = useState<Ticket[]>([]);
  const [search, setSearch] = useState("");
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState("");
  const [department, setDepartment] = useState("");
  const [month, setMonth] = useState(""); // "" = all months, otherwise "YYYY-MM"
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [addingManual, setAddingManual] = useState(false); // "+ Add Manual Ticket" window
  const [importingManual, setImportingManual] = useState(false); // "Import CSV" window (many manual tickets)

  useEffect(() => {
    const t = setTimeout(() => setQuery(search), 300);
    return () => clearTimeout(t);
  }, [search]);

  // Refresh by itself every 30 seconds while this tab is visible.
  const [tick, setTick] = useState(0);
  const silentRef = useRef(false);
  useEffect(() => {
    const id = setInterval(() => {
      if (document.visibilityState === "visible") { silentRef.current = true; setTick((t) => t + 1); }
    }, 20000);
    return () => clearInterval(id);
  }, []);

    // Refresh ticket list when new ticket data is detected.

  // Refresh silently when new ticket data is detected.
  useEffect(() => {
    const refreshTickets = () => {
      silentRef.current = true;
      setTick((t) => t + 1);
    };

    window.addEventListener("helpdesk:tickets-updated", refreshTickets);

    return () => {
      window.removeEventListener("helpdesk:tickets-updated", refreshTickets);
    };
  }, []);


  useEffect(() => {
    let cancelled = false;
    const silent = silentRef.current;
    silentRef.current = false;
    if (!silent) { setLoading(true); setError(""); }
    const p: Record<string, string> = {};
    if (query) p.q = query;
    if (category) p.category = category;
    if (department) p.department = department;
    api.get<Ticket[]>("/tickets", { params: p })
      .then((res) => { if (!cancelled) setTickets(res.data); })
      .catch((err) => { if (!cancelled && !silent) setError(errorMessage(err, "Could not load tickets.")); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [isStaff, query, category, department, tick]);

  // Admin-only: select Resolved tickets and delete them for good.
  const [selected, setSelected] = useState<number[]>([]);
  const [confirming, setConfirming] = useState(false);
  const [deleting, setDeleting] = useState(false);
  useEffect(() => { setSelected([]); setConfirming(false); }, [tab]);

  const [mine, setMine] = useState(false); // staff: show only tickets assigned to me
  const isMine = (t: Ticket) => t.assigned_to_id === user?.id || t.assigned_to_2_id === user?.id;
  const myActive = tickets.filter((t) => isMine(t) && (t.status === "OPEN" || t.status === "IN_PROGRESS") && !t.invalid_at).length;
    // Months that have tickets, newest first (the chosen month always stays in the list).
  const monthOptions = Array.from(new Set([...tickets.map((t) => monthKey(t.created_at)), ...(month ? [month] : [])])).sort().reverse();
  const inMonth = (t: Ticket) => !month || monthKey(t.created_at) === month;
  const base = (mine ? tickets.filter(isMine) : tickets).filter(inMonth);
  const live = base.filter((t) => !t.invalid_at);        // normal tabs never show Invalid tickets
  const invalidOnes = base.filter((t) => t.invalid_at);  // they live in their own tab
  const count = (k: TabKey) => (k === "ALL" ? live.length : k === "INVALID" ? invalidOnes.length : live.filter((t) => t.status === k).length);
  const shown = tab === "ALL" ? live : tab === "INVALID" ? invalidOnes : live.filter((t) => t.status === tab);
  const canSelect = canDelete && (tab === "RESOLVED" || tab === "INVALID");
  const selectedShown = selected.filter((id) => shown.some((t) => t.id === id));
  const allSelected = shown.length > 0 && selectedShown.length === shown.length;
  const toggle = (id: number) => setSelected((s) => (s.includes(id) ? s.filter((x) => x !== id) : [...s, id]));
  const deleteSelected = async () => {
    setDeleting(true);
    setError("");
    try {
      await api.post("/tickets/bulk-delete", { ids: selectedShown });
      setSelected([]);
      setConfirming(false);
      setTick((t) => t + 1);
    } catch (err) {
      setError(errorMessage(err, "Could not delete the tickets."));
    } finally {
      setDeleting(false);
    }
  };
  const hasFilters = Boolean(query || category || department || month);
  const clear = () => { setSearch(""); setQuery(""); setCategory(""); setDepartment(""); setMonth(""); };
  const cols = ["ID", "Title", "Priority", "Category", "Department", "Status", "Employee", "Assigned to", "Submitted", ...(canViewIp ? ["IP Address"] : [])];

  const colCount = cols.length + (canSelect ? 1 : 0);

  return (
    <div>
      <div className="mb-6 flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-2xl font-bold text-brand">Tickets</h1>
        <div className="flex flex-wrap items-center gap-3">
          {isStaff && (
            <button aria-pressed={mine} onClick={() => setMine((m) => !m)}
                    className={`btn border ${mine ? "border-accent-bright bg-accent-soft text-accent-dark" : "border-brand/25 bg-white/60 text-brand-dark hover:bg-white"}`}>
              Assigned to me
              <span className={`ml-2 rounded-full px-2 py-0.5 text-xs font-bold ${myActive > 0 ? "bg-accent-bright text-white" : "bg-slate-100 text-slate-600"}`}>{myActive}</span>
            </button>
          )}
          {isStaff && (
            <>
              <button type="button" className="btn-primary" onClick={() => setAddingManual(true)}>+ Add Manual Ticket</button>
              <button type="button" className="btn-primary" onClick={() => setImportingManual(true)}>Import CSV</button>
            </>
          )}
          <PriorityLegend />
        </div>
      </div>
      {importingManual && (
        <ManualTicketImportModal onClose={() => setImportingManual(false)}
                                 onCreated={() => { silentRef.current = true; setTick((t) => t + 1); }} />
      )}
      {addingManual && (
        <ManualTicketModal onClose={() => setAddingManual(false)}
                           onCreated={() => { silentRef.current = true; setTick((t) => t + 1); }} />
      )}

      <div role="tablist" aria-label="Ticket status" className="mb-4 flex flex-wrap gap-1 border-b border-slate-200">
        {TABS.map((t) => (
          <button key={t.key} role="tab" aria-selected={tab === t.key}
                  onClick={() => setParams(t.key === "ALL" ? {} : { tab: t.key })}
                  className={`-mb-px border-b-2 px-4 py-2 text-sm font-semibold ${tab === t.key ? "border-accent-bright text-accent" : "border-transparent text-slate-600 hover:text-brand"}`}>
            {t.label} <span className="ml-1 rounded-full bg-slate-100 px-2 py-0.5 text-xs text-slate-700">{count(t.key)}</span>
          </button>
        ))}
      </div>

      <div className={`mb-4 grid gap-3 ${isStaff ? "sm:grid-cols-2 lg:grid-cols-4" : "sm:grid-cols-2"}`}>
        <input aria-label="Search tickets" placeholder="Search by ID, title or description" className="input"
               value={search} onChange={(e) => setSearch(e.target.value)} />
        <select aria-label="Filter by category" className="input" value={category} onChange={(e) => setCategory(e.target.value)}>
          <option value="">All categories</option>
          {CATEGORIES.map((c) => <option key={c}>{c}</option>)}
        </select>
        {isStaff && (
          <select aria-label="Filter by department" className="input" value={department} onChange={(e) => setDepartment(e.target.value)}>
            <option value="">All departments</option>
            {DEPARTMENTS.map((d) => <option key={d}>{d}</option>)}
          </select>
        )}
        
        <select aria-label="Filter by month and year" className="input" value={month} onChange={(e) => setMonth(e.target.value)}>
         <option value="">All months</option>
         {monthOptions.map((k) => <option key={k} value={k}>{monthLabel(k)}</option>)}
        </select>

      </div>

      {error && <p role="alert" className="mb-4 rounded-md bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>}

      {canSelect && selectedShown.length > 0 && (
        <div role="alert" className="mb-4 flex flex-wrap items-center justify-between gap-3 rounded-md border border-red-200 bg-red-50 px-4 py-3 text-sm">
          {confirming ? (
            <>
              <span className="font-medium text-red-800">
                Permanently delete {selectedShown.length} {selectedShown.length === 1 ? "ticket" : "tickets"} and their comments? This cannot be undone.
              </span>
              <span className="flex gap-2">
                <button className="btn bg-red-700 text-white hover:bg-red-800" disabled={deleting} onClick={deleteSelected}>
                  {deleting ? "Deleting..." : "Yes, delete"}
                </button>
                <button className="btn-ghost" disabled={deleting} onClick={() => setConfirming(false)}>Cancel</button>
              </span>
            </>
          ) : (
            <>
              <span className="font-medium text-red-800">{selectedShown.length} selected</span>
              <button className="btn bg-red-700 text-white hover:bg-red-800" onClick={() => setConfirming(true)}>
                Delete selected
              </button>
            </>
          )}
        </div>
      )}

      <div className="table-wrap">
        <table className="min-w-full divide-y divide-slate-200 text-sm">
          <thead className="table-head">
            <tr>
              {canSelect && (
                <th scope="col" className="w-10 px-4 py-3">
                  <input type="checkbox" aria-label="Select all resolved tickets" checked={allSelected}
                         onChange={() => setSelected(allSelected ? [] : shown.map((t) => t.id))} />
                </th>
              )}
              {cols.map((h) => <th key={h} scope="col" className="px-4 py-3">{h}</th>)}
              
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {loading && <tr><td colSpan={colCount} className="px-4 py-10 text-center text-slate-500">Loading tickets...</td></tr>}
            {!loading && shown.length === 0 && (
              <tr>
                <td colSpan={colCount} className="px-4 py-10 text-center text-slate-500">
                  {mine ? (
                    <>No tickets assigned to you here. <button className="font-semibold text-brand underline" onClick={() => setMine(false)}>Show all tickets</button></>
                  ) : hasFilters ? (
                    <>No tickets match these filters. <button className="font-semibold text-brand underline" onClick={clear}>Clear filters</button></>
                  ) : tab !== "ALL" ? (
                    <>No {TABS.find((t) => t.key === tab)?.label.toLowerCase()} tickets.</>
                  ) : (
                    <>No tickets have been submitted yet.</>
                  )}
                </td>
              </tr>
            )}
            {!loading && shown.map((t) => (
              <tr key={t.id} className="cursor-pointer hover:bg-accent-bright/25" onClick={() => navigate(`/tickets/${t.id}`)}>
                {canSelect && (
                  <td className="px-4 py-3" onClick={(e) => e.stopPropagation()}>
                    <input type="checkbox" aria-label={`Select ticket ${t.id}`} checked={selected.includes(t.id)} onChange={() => toggle(t.id)} />
                  </td>
                )}
                <td className="px-4 py-3 font-medium text-slate-500">#{t.id}</td>
                <td className="max-w-xs px-4 py-3">
                  <Link to={`/tickets/${t.id}`} className="font-semibold text-brand hover:underline" onClick={(e) => e.stopPropagation()}>{t.title}</Link>
                  {t.invalid_at && (
                    <>
                      <span className="ml-2 rounded-full bg-red-100 px-2 py-0.5 text-xs font-semibold text-red-800">Invalid</span>
                      {t.invalid_reason && <div className="mt-1 text-xs text-slate-500">{t.invalid_reason}</div>}
                    </>
                  )}
                </td>
                <td className="px-4 py-3"><PriorityBadge level={t.priority_level} /></td>
                <td className="px-4 py-3">{t.category}</td>
                <td className="px-4 py-3">{t.department ?? <span className="text-slate-400">-</span>}</td>
                <td className="px-4 py-3"><StatusBadge status={t.status} /></td>
                <td className="px-4 py-3">{requesterName(t)}</td>
                <td className="px-4 py-3">
                  {t.assigned_to ? (
                    <>
                      {[t.assigned_to, t.assigned_to_2].filter((u) => u).map((u) => (
                        <div key={u!.id}>
                          {u!.full_name}
                          {u!.id === user?.id && (
                            <span className="ml-2 rounded-full bg-accent-soft px-2 py-0.5 text-xs font-semibold text-accent-dark">You</span>
                          )}
                        </div>
                      ))}
                    </>
                  ) : <span className="text-slate-400">Unassigned</span>}
                </td>
                <td className="whitespace-nowrap px-4 py-3 text-slate-600">{fmtDate(t.created_at)}</td>
                {canViewIp && (
                  <td className="whitespace-nowrap px-4 py-3 font-mono text-xs text-slate-600" onClick={(e) => e.stopPropagation()}>
                    {t.ip_address ?? <span className="font-sans text-slate-400">-</span>}
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
