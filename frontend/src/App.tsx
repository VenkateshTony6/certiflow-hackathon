import { type FormEvent, useCallback, useEffect, useMemo, useState } from "react";
import { API_URL, ApiError, api, getBatch, getBatches, getUsers, verifyCertificate } from "./api";
import type { Batch, Certificate, DemoUser, VerifyResult } from "./types";

type Modal =
  | { kind: "decision"; batch: Batch; decision: "APPROVED" | "REJECTED" | "SENT_BACK" }
  | { kind: "resubmit"; batch: Batch }
  | { kind: "revoke"; certificate: Certificate }
  | null;

const statusTone: Record<string, string> = {
  SUBMITTED: "bg-amber-50 text-amber-700 ring-amber-200",
  DISTRICT_APPROVED: "bg-blue-50 text-blue-700 ring-blue-200",
  QUALITY_APPROVED: "bg-violet-50 text-violet-700 ring-violet-200",
  STATE_APPROVED: "bg-emerald-50 text-emerald-700 ring-emerald-200",
  ACTIVE: "bg-emerald-50 text-emerald-700 ring-emerald-200",
  REJECTED: "bg-red-50 text-red-700 ring-red-200",
  REVOKED: "bg-red-50 text-red-700 ring-red-200",
  SENT_BACK: "bg-orange-50 text-orange-700 ring-orange-200",
};

function label(value: string) {
  return value.toLowerCase().replaceAll("_", " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function downloadSample(kind: "valid" | "bad") {
  const csv = kind === "valid"
    ? "fullName,phone,enrollmentNo\nAarav Shah,9876543210,ENR-001\nDiya Rao,9123456780,ENR-002\n"
    : "fullName,phone,enrollmentNo\n,123,ENR-001\nRohan Das,9876543210,ENR-001\n";
  const link = document.createElement("a");
  link.href = URL.createObjectURL(new Blob([csv], { type: "text/csv" }));
  link.download = `candidates-${kind}.csv`;
  link.click();
  URL.revokeObjectURL(link.href);
}

function Status({ value }: { value: string }) {
  return <span className={`rounded-full px-2.5 py-1 text-xs font-semibold ring-1 ${statusTone[value] ?? "bg-slate-50 text-slate-700 ring-slate-200"}`}>{label(value)}</span>;
}

function PublicVerify() {
  const [number, setNumber] = useState("");
  const [result, setResult] = useState<VerifyResult | null>(null);
  const [loading, setLoading] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setLoading(true);
    try { setResult(await verifyCertificate(number.trim())); }
    finally { setLoading(false); }
  }

  const genuine = result?.valid;
  return (
    <main className="mx-auto max-w-3xl px-4 py-16">
      <div className="rounded-3xl border border-slate-200 bg-white p-8 shadow-sm sm:p-12">
        <p className="text-sm font-semibold uppercase tracking-[0.2em] text-emerald-600">Public verification</p>
        <h2 className="mt-2 text-3xl font-bold text-slate-950">Verify a certificate</h2>
        <p className="mt-2 text-slate-500">Enter the certificate number printed on the PDF.</p>
        <form onSubmit={submit} className="mt-7 flex gap-3">
          <input required value={number} onChange={(event) => setNumber(event.target.value)} placeholder="PSM-2026-000001" className="min-w-0 flex-1 rounded-xl border border-slate-300 px-4 py-3 outline-none focus:border-emerald-500 focus:ring-2 focus:ring-emerald-100" />
          <button disabled={loading} className="rounded-xl bg-slate-950 px-5 py-3 font-semibold text-white disabled:opacity-50">{loading ? "Checking…" : "Verify"}</button>
        </form>
        {result && <section className={`mt-8 rounded-2xl border p-6 ${genuine ? "border-emerald-200 bg-emerald-50" : "border-red-200 bg-red-50"}`}>
          <p className={`text-xl font-black ${genuine ? "text-emerald-700" : "text-red-700"}`}>{genuine ? "✓ GENUINE" : result.status === "REVOKED" ? "✕ REVOKED" : "✕ INVALID"}</p>
          <div className="mt-4 grid gap-2 text-sm text-slate-700 sm:grid-cols-2"><p><b>Certificate:</b> {result.certNumber}</p>{result.candidateName && <p><b>Candidate:</b> {result.candidateName}</p>}{result.courseName && <p><b>Course:</b> {result.courseName}</p>}{result.centerName && <p><b>Center:</b> {result.centerName}</p>}{result.revokedReason && <p className="text-red-700"><b>Reason:</b> {result.revokedReason}</p>}</div>
        </section>}
      </div>
    </main>
  );
}

