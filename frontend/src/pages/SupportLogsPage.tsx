import { useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import api, { errorMessage, requesterName, type Ticket, type User } from "../api/client";
import { useAuth } from "../App";
import { CATEGORIES, DEPARTMENTS } from "../constants";
import StatusBadge from "../components/StatusBadge";
import PriorityBadge from "../components/PriorityBadge";
import { Stat } from "./DashboardPage";

type Period = "day" | "week" | "month";
const PERIODS: { key: Period; label: string }[] = [
  { key: "day", label: "Daily" },
  { key: "week", label: "Weekly" },
  { key: "month", label: "Monthly" },
];
const PAGE_SIZE = 10;

const fmtDate = (iso: string) => new Date(iso).toLocaleDateString([], { dateStyle: "medium" });
const pad = (n: number) => String(n).padStart(2, "0");
const dayValue = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const monthValue = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}`;

// Start (inclusive) and end (exclusive) of the day, week (Monday to Sunday) or month that contains `a`, in local time.
const rangeOf = (p: Period, a: Date): [Date, Date] => {
  const y = a.getFullYear(), m = a.getMonth(), d = a.getDate();
  if (p === "day") return [new Date(y, m, d), new Date(y, m, d + 1)];
  if (p === "week") {
    const back = (a.getDay() + 6) % 7;
    return [new Date(y, m, d - back), new Date(y, m, d - back + 7)];
  }
  return [new Date(y, m, 1), new Date(y, m + 1, 1)];
};
const shift = (p: Period, a: Date, dir: number) => {
  const y = a.getFullYear(), m = a.getMonth(), d = a.getDate();
  if (p === "day") return new Date(y, m, d + dir);
  if (p === "week") return new Date(y, m, d + 7 * dir);
  return new Date(y, m + dir, 1);
};
const periodLabel = (p: Period, a: Date) => {
  const [s, e] = rangeOf(p, a);
  if (p === "day") return s.toLocaleDateString([], { dateStyle: "long" });
  if (p === "month") return s.toLocaleDateString([], { month: "long", year: "numeric" });
  const last = new Date(e.getFullYear(), e.getMonth(), e.getDate() - 1);
  return `${s.toLocaleDateString([], { month: "short", day: "numeric" })} - ${last.toLocaleDateString([], { month: "short", day: "numeric", year: "numeric" })}`;
};
const inPeriod = (t: Ticket, p: Period, a: Date) => {
  const [s, e] = rangeOf(p, a);
  const at = new Date(t.created_at);
  return at >= s && at < e;
};
const countBy = (rows: Ticket[]) => ({
  total: rows.length,
  open: rows.filter((t) => t.status === "OPEN").length,
  in_progress: rows.filter((t) => t.status === "IN_PROGRESS").length,
  resolved: rows.filter((t) => t.status === "RESOLVED").length,
});

/** One person's Support Logs dashboard (also used for the admin's overall view). */
function LogsDashboard({ tickets, personId }: { tickets: Ticket[]; personId: number | null }) {
  const navigate = useNavigate();
  const [period, setPeriod] = useState<Period>("day");
  const [anchor, setAnchor] = useState(() => new Date());
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState("");
  const [category, setCategory] = useState("");
  const [department, setDepartment] = useState("");
  const [visible, setVisible] = useState(PAGE_SIZE);

  const rows = tickets.filter((t) => inPeriod(t, period, anchor));
  const s = countBy(rows);
  const q = search.trim().toLowerCase();
  const filtered = rows.filter((t) =>
    (!status || t.status === status) && (!category || t.category === category) && (!department || t.department === department) &&
    (!q || String(t.id) === q || t.title.toLowerCase().includes(q) || t.description.toLowerCase().includes(q) || requesterName(t).toLowerCase().includes(q)));
  const shown = filtered.slice(0, visible);
  const hasFilters = Boolean(search || status || category || department);
  const clear = () => { setSearch(""); setStatus(""); setCategory(""); setDepartment(""); setVisible(PAGE_SIZE); };
  const reset = () => setVisible(PAGE_SIZE);
  const showTechs = personId === null;
  const cols = ["ID", "Title", "Priority", "Category", "Department", "Status", "Employee", showTechs ? "Assigned to" : "My role", "Submitted"];

  const roleIn = (t: Ticket) => (t.assigned_to_id === personId ? "Primary technician" : "Second technician");

  return (
    <div className="space-y-12">
      {/* Daily / Weekly / Monthly summaries (click one to list its tickets below) */}
      <div role="tablist" aria-label="Support summary period" className="grid gap-5 sm:grid-cols-3">
        {PERIODS.map((p) => {
          const c = countBy(tickets.filter((t) => inPeriod(t, p.key, anchor)));
          const on = period === p.key;
          return (
            <button key={p.key} role="tab" aria-selected={on} onClick={() => { setPeriod(p.key); reset(); }}
                    className={`card text-left transition ${on ? "ring-2 ring-accent-bright" : "hover:brightness-105"}`}>
              <p className="text-sm font-semibold text-brand">{p.label} Summary</p>
              <p className="text-xs text-slate-600">{periodLabel(p.key, anchor)}</p>
              <p className="mt-2 text-3xl font-extrabold text-ink">{c.total}
                <span className="ml-2 text-sm font-medium text-slate-600">{c.total === 1 ? "ticket" : "tickets"}</span></p>
              <p className="text-xs text-slate-600">{c.resolved} resolved - {c.open + c.in_progress} still active</p>
            </button>
          );
        })}
      </div>

      <section className="space-y-5 border-t border-brand/15 pt-10">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <h2 className="text-xl font-semibold">{PERIODS.find((p) => p.key === period)!.label} - {periodLabel(period, anchor)}</h2>
        <div className="flex flex-wrap items-end gap-2">
          <button className="btn-ghost" aria-label={`Previous ${period}`} onClick={() => { setAnchor(shift(period, anchor, -1)); reset(); }}>Previous</button>
          <div>
            <label htmlFor="log-date" className="sr-only">Choose a {period}</label>
            {period === "month" ? (
              <input id="log-date" type="month" className="input" value={monthValue(anchor)}
                     onChange={(e) => { if (e.target.value) { const [y, m] = e.target.value.split("-").map(Number); setAnchor(new Date(y, m - 1, 1)); reset(); } }} />
            ) : (
              <input id="log-date" type="date" className="input" value={dayValue(anchor)}
                     onChange={(e) => { if (e.target.value) { const [y, m, d] = e.target.value.split("-").map(Number); setAnchor(new Date(y, m - 1, d)); reset(); } }} />
            )}
          </div>
          <button className="btn-ghost" aria-label={`Next ${period}`} onClick={() => { setAnchor(shift(period, anchor, 1)); reset(); }}>Next</button>
          <button className="btn-ghost" onClick={() => { setAnchor(new Date()); reset(); }}>Today</button>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
        <Stat label="Total tickets" value={s.total} tone="from-brand to-[#2f6bc9] text-white shadow-brand/30" />
        <Stat label="Open" value={s.open} tone="from-sky-200 to-blue-400 text-blue-900 shadow-blue-300/40" />
        <Stat label="In Progress" value={s.in_progress} tone="from-accent to-accent-dark text-white shadow-accent/30" />
        <Stat label="Resolved" value={s.resolved} tone="from-emerald-100 to-emerald-400 text-emerald-900 shadow-emerald-300/40" />
      </div>
      </section>

      <section className="space-y-5">
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <input aria-label="Search support logs" placeholder="Search by ID, title or description" className="input"
               value={search} onChange={(e) => { setSearch(e.target.value); reset(); }} />
        <select aria-label="Filter by status" className="input" value={status} onChange={(e) => { setStatus(e.target.value); reset(); }}>
          <option value="">All statuses</option>
          <option value="OPEN">Open</option>
          <option value="IN_PROGRESS">In Progress</option>
          <option value="RESOLVED">Resolved</option>
        </select>
        <select aria-label="Filter by category" className="input" value={category} onChange={(e) => { setCategory(e.target.value); reset(); }}>
          <option value="">All categories</option>
          {CATEGORIES.map((c) => <option key={c}>{c}</option>)}
        </select>
        <select aria-label="Filter by department" className="input" value={department} onChange={(e) => { setDepartment(e.target.value); reset(); }}>
          <option value="">All departments</option>
          {DEPARTMENTS.map((d) => <option key={d}>{d}</option>)}
        </select>
      </div>

      <div className="table-wrap">
        <table className="min-w-full divide-y divide-slate-200 text-sm">
          <thead className="table-head">
            <tr>{cols.map((h) => <th key={h} scope="col" className="px-4 py-3">{h}</th>)}</tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {shown.length === 0 && (
              <tr>
                <td colSpan={cols.length} className="px-4 py-10 text-center text-slate-500">
                  {hasFilters ? (
                    <>No tickets match these filters. <button className="font-semibold text-brand underline" onClick={clear}>Clear filters</button></>
                  ) : (
                    <>No support tickets for this {period}.</>
                  )}
                </td>
              </tr>
            )}
            {shown.map((t) => (
              <tr key={t.id} className={t.deleted_at ? "" : "cursor-pointer hover:bg-accent-bright/25"}
                  onClick={t.deleted_at ? undefined : () => navigate(`/tickets/${t.id}`, { state: { from: "/support-logs" } })}>
                <td className="px-4 py-3 font-medium text-slate-500">#{t.id}</td>
                <td className="max-w-xs px-4 py-3">
                  {t.deleted_at ? (
                    // Deleted tickets still count in the logs but can no longer be opened.
                    <>
                      <span className="font-semibold text-slate-600">{t.title}</span>
                      <span className="ml-2 rounded-full bg-red-100 px-2 py-0.5 text-xs font-semibold text-red-800">Deleted</span>
                    </>
                  ) : (
                    <Link to={`/tickets/${t.id}`} state={{ from: "/support-logs" }} className="font-semibold text-brand hover:underline"
                          onClick={(e) => e.stopPropagation()}>{t.title}</Link>
                  )}
                </td>
                <td className="px-4 py-3"><PriorityBadge level={t.priority_level} /></td>
                <td className="px-4 py-3">{t.category}</td>
                <td className="px-4 py-3">{t.department ?? <span className="text-slate-400">-</span>}</td>
                <td className="px-4 py-3"><StatusBadge status={t.status} /></td>
                <td className="px-4 py-3">{requesterName(t)}</td>
                <td className="px-4 py-3">
                  {showTechs
                    ? [t.assigned_to, t.assigned_to_2].filter(Boolean).map((u) => <div key={u!.id}>{u!.full_name}</div>)
                    : roleIn(t)}
                </td>
                <td className="whitespace-nowrap px-4 py-3 text-slate-600">{fmtDate(t.created_at)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {filtered.length > 0 && (
        <div className="flex flex-wrap items-center justify-between gap-3 text-sm text-slate-600">
          <span>Showing {shown.length} of {filtered.length} {filtered.length === 1 ? "ticket" : "tickets"}</span>
          {filtered.length > shown.length && (
            <button className="btn-ghost" onClick={() => setVisible((v) => v + PAGE_SIZE)}>Show more</button>
          )}
        </div>
      )}
      </section>
    </div>
  );
}

export default function SupportLogsPage() {
  const { user } = useAuth();
  const isAdmin = user?.role === "ADMIN";
  // Admin: "all" = overall logs, otherwise the id of the IT staff member being viewed (an assistant, or the admin).
  const [view, setView] = useState<"all" | number>(isAdmin ? "all" : user!.id);
  const [tickets, setTickets] = useState<Ticket[]>([]);       // tickets for the current view
  const [overall, setOverall] = useState<Ticket[]>([]);       // admin: every assigned ticket (feeds the staff list)
  const [staff, setStaff] = useState<User[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [tick, setTick] = useState(0);

  // Refresh by itself every 30 seconds, and when ticket data changes elsewhere.
  useEffect(() => {
    const refresh = () => setTick((t) => t + 1);
    const id = setInterval(() => { if (document.visibilityState === "visible") refresh(); }, 20000);
    window.addEventListener("helpdesk:tickets-updated", refresh);
    return () => { clearInterval(id); window.removeEventListener("helpdesk:tickets-updated", refresh); };
  }, []);

  useEffect(() => {
    if (isAdmin) api.get<User[]>("/users", { params: { role: "ASSISTANT" } }).then((r) => setStaff(r.data)).catch(() => {});
  }, [isAdmin]);

  useEffect(() => {
    let cancelled = false;
    const params = view === "all" ? {} : { user_id: view };
    const requests: Promise<unknown>[] = [
      api.get<Ticket[]>("/support-logs", { params }).then((r) => { if (!cancelled) setTickets(r.data); }),
    ];
    if (isAdmin) requests.push(api.get<Ticket[]>("/support-logs").then((r) => { if (!cancelled) setOverall(r.data); }));
    Promise.all(requests)
      .then(() => { if (!cancelled) setError(""); })
      .catch((err) => { if (!cancelled) setError(errorMessage(err, "Could not load the support logs.")); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [view, isAdmin, tick]);

  const choose = (v: "all" | number) => { setLoading(true); setView(v); window.scrollTo({ top: 0, behavior: "smooth" }); };
  const handledBy = (id: number) => overall.filter((t) => t.assigned_to_id === id || t.assigned_to_2_id === id);
  const viewedName = view === "all" ? "" : view === user?.id ? "My Support Logs"
    : `${staff.find((p) => p.id === view)?.full_name ?? "IT Assistant"}'s Support Logs`;

  return (
    <div>
      <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-2xl font-bold text-brand">Support Logs</h1>
        {isAdmin && (
          <div className="flex flex-wrap gap-2">
            {([["all", "Overall logs"], [user!.id, "My support logs"]] as const).map(([v, label]) => (
              <button key={label} aria-pressed={view === v} onClick={() => choose(v)}
                      className={`btn border ${view === v ? "border-accent-bright bg-accent-soft text-accent-dark" : "border-brand/25 bg-white/60 text-brand-dark hover:bg-white"}`}>
                {label}
              </button>
            ))}
          </div>
        )}
      </div>
      <p className="mb-8 text-sm text-slate-600">
        {view === "all"
          ? "Support activity of all IT staff. Tickets are grouped by the date they were submitted."
          : "Every ticket assigned to " + (view === user?.id ? "you" : "this IT assistant") + ", in every status. Tickets are grouped by the date they were submitted."}
      </p>

      {error && <p role="alert" className="mb-4 rounded-md bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>}

      {isAdmin && view !== "all" && view !== user?.id && (
        <div className="mb-8 flex flex-wrap items-center justify-between gap-3">
          <h2 className="text-xl font-semibold">{viewedName}</h2>
          <button className="btn-ghost" onClick={() => choose("all")}>Back to overall logs</button>
        </div>
      )}

      {loading ? (
        <p className="text-slate-500">Loading support logs...</p>
      ) : (
        <LogsDashboard key={String(view)} tickets={tickets} personId={view === "all" ? null : view} />
      )}

      {isAdmin && (
        <section className="mt-16 border-t border-brand/15 pt-10" aria-labelledby="assistants-list">
          <h2 id="assistants-list" className="mb-1 text-xl font-semibold">IT Assistants</h2>
          <p className="mb-5 text-sm text-slate-600">Select an IT Assistant to view their individual Support Logs.</p>
          <div className="table-wrap">
            <table className="min-w-full divide-y divide-slate-200 text-sm">
              <thead className="table-head">
                <tr>
                  {["Name", "Department", "Total", "Open", "In Progress", "Resolved", "Action"].map((h) => (
                    <th key={h} scope="col" className="px-4 py-3">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {staff.length === 0 && (
                  <tr><td colSpan={7} className="px-4 py-10 text-center text-slate-500">No IT assistants yet.</td></tr>
                )}
                {staff.map((p) => {
                  const c = countBy(handledBy(p.id));
                  return (
                    <tr key={p.id} className={`cursor-pointer hover:bg-accent-bright/25 ${view === p.id ? "bg-accent-soft" : ""}`} onClick={() => choose(p.id)}>
                      <td className="px-4 py-3 font-semibold text-brand">{p.full_name}</td>
                      <td className="px-4 py-3">{p.department ?? <span className="text-slate-400">-</span>}</td>
                      <td className="px-4 py-3 font-medium">{c.total}</td>
                      <td className="px-4 py-3">{c.open}</td>
                      <td className="px-4 py-3">{c.in_progress}</td>
                      <td className="px-4 py-3">{c.resolved}</td>
                      <td className="px-4 py-3">
                        <button className="font-semibold text-brand underline" onClick={(e) => { e.stopPropagation(); choose(p.id); }}>View Logs</button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </section>
      )}
    </div>
  );
}
