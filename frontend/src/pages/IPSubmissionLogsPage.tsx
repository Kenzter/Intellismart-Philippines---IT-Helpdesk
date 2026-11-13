import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { errorMessage, fetchIPSubmissionLogs, type IPSubmissionLog } from "../api/client";

const fmt = (iso: string) => new Date(iso).toLocaleString([], { dateStyle: "medium", timeStyle: "short" });

export default function IPSubmissionLogsPage() {
  const [logs, setLogs] = useState<IPSubmissionLog[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [search, setSearch] = useState("");

  useEffect(() => {
    let cancelled = false;
    fetchIPSubmissionLogs()
      .then((data) => { if (!cancelled) setLogs(data); })
      .catch((err) => { if (!cancelled) setError(errorMessage(err, "Could not load IP submission logs.")); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, []);

  const shown = logs.filter((log) =>
    log.ip_address.toLowerCase().includes(search.toLowerCase()) ||
    String(log.ticket_id).includes(search.trim())
  );
  const cols = ["Ticket ID", "IP Address", "Date Submitted", "Browser / Device"];

  return (
    <div>
      <div className="mb-6 flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-2xl font-bold text-brand">IP Submission Logs</h1>
      </div>

      <div className="mb-4">
        <input aria-label="Search IP logs" placeholder="Search by IP address or ticket ID" className="input"
               value={search} onChange={(e) => setSearch(e.target.value)} />
      </div>

      {error && <p role="alert" className="mb-4 rounded-md bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>}

      <div className="table-wrap">
        <table className="min-w-full divide-y divide-slate-200 text-sm">
          <thead className="table-head">
            <tr>{cols.map((h) => <th key={h} scope="col" className="px-4 py-3">{h}</th>)}</tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {loading && <tr><td colSpan={cols.length} className="px-4 py-10 text-center text-slate-500">Loading IP submission logs...</td></tr>}
            {!loading && shown.length === 0 && (
              <tr><td colSpan={cols.length} className="px-4 py-10 text-center text-slate-500">
                {search ? "No IP logs match your search." : "No public ticket submissions have been logged yet."}
              </td></tr>
            )}
            {!loading && shown.map((log) => (
              <tr key={log.id} className="hover:bg-accent-bright/25">
                <td className="px-4 py-3 font-medium text-slate-500">
                  <Link to={`/tickets/${log.ticket_id}`} className="text-brand hover:underline">#{log.ticket_id}</Link>
                </td>
                <td className="whitespace-nowrap px-4 py-3 font-mono text-xs">{log.ip_address}</td>
                <td className="whitespace-nowrap px-4 py-3 text-slate-600">{fmt(log.submitted_at)}</td>
                <td className="max-w-sm px-4 py-3 text-xs text-slate-600">{log.user_agent ?? "-"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