export function App() {
  const [publicMode, setPublicMode] = useState(false);
  const [users, setUsers] = useState<DemoUser[]>([]);
  const [userId, setUserId] = useState(localStorage.getItem("certiflow-user") ?? "");
  const [batches, setBatches] = useState<Batch[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<Batch | null>(null);
  const [modal, setModal] = useState<Modal>(null);
  const [message, setMessage] = useState("");
  const [errors, setErrors] = useState<{ row: number; message: string }[]>([]);
  const activeUser = users.find((user) => user.id === userId) ?? null;

  useEffect(() => {
    void getUsers().then((list) => {
      setUsers(list);
      if (!list.some((user) => user.id === userId) && list[0]) setUserId(list[0].id);
    });
  }, [userId]);
  useEffect(() => { if (userId) localStorage.setItem("certiflow-user", userId); }, [userId]);

  const refresh = useCallback(async () => {
    if (!userId || publicMode || modal) return;
    const list = await getBatches(userId);
    setBatches([...list].sort((a, b) => Number(b.escalated) - Number(a.escalated)));
    if (selectedId) setDetail(await getBatch(userId, selectedId));
  }, [modal, publicMode, selectedId, userId]);

  useEffect(() => {
    void refresh();
    const timer = window.setInterval(() => void refresh(), 3000);
    return () => window.clearInterval(timer);
  }, [refresh]);
  useEffect(() => { setSelectedId(null); setDetail(null); }, [userId]);

  async function selectBatch(id: string) {
    setSelectedId(id);
    setDetail(await getBatch(userId, id));
  }

  async function downloadCertificate(certificate: Certificate) {
    const response = await fetch(`${API_URL}/api/certificates/${encodeURIComponent(certificate.certNumber)}/download`, {
      headers: { "x-user-id": userId },
    });
    if (!response.ok) {
      setMessage("Certificate download is not available.");
      return;
    }
    const url = URL.createObjectURL(await response.blob());
    const link = document.createElement("a");
    link.href = url;
    link.download = `${certificate.certNumber}.pdf`;
    link.click();
    URL.revokeObjectURL(url);
  }

  async function createBatch(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setErrors([]);
    const formElement = event.currentTarget;
    const form = new FormData(formElement);
    form.set("district", activeUser?.district ?? "");
    try {
      await api("/api/batches", userId, { method: "POST", body: form });
      formElement.reset();
      setMessage("Batch submitted successfully.");
      await refresh();
    } catch (error) {
      if (error instanceof ApiError) setErrors(error.payload.errors ?? [{ row: 0, message: error.message }]);
    }
  }

  const canReview = useMemo(() => {
    if (!detail || !activeUser) return false;
    if (activeUser.role === "DISTRICT_OFFICER") return detail.status === "SUBMITTED";
    if (activeUser.role === "QUALITY_TEAM") return detail.status === "DISTRICT_APPROVED" && detail._count.candidates > 50;
    if (activeUser.role === "STATE_OFFICE") return detail.status === (detail._count.candidates > 50 ? "QUALITY_APPROVED" : "DISTRICT_APPROVED");
    return false;
  }, [activeUser, detail]);

  async function submitModal(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!modal) return;
    const form = new FormData(event.currentTarget);
    try {
      if (modal.kind === "resubmit") await api(`/api/batches/${modal.batch.id}/resubmit`, userId, { method: "PUT", body: form });
      else if (modal.kind === "decision") await api(`/api/batches/${modal.batch.id}/decision`, userId, { method: "POST", body: JSON.stringify({ decision: modal.decision, comment: form.get("comment") }) });
      else await api(`/api/certificates/${modal.certificate.certNumber}/revoke`, userId, { method: "POST", body: JSON.stringify({ reason: form.get("reason") }) });
      setModal(null);
      setMessage("Update saved.");
      window.setTimeout(() => void refresh(), 0);
    } catch (error) {
      if (error instanceof ApiError) setMessage(error.message);
    }
  }

  return <div className="min-h-screen bg-slate-50 text-slate-900">
    <nav className="border-b border-slate-200 bg-white"><div className="mx-auto flex max-w-7xl flex-wrap items-center justify-between gap-4 px-4 py-4"><h1 className="text-lg font-extrabold">CertiFlow <span className="font-medium text-slate-400">— Pragati Skills Mission</span></h1><div className="flex flex-wrap items-center gap-3"><button onClick={() => setPublicMode((value) => !value)} className={`rounded-full px-4 py-2 text-sm font-semibold ${publicMode ? "bg-emerald-600 text-white" : "bg-slate-100 text-slate-700"}`}>{publicMode ? "Exit Public Verify" : "Public Verify"}</button>{!publicMode && <select aria-label="Demo persona" value={userId} onChange={(event) => setUserId(event.target.value)} className="rounded-xl border border-slate-300 bg-white px-3 py-2 text-sm font-medium">{users.map((user) => <option key={user.id} value={user.id}>{user.name} · {label(user.role)}{user.district ? ` · ${user.district}` : ""}</option>)}</select>}</div></div></nav>
    {publicMode ? <PublicVerify /> : <main className="mx-auto max-w-7xl px-4 py-8">
      {message && <button onClick={() => setMessage("")} className="mb-5 w-full rounded-xl bg-slate-900 px-4 py-3 text-left text-sm text-white">{message}</button>}
      {activeUser?.role === "TRAINING_CENTER" && <section className="mb-8 rounded-2xl border border-slate-200 bg-white p-6 shadow-sm"><div className="flex flex-wrap items-start justify-between gap-4"><div><h2 className="text-xl font-bold">Submit a new batch</h2><p className="text-sm text-slate-500">Upload all candidates in one validated CSV.</p></div><div className="flex gap-3"><button onClick={() => downloadSample("valid")} className="text-sm font-semibold text-emerald-700">Download sample</button><button onClick={() => downloadSample("bad")} className="text-sm font-semibold text-red-600">Bad CSV sample</button></div></div><form onSubmit={createBatch} className="mt-5 grid gap-3 md:grid-cols-[1fr_1fr_1.2fr_auto]"><input name="batchCode" required placeholder="Batch code" className="rounded-xl border border-slate-300 px-4 py-2.5"/><input name="courseName" required placeholder="Course name" className="rounded-xl border border-slate-300 px-4 py-2.5"/><input name="file" type="file" accept=".csv,text/csv" required className="rounded-xl border border-slate-300 px-3 py-2 text-sm"/><button className="rounded-xl bg-emerald-600 px-5 py-2.5 font-semibold text-white">Submit</button></form>{errors.length > 0 && <ul className="mt-4 rounded-xl bg-red-50 p-4 text-sm text-red-700">{errors.map((error, index) => <li key={`${error.row}-${index}`}>Row {error.row}: {error.message}</li>)}</ul>}</section>}
      <div className="grid gap-6 lg:grid-cols-[0.85fr_1.5fr]">
        <section><div className="mb-3 flex items-end justify-between"><div><h2 className="text-xl font-bold">Batches</h2><p className="text-sm text-slate-500">Updates every 3 seconds</p></div><span className="text-sm text-slate-400">{batches.length} total</span></div><div className="space-y-3">{batches.map((batch) => <button key={batch.id} onClick={() => void selectBatch(batch.id)} className={`w-full rounded-2xl border bg-white p-4 text-left shadow-sm ${batch.escalated ? "border-red-400 ring-2 ring-red-100" : selectedId === batch.id ? "border-slate-900" : "border-slate-200"}`}><div className="flex items-start justify-between gap-3"><div><p className="font-bold">{batch.batchCode}</p><p className="mt-1 text-sm text-slate-500">{batch.courseName} · {batch.district}</p></div>{batch.escalated && <span className="text-xs font-bold text-red-600">ESCALATED</span>}</div><div className="mt-3 flex items-center justify-between"><Status value={batch.status}/><span className="text-xs text-slate-500">{batch._count.candidates} candidates</span></div>{batch.reviewNote && <p className="mt-3 rounded-lg bg-orange-50 p-2 text-xs text-orange-700">{batch.reviewNote}</p>}{activeUser?.role === "TRAINING_CENTER" && batch.status === "SENT_BACK" && <span onClick={(event) => { event.stopPropagation(); setModal({ kind: "resubmit", batch }); }} className="mt-3 inline-block text-sm font-bold text-orange-700">Fix & Resubmit CSV →</span>}</button>)}</div></section>
        <section className="min-h-96 rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">{!detail ? <div className="flex min-h-80 items-center justify-center text-slate-400">Select a batch to inspect its workflow.</div> : <div><div className="flex flex-wrap items-start justify-between gap-4"><div><p className="text-sm font-semibold text-slate-400">{detail.batchCode}</p><h2 className="text-2xl font-bold">{detail.courseName}</h2><p className="mt-1 text-sm text-slate-500">{detail.district} · {detail._count.candidates} candidates</p></div><Status value={detail.status}/></div>
          {canReview && <div className="mt-6 flex flex-wrap gap-2"><button onClick={() => setModal({ kind: "decision", batch: detail, decision: "APPROVED" })} className="rounded-lg bg-emerald-600 px-4 py-2 text-sm font-bold text-white">Approve</button><button onClick={() => setModal({ kind: "decision", batch: detail, decision: "SENT_BACK" })} className="rounded-lg bg-orange-100 px-4 py-2 text-sm font-bold text-orange-700">Send Back</button><button onClick={() => setModal({ kind: "decision", batch: detail, decision: "REJECTED" })} className="rounded-lg bg-red-100 px-4 py-2 text-sm font-bold text-red-700">Reject</button></div>}
          <div className="mt-8 grid gap-8 md:grid-cols-2"><div><h3 className="font-bold">Approval progress</h3><div className="mt-3 space-y-3">{["DISTRICT", "QUALITY", "STATE"].map((stage) => { const approvals = detail.approvals.filter((approval) => approval.stage === stage); return <div key={stage} className="rounded-xl bg-slate-50 p-3"><p className="text-xs font-bold text-slate-500">{stage}</p>{approvals.length ? approvals.map((approval) => <p key={approval.id} className="mt-1 text-sm">{approval.officer.name}: <b>{label(approval.decision)}</b></p>) : <p className="mt-1 text-sm text-slate-400">Pending</p>}</div>; })}</div></div><div><h3 className="font-bold">Audit timeline</h3><ol className="mt-3 space-y-3 border-l-2 border-slate-200 pl-4">{detail.auditLogs.map((log) => <li key={log.id}><p className="text-sm font-semibold">{label(log.action)}</p><time className="text-xs text-slate-400">{new Date(log.createdAt).toLocaleString()}</time></li>)}</ol></div></div>
          {detail.status === "STATE_APPROVED" && <div className="mt-8"><h3 className="font-bold">Certificates</h3><div className="mt-3 overflow-x-auto"><table className="w-full text-left text-sm"><thead className="text-slate-400"><tr><th className="pb-2">Number</th><th className="pb-2">WhatsApp</th><th className="pb-2">Status</th><th></th></tr></thead><tbody>{detail.certificates.map((certificate) => <tr key={certificate.id} className="border-t border-slate-100"><td className="py-3 font-mono">{certificate.pdfUrl ? <button className="text-blue-600 hover:underline" onClick={() => void downloadCertificate(certificate)}>{certificate.certNumber}</button> : certificate.certNumber}</td><td>{label(certificate.deliveryStatus)}</td><td><Status value={certificate.status}/></td><td className="text-right">{activeUser?.role === "STATE_OFFICE" && certificate.status === "ACTIVE" && <button onClick={() => setModal({ kind: "revoke", certificate })} className="font-bold text-red-600">Revoke</button>}</td></tr>)}</tbody></table>{detail.certificates.length === 0 && <p className="py-4 text-sm text-slate-400">Certificates are being generated.</p>}</div></div>}
        </div>}</section>
      </div>
    </main>}
    {modal && <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/50 p-4"><form onSubmit={submitModal} className="w-full max-w-md rounded-2xl bg-white p-6 shadow-2xl"><h2 className="text-xl font-bold">{modal.kind === "resubmit" ? "Fix & resubmit" : modal.kind === "revoke" ? "Revoke certificate" : label(modal.decision)}</h2><p className="mt-1 text-sm text-slate-500">Live polling is paused while this window is open.</p>{modal.kind === "resubmit" ? <input name="file" type="file" accept=".csv,text/csv" required className="mt-5 w-full rounded-xl border border-slate-300 p-3"/> : <textarea name={modal.kind === "revoke" ? "reason" : "comment"} required={modal.kind !== "decision" || modal.decision !== "APPROVED"} placeholder={modal.kind === "revoke" ? "Revocation reason" : "Review comment"} className="mt-5 min-h-28 w-full rounded-xl border border-slate-300 p-3"/>}<div className="mt-5 flex justify-end gap-2"><button type="button" onClick={() => setModal(null)} className="rounded-lg px-4 py-2 font-semibold text-slate-600">Cancel</button><button className="rounded-lg bg-slate-950 px-4 py-2 font-semibold text-white">Confirm</button></div></form></div>}
  </div>;
}
