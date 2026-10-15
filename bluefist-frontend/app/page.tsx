"use client";

import { useEffect, useState, useRef, useCallback } from "react";
import {
  Terminal, GitBranch, Activity, ShieldAlert,
  LayoutDashboard, Cpu, Play, AlertTriangle, Search, BrainCircuit,
  Box, RotateCcw, Flame, Wifi, WifiOff, Eye,
  CheckCircle2, XCircle, Plus, Trash2, Globe, Radio,
  ChevronDown, ChevronUp, Zap, Server, TrendingUp, Shield
} from "lucide-react";

// ─────────────────────────────────────────────────────────────────────────────
// CONSTANTS
// ─────────────────────────────────────────────────────────────────────────────
const API_BASE = (process.env.NEXT_PUBLIC_API_BASE ?? "http://127.0.0.1:8000").replace(/\/$/, "");
const API_TOKEN_KEY = "bluefist_api_token";
const apiHeaders = (json = false): HeadersInit => {
  const token = typeof window === "undefined" ? "" : window.sessionStorage.getItem(API_TOKEN_KEY) ?? "";
  return { ...(json ? { "Content-Type": "application/json" } : {}), ...(token ? { Authorization: `Bearer ${token}` } : {}) };
};
const websocketUrl = (path: string) => {
  const url = new URL(path, API_BASE);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  const token = typeof window === "undefined" ? "" : window.sessionStorage.getItem(API_TOKEN_KEY) ?? "";
  if (token) url.searchParams.set("token", token);
  return url.toString();
};

// ─────────────────────────────────────────────────────────────────────────────
// TYPE DEFINITIONS
// ─────────────────────────────────────────────────────────────────────────────
interface TelemetryEvent {
  ts: string;
  event: string;
  target: string;
  ping?: {
    status: string;
    http_code: number | null;
    latency_ms: number | null;
    error: string | null;
  };
  approval_id?: string;
  repo_url?: string;
  file_path?: string;
  patch_preview?: string;
  full_patch?: string;
  original_code?: string;
  logs_tail?: string[];
  commit_url?: string;
  commit_sha?: string;
  message?: string;
  reviewer_note?: string;
}

interface PendingApproval {
  approval_id: string;
  target_id: string;
  repo_url: string;
  file_path: string;
  patch_code: string;
  original_code: string;
  ping_result: Record<string, unknown>;
  logs: string[];
  created_at: string;
  status: string;
}

interface MonitorTarget {
  target_id: string;
  repo_url: string;
  endpoint_url: string;
  check_interval: number;
}

interface TargetHealth {
  target_id: string;
  last_seen: string;
  status: string;
  latency_ms: number | null;
  http_code: number | null;
}

// ─────────────────────────────────────────────────────────────────────────────
// SMALL REUSABLE COMPONENTS
// ─────────────────────────────────────────────────────────────────────────────
function StatusBadge({ status }: { status: string }) {
  const map: Record<string, { color: string; label: string }> = {
    healthy:     { color: "text-[#10B981] border-[#10B981]/40 bg-[#10B981]/10", label: "HEALTHY"     },
    degraded:    { color: "text-[#FFBD2E] border-[#FFBD2E]/40 bg-[#FFBD2E]/10", label: "DEGRADED"    },
    timeout:     { color: "text-[#FF5F56] border-[#FF5F56]/40 bg-[#FF5F56]/10", label: "TIMEOUT"     },
    unreachable: { color: "text-[#FF5F56] border-[#FF5F56]/40 bg-[#FF5F56]/10", label: "UNREACHABLE" },
    unknown:     { color: "text-white/40 border-white/10 bg-white/5",            label: "UNKNOWN"     },
    pending:     { color: "text-[#8B5CF6] border-[#8B5CF6]/40 bg-[#8B5CF6]/10", label: "PENDING"     },
    applied:     { color: "text-[#10B981] border-[#10B981]/40 bg-[#10B981]/10", label: "APPLIED"     },
    rejected:    { color: "text-[#FF5F56] border-[#FF5F56]/40 bg-[#FF5F56]/10", label: "REJECTED"    },
  };
  const cfg = map[status] ?? map.unknown;
  return (
    <span className={`text-[10px] font-bold font-mono px-2 py-0.5 rounded-full border ${cfg.color}`}>
      {cfg.label}
    </span>
  );
}

function PulsingDot({ color = "#10B981" }: { color?: string }) {
  return (
    <span className="relative flex h-2 w-2">
      <span
        className="animate-ping absolute inline-flex h-full w-full rounded-full opacity-75"
        style={{ backgroundColor: color }}
      />
      <span
        className="relative inline-flex rounded-full h-2 w-2"
        style={{ backgroundColor: color }}
      />
    </span>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// EMERGENCY APPROVAL MODAL
// ─────────────────────────────────────────────────────────────────────────────
interface ApprovalModalProps {
  approval: PendingApproval & Partial<TelemetryEvent>;
  onDecide: (id: string, decision: "approve" | "reject", note: string) => void;
  isSubmitting: boolean;
}

function ApprovalModal({ approval, onDecide, isSubmitting }: ApprovalModalProps) {
  const [note, setNote]         = useState("");
  const [showDiff, setShowDiff] = useState(false);
  const [showLogs, setShowLogs] = useState(false);

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/80 backdrop-blur-sm">
      <div className="absolute inset-0 pointer-events-none">
        <div className="absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-[#FF5F56] to-transparent animate-pulse" />
        <div className="absolute inset-x-0 bottom-0 h-px bg-gradient-to-r from-transparent via-[#FF5F56] to-transparent animate-pulse" />
      </div>

      <div className="relative w-full max-w-3xl mx-4 bg-[#0A0A0A] border border-[#FF5F56]/40 rounded-2xl shadow-[0_0_60px_rgba(255,95,86,0.2)] overflow-hidden">
        <div className="flex items-center gap-3 px-6 py-4 bg-[#FF5F56]/10 border-b border-[#FF5F56]/20">
          <div className="p-2 rounded-lg bg-[#FF5F56]/20">
            <ShieldAlert className="w-5 h-5 text-[#FF5F56] animate-pulse" />
          </div>
          <div className="flex-1">
            <h2 className="text-white font-bold text-sm tracking-wide">
              🚨 EMERGENCY PATCH APPROVAL REQUIRED
            </h2>
            <p className="text-[#FF5F56]/70 text-xs font-mono mt-0.5">
              ID: {approval.approval_id} · Target: {approval.target_id}
            </p>
          </div>
          <div className="text-right">
            <p className="text-white/40 text-[10px] font-mono">CREATED AT</p>
            <p className="text-white/70 text-xs font-mono">
              {new Date(approval.created_at).toLocaleTimeString()}
            </p>
          </div>
        </div>

        <div className="p-6 space-y-4 max-h-[70vh] overflow-y-auto">
          <div className="grid grid-cols-3 gap-3">
            <div className="bg-white/5 rounded-xl p-3 border border-white/10">
              <p className="text-white/40 text-[10px] font-mono uppercase mb-1">File</p>
              <p className="text-white text-xs font-mono truncate">{approval.file_path}</p>
            </div>
            <div className="bg-white/5 rounded-xl p-3 border border-white/10">
              <p className="text-white/40 text-[10px] font-mono uppercase mb-1">Repository</p>
              <p className="text-white text-xs font-mono truncate">{approval.repo_url}</p>
            </div>
            <div className="bg-white/5 rounded-xl p-3 border border-white/10">
              <p className="text-white/40 text-[10px] font-mono uppercase mb-1">Endpoint Status</p>
              <p className="text-[#FF5F56] text-xs font-mono font-bold uppercase">
                {String(
                  (approval.ping_result as Record<string, unknown>)?.status ?? "anomaly"
                )}
              </p>
            </div>
          </div>

          <div className="border border-white/10 rounded-xl overflow-hidden">
            <button
              onClick={() => setShowDiff(!showDiff)}
              className="w-full flex items-center justify-between px-4 py-3 bg-white/5 hover:bg-white/10 transition-all text-sm font-medium text-white"
            >
              <div className="flex items-center gap-2">
                <Zap className="w-4 h-4 text-[#8B5CF6]" />
                AI-Generated Patch Preview
              </div>
              {showDiff ? <ChevronUp className="w-4 h-4 text-white/50" /> : <ChevronDown className="w-4 h-4 text-white/50" />}
            </button>
            {showDiff && (
              <div className="p-4 bg-[#050505] font-mono text-[11px] leading-relaxed text-[#10B981] overflow-x-auto max-h-48 overflow-y-auto">
                <pre className="whitespace-pre-wrap break-all">
                  {approval.patch_code || approval.full_patch || "No patch data available."}
                </pre>
              </div>
            )}
          </div>

          <div className="border border-white/10 rounded-xl overflow-hidden">
            <button
              onClick={() => setShowLogs(!showLogs)}
              className="w-full flex items-center justify-between px-4 py-3 bg-white/5 hover:bg-white/10 transition-all text-sm font-medium text-white"
            >
              <div className="flex items-center gap-2">
                <Terminal className="w-4 h-4 text-[#00F0FF]" />
                Sandbox Verification Logs (
                {(approval.logs_tail ?? approval.logs ?? []).length} lines
                )
              </div>
              {showLogs ? <ChevronUp className="w-4 h-4 text-white/50" /> : <ChevronDown className="w-4 h-4 text-white/50" />}
            </button>
            {showLogs && (
              <div className="p-4 bg-[#050505] font-mono text-[11px] leading-relaxed overflow-y-auto max-h-40">
                {(approval.logs_tail ?? approval.logs ?? []).map((line, i) => (
                  <div
                    key={i}
                    className={`mb-0.5 ${
                      line.includes("✅") ? "text-[#10B981]"  :
                      line.includes("❌") || line.includes("🚨") ? "text-[#FF5F56]" :
                      line.includes("🧠") || line.includes("ITERATION") ? "text-[#8B5CF6]" :
                      "text-white/50"
                    }`}
                  >
                    {line}
                  </div>
                ))}
              </div>
            )}
          </div>

          <div className="rounded-xl border border-[#FFBD2E]/30 bg-[#FFBD2E]/5 px-4 py-3 text-xs text-[#F4D58D]">
            Approval commits this patch directly to the repository's default branch. Bluefist checks syntax only; it does not run the repository's tests.
          </div>

          <div>
            <label className="text-white/50 text-xs font-mono uppercase mb-2 block">
              Reviewer Note (optional)
            </label>
            <textarea
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder="Add a note for the audit log..."
              className="w-full bg-white/5 border border-white/10 rounded-xl px-4 py-3 text-white text-sm font-mono focus:outline-none focus:border-[#10B981] transition-all resize-none h-20"
            />
          </div>
        </div>

        <div className="flex gap-3 px-6 py-4 border-t border-white/10 bg-black/20">
          <button
            onClick={() => onDecide(approval.approval_id, "reject", note)}
            disabled={isSubmitting}
            className="flex-1 flex items-center justify-center gap-2 px-6 py-3 rounded-xl border border-[#FF5F56]/40 text-[#FF5F56] font-bold text-sm hover:bg-[#FF5F56]/10 transition-all disabled:opacity-40"
          >
            <XCircle className="w-4 h-4" /> Reject Patch
          </button>
          <button
            onClick={() => onDecide(approval.approval_id, "approve", note)}
            disabled={isSubmitting}
            className="flex-1 flex items-center justify-center gap-2 px-8 py-3 rounded-xl bg-[#10B981] text-black font-bold text-sm hover:bg-[#059669] transition-all disabled:opacity-40 shadow-[0_0_20px_rgba(16,185,129,0.4)]"
          >
            {isSubmitting ? <RotateCcw className="w-4 h-4 animate-spin" /> : <CheckCircle2 className="w-4 h-4" />}
            Apply Patch to GitHub
          </button>
        </div>
        <p className="mt-3 text-center text-[11px] text-white/40">
          Approval writes this reviewed patch directly to the repository's default branch.
        </p>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// GLOBAL TELEMETRY TAB
// ─────────────────────────────────────────────────────────────────────────────
interface TelemetryTabProps {
  events: TelemetryEvent[];
  summary: Record<string, TargetHealth>;
  wsConnected: boolean;
}

function TelemetryTab({ events, summary, wsConnected }: TelemetryTabProps) {
  const feedRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    feedRef.current?.scrollTo({
      top: feedRef.current.scrollHeight,
      behavior: "smooth",
    });
  }, [events]);

  const eventColor = (type: string) => {
    if (["heartbeat", "deploy_complete", "manual_fix_deployed"].includes(type)) return "text-[#10B981]";
    if (["anomaly", "tdd_fatal", "deploy_failed", "monitor_error"].includes(type)) return "text-[#FF5F56]";
    if (["approval_queued", "approval_required"].includes(type)) return "text-[#8B5CF6]";
    if (type === "approval_rejected") return "text-[#FFBD2E]";
    if (type === "deploy_started")    return "text-[#00F0FF]";
    return "text-white/60";
  };

  const eventIcon = (type: string) => {
    const icons: Record<string, string> = {
      heartbeat:         "💓",
      anomaly:           "🚨",
      approval_required: "🔐",
      approval_queued:   "⏳",
      approval_rejected: "❌",
      deploy_started:    "🚀",
      deploy_complete:   "✅",
      deploy_failed:     "💥",
      tdd_fatal:         "💀",
      monitor_error:     "⚠️",
    };
    return icons[type] ?? "📡";
  };

  return (
    <div className="max-w-7xl mx-auto space-y-6 animate-fade-in-up">
      <div className={`flex items-center gap-3 px-4 py-2 rounded-xl border text-sm font-medium ${
        wsConnected
          ? "bg-[#10B981]/10 border-[#10B981]/30 text-[#10B981]"
          : "bg-[#FF5F56]/10 border-[#FF5F56]/30 text-[#FF5F56]"
      }`}>
        {wsConnected ? <Wifi className="w-4 h-4" /> : <WifiOff className="w-4 h-4" />}
        {wsConnected
          ? "Dashboard WebSocket connected — receiving live broadcast events"
          : "Dashboard WebSocket disconnected — events will not update in real time"}
      </div>

      <div>
        <h3 className="text-white/50 text-xs font-mono uppercase mb-3 flex items-center gap-2">
          <TrendingUp className="w-3 h-3" /> Target Health Summary
        </h3>
        {Object.keys(summary).length === 0 ? (
          <div className="bg-white/5 border border-white/10 rounded-xl p-6 text-center text-white/30 text-sm">
            No monitored targets yet. Register one in the Targets tab.
          </div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
            {Object.values(summary).map((h) => (
              <div key={h.target_id} className="bg-[#0A0A0A] border border-white/10 rounded-xl p-4 space-y-2">
                <div className="flex items-center justify-between">
                  <p className="text-white font-mono text-sm font-bold">{h.target_id}</p>
                  <StatusBadge status={h.status} />
                </div>
                <div className="grid grid-cols-2 gap-2 text-xs font-mono">
                  <div>
                    <p className="text-white/30">Latency</p>
                    <p className="text-white/70">
                      {h.latency_ms != null ? `${h.latency_ms} ms` : "—"}
                    </p>
                  </div>
                  <div>
                    <p className="text-white/30">HTTP</p>
                    <p className="text-white/70">{h.http_code ?? "—"}</p>
                  </div>
                  <div className="col-span-2">
                    <p className="text-white/30">Last Seen</p>
                    <p className="text-white/70">
                      {new Date(h.last_seen).toLocaleTimeString()}
                    </p>
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      <div>
        <h3 className="text-white/50 text-xs font-mono uppercase mb-3 flex items-center gap-2">
          <Radio className="w-3 h-3 animate-pulse text-[#10B981]" /> Live Event Feed
        </h3>
        <div ref={feedRef} className="bg-[#050505] border border-white/10 rounded-xl h-[420px] overflow-y-auto p-4 space-y-1 font-mono text-xs">
          {events.length === 0 ? (
            <div className="h-full flex items-center justify-center text-white/20">
              <div className="text-center">
                <Globe className="w-10 h-10 mx-auto mb-3 opacity-30" />
                <p>Waiting for telemetry events...</p>
              </div>
            </div>
          ) : (
            events.map((ev, i) => (
              <div key={i} className={`flex items-start gap-3 py-1 border-b border-white/5 ${eventColor(ev.event)}`}>
                <span className="shrink-0 mt-0.5">{eventIcon(ev.event)}</span>
                <span className="text-white/30 shrink-0 tabular-nums">
                  {new Date(ev.ts).toLocaleTimeString()}
                </span>
                <span className="text-white/50 shrink-0 uppercase">[{ev.target}]</span>
                <span className="flex-1 break-all">
                  {ev.event.toUpperCase()}
                  {ev.ping?.status    && ` — ${ev.ping.status}`}
                  {ev.ping?.latency_ms != null && ` ${ev.ping.latency_ms}ms`}
                  {ev.ping?.http_code  != null && ` HTTP ${ev.ping.http_code}`}
                  {ev.ping?.error      && ` ⚠ ${ev.ping.error}`}
                  {ev.approval_id      && ` · ${ev.approval_id}`}
                  {ev.commit_url       && ` → ${ev.commit_url}`}
                </span>
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// TARGET REPOSITORIES TAB
// ─────────────────────────────────────────────────────────────────────────────
interface RepoTabProps {
  targets: MonitorTarget[];
  onRegister: (t: MonitorTarget) => Promise<void>;
  onDeregister: (id: string) => Promise<void>;
  isRegistering: boolean;
  registerError: string | null;
}

function RepoTab({
  targets, onRegister, onDeregister, isRegistering, registerError,
}: RepoTabProps) {
  const [form, setForm] = useState<MonitorTarget>({
    target_id:      "",
    repo_url:       "",
    endpoint_url:   "",
    check_interval: 60,
  });
  const [fieldErrors, setFieldErrors] = useState<Partial<Record<keyof MonitorTarget, string>>>({});

  const validate = (): boolean => {
    const errs: Partial<Record<keyof MonitorTarget, string>> = {};
    if (!form.target_id.trim())    errs.target_id    = "Required";
    if (!form.repo_url.trim())     errs.repo_url     = "Required";
    if (!form.endpoint_url.trim()) errs.endpoint_url = "Required";
    if (form.check_interval < 15)  errs.check_interval = "Min 15 s";
    setFieldErrors(errs);
    return Object.keys(errs).length === 0;
  };

  const handleSubmit = async () => {
    if (!validate()) return;
    await onRegister(form);
    setForm({ target_id: "", repo_url: "", endpoint_url: "", check_interval: 60 });
    setFieldErrors({});
  };

  return (
    <div className="max-w-4xl mx-auto space-y-6 animate-fade-in-up">
      <div className="bg-[#0A0A0A] border border-white/10 rounded-2xl p-6 space-y-4">
        <h3 className="text-white font-bold text-sm flex items-center gap-2">
          <Plus className="w-4 h-4 text-[#10B981]" /> Register New Monitor Target
        </h3>

        {registerError && (
          <div className="flex items-center gap-2 px-4 py-3 bg-[#FF5F56]/10 border border-[#FF5F56]/30 rounded-xl text-[#FF5F56] text-sm font-mono">
            <XCircle className="w-4 h-4 shrink-0" />
            {registerError}
          </div>
        )}

        <div className="grid grid-cols-2 gap-4">
          <div>
            <label className="text-white/40 text-xs font-mono uppercase mb-1.5 block">Target ID (slug)</label>
            <input
              value={form.target_id}
              onChange={(e) => setForm({ ...form, target_id: e.target.value })}
              placeholder="checkout-service"
              className={`w-full bg-white/5 border rounded-xl px-4 py-2.5 text-white font-mono text-sm focus:outline-none transition-all ${
                fieldErrors.target_id ? "border-[#FF5F56] focus:border-[#FF5F56]" : "border-white/10 focus:border-[#10B981]"
              }`}
            />
            {fieldErrors.target_id && <p className="text-[#FF5F56] text-[10px] font-mono mt-1">{fieldErrors.target_id}</p>}
          </div>

          <div>
            <label className="text-white/40 text-xs font-mono uppercase mb-1.5 block">Check Interval (seconds)</label>
            <input
              type="number"
              value={form.check_interval}
              onChange={(e) => setForm({ ...form, check_interval: Number(e.target.value) })}
              min={15}
              className={`w-full bg-white/5 border rounded-xl px-4 py-2.5 text-white font-mono text-sm focus:outline-none transition-all ${
                fieldErrors.check_interval ? "border-[#FF5F56] focus:border-[#FF5F56]" : "border-white/10 focus:border-[#10B981]"
              }`}
            />
            {fieldErrors.check_interval && <p className="text-[#FF5F56] text-[10px] font-mono mt-1">Min 15 s</p>}
          </div>

          <div className="col-span-2">
            <label className="text-white/40 text-xs font-mono uppercase mb-1.5 block">GitHub Repo URL</label>
            <input
              value={form.repo_url}
              onChange={(e) => setForm({ ...form, repo_url: e.target.value })}
              placeholder="https://github.com/akshat/checkout-service"
              className={`w-full bg-white/5 border rounded-xl px-4 py-2.5 text-white font-mono text-sm focus:outline-none transition-all ${
                fieldErrors.repo_url ? "border-[#FF5F56] focus:border-[#FF5F56]" : "border-white/10 focus:border-[#10B981]"
              }`}
            />
            {fieldErrors.repo_url && <p className="text-[#FF5F56] text-[10px] font-mono mt-1">{fieldErrors.repo_url}</p>}
          </div>

          <div className="col-span-2">
            <label className="text-white/40 text-xs font-mono uppercase mb-1.5 block">Live Endpoint URL</label>
            <input
              value={form.endpoint_url}
              onChange={(e) => setForm({ ...form, endpoint_url: e.target.value })}
              placeholder="https://api.yourapp.com/health"
              className={`w-full bg-white/5 border rounded-xl px-4 py-2.5 text-white font-mono text-sm focus:outline-none transition-all ${
                fieldErrors.endpoint_url ? "border-[#FF5F56] focus:border-[#FF5F56]" : "border-white/10 focus:border-[#10B981]"
              }`}
            />
            {fieldErrors.endpoint_url && <p className="text-[#FF5F56] text-[10px] font-mono mt-1">{fieldErrors.endpoint_url}</p>}
          </div>
        </div>

        <button
          onClick={handleSubmit}
          disabled={isRegistering}
          className="flex items-center gap-2 bg-[#10B981] text-black px-6 py-2.5 rounded-xl font-bold text-sm hover:bg-[#059669] transition-all disabled:opacity-40 shadow-[0_0_15px_rgba(16,185,129,0.3)]"
        >
          {isRegistering ? <RotateCcw className="w-4 h-4 animate-spin" /> : <Plus className="w-4 h-4" />}
          {isRegistering ? "Registering..." : "Register & Start Monitoring"}
        </button>
      </div>

      <div>
        <h3 className="text-white/50 text-xs font-mono uppercase mb-3 flex items-center gap-2">
          <Server className="w-3 h-3" /> Active Monitor Registry ({targets.length})
        </h3>
        {targets.length === 0 ? (
          <div className="bg-white/5 border border-white/10 rounded-xl p-8 text-center text-white/30 text-sm">
            No targets registered. Add one above to start live monitoring.
          </div>
        ) : (
          <div className="space-y-3">
            {targets.map((t) => (
              <div key={t.target_id} className="bg-[#0A0A0A] border border-white/10 rounded-xl p-4 flex items-center justify-between gap-4">
                <div className="flex items-center gap-3">
                  <div className="p-2 bg-[#10B981]/10 rounded-lg">
                    <Shield className="w-4 h-4 text-[#10B981]" />
                  </div>
                  <div>
                    <p className="text-white font-bold text-sm font-mono">{t.target_id}</p>
                    <p className="text-white/40 text-xs font-mono truncate max-w-sm">{t.endpoint_url}</p>
                    <p className="text-white/30 text-xs font-mono truncate max-w-sm">{t.repo_url}</p>
                  </div>
                </div>
                <div className="flex items-center gap-4">
                  <div className="text-right">
                    <p className="text-white/30 text-[10px] font-mono">INTERVAL</p>
                    <p className="text-white/60 text-xs font-mono">{t.check_interval}s</p>
                  </div>
                  <div className="flex items-center gap-1">
                    <PulsingDot color="#10B981" />
                    <span className="text-[#10B981] text-xs font-mono ml-1">LIVE</span>
                  </div>
                  <button
                    onClick={() => onDeregister(t.target_id)}
                    className="p-2 rounded-lg hover:bg-[#FF5F56]/10 text-white/30 hover:text-[#FF5F56] transition-all border border-white/10 hover:border-[#FF5F56]/30"
                  >
                    <Trash2 className="w-4 h-4" />
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// PRICING TAB COMPONENT
// ─────────────────────────────────────────────────────────────────────────────
// MAIN APPLICATION
// ─────────────────────────────────────────────────────────────────────────────
export default function BluefistConsole() {

  // ── Tab state ──────────────────────────────────────────────────────────────
  const [activeTab, setActiveTab] = useState<"engine" | "dashboard" | "repos">("engine");

  // ── Ghost Terminal ─────────────────────────────────────────────────────────
  const [repoUrl, setRepoUrl]               = useState("");
  const [filePath, setFilePath]             = useState("");
  const [errorTrace, setErrorTrace]         = useState("");
  const [apiToken, setApiToken]             = useState("");
  const [logs, setLogs]                     = useState<string[]>([]);
  const [isEngineActive, setIsEngineActive] = useState(false);
  const [agentStep, setAgentStep]           = useState(0);
  const [iterationCount, setIterationCount] = useState(1);
  const [isRetrying, setIsRetrying] = useState(false);

  // ── Dashboard WebSocket ────────────────────────────────────────────────────
  const [dashWsConnected, setDashWsConnected] = useState(false);
  const [telemetryEvents, setTelemetryEvents] = useState<TelemetryEvent[]>([]);
  const [healthSummary, setHealthSummary]     = useState<Record<string, TargetHealth>>({});

  // ── Approval gate ──────────────────────────────────────────────────────────
  const [pendingApprovals, setPendingApprovals]       = useState<PendingApproval[]>([]);
  const [activeModal, setActiveModal]                 = useState<PendingApproval | null>(null);
  const [isSubmittingApproval, setIsSubmittingApproval] = useState(false);
  const [approvalToast, setApprovalToast]             = useState<string | null>(null);
  const [approvalCommitUrl, setApprovalCommitUrl]     = useState<string | null>(null);

  // ── Target registry ────────────────────────────────────────────────────────
  const [targets, setTargets]           = useState<MonitorTarget[]>([]);
  const [isRegistering, setIsRegistering] = useState(false);
  const [registerError, setRegisterError] = useState<string | null>(null);

  // ── Refs ───────────────────────────────────────────────────────────────────
  const logsEndRef = useRef<HTMLDivElement>(null);
  const wsRef      = useRef<WebSocket | null>(null);
  const dashWsRef  = useRef<WebSocket | null>(null);
  const dashReconnectRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const unmountedRef = useRef(false);
  const connectDashboardWsRef = useRef<() => void>(() => {});

  useEffect(() => {
    if (apiToken) window.sessionStorage.setItem(API_TOKEN_KEY, apiToken);
    else window.sessionStorage.removeItem(API_TOKEN_KEY);
    const headers = apiHeaders();
    void Promise.all([
      fetch(`${API_BASE}/monitor/targets`, { headers }).then((r) => r.ok ? r.json() : null),
      fetch(`${API_BASE}/approvals/pending`, { headers }).then((r) => r.ok ? r.json() : null),
      fetch(`${API_BASE}/telemetry/summary`, { headers }).then((r) => r.ok ? r.json() : null),
    ]).then(([targetData, approvalData, summaryData]) => {
      if (targetData?.targets) setTargets(Object.values(targetData.targets) as MonitorTarget[]);
      if (approvalData?.pending) setPendingApprovals(approvalData.pending);
      if (summaryData?.summary) setHealthSummary(summaryData.summary);
    }).catch(() => setApprovalToast("Could not load saved dashboard state. Check the API connection."));
  }, [apiToken]);

  // ── Auto-scroll terminal ───────────────────────────────────────────────────
  useEffect(() => {
    logsEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [logs]);

  // ── Toast auto-dismiss ─────────────────────────────────────────────────────
  useEffect(() => {
    if (!approvalToast) return;
    const t = setTimeout(() => setApprovalToast(null), 5000);
    return () => clearTimeout(t);
  }, [approvalToast]);

  // ─────────────────────────────────────────────────────────────────────────
  // DASHBOARD WEBSOCKET
  // ─────────────────────────────────────────────────────────────────────────
  const connectDashboardWs = useCallback(() => {
    if (dashWsRef.current?.readyState === WebSocket.OPEN || dashWsRef.current?.readyState === WebSocket.CONNECTING) return;

    const ws = new WebSocket(websocketUrl("/ws/dashboard"));
    dashWsRef.current = ws;

    ws.onopen = () => setDashWsConnected(true);

    ws.onmessage = (evt) => {
      try {
        const msg: TelemetryEvent & {
          type: string;
          pending_approvals?: PendingApproval[];
          monitored_targets?: string[];
          recent_telemetry?: TelemetryEvent[];
        } = JSON.parse(evt.data);

        if (msg.type === "keepalive" || msg.type === "pong") return;

        if (msg.type === "state_snapshot") {
          if (msg.pending_approvals) setPendingApprovals(msg.pending_approvals);
          if (msg.recent_telemetry) {
            const snapshot: Record<string, TargetHealth> = {};
            for (const item of msg.recent_telemetry) {
              if ((item.event === "heartbeat" || item.event === "anomaly") && item.ping && !snapshot[item.target]) {
                snapshot[item.target] = {
                  target_id: item.target, last_seen: item.ts,
                  status: item.ping.status, latency_ms: item.ping.latency_ms,
                  http_code: item.ping.http_code,
                };
              }
            }
            setHealthSummary((prev) => ({ ...snapshot, ...prev }));
          }
          if (msg.recent_telemetry)
            setTelemetryEvents((prev) =>
              [...(msg.recent_telemetry ?? []), ...prev].slice(0, 200)
            );
          return;
        }

        const event: TelemetryEvent = {
          ts:            msg.ts ?? new Date().toISOString(),
          event:         msg.type,
          target:        msg.target ?? "—",
          ping:          msg.ping,
          approval_id:   msg.approval_id,
          file_path:     msg.file_path,
          full_patch:    msg.full_patch,
          original_code: msg.original_code,
          logs_tail:     msg.logs_tail,
          commit_url:    msg.commit_url,
        };
        setTelemetryEvents((prev) => [...prev, event].slice(-200));

        if (msg.type === "heartbeat" && msg.ping) {
          setHealthSummary((prev) => ({
            ...prev,
            [msg.target]: {
              target_id:  msg.target,
              last_seen:  msg.ts,
              status:     msg.ping!.status,
              latency_ms: msg.ping!.latency_ms,
              http_code:  msg.ping!.http_code,
            },
          }));
        }

        if (msg.type === "approval_required") {
          const appr: PendingApproval = {
            approval_id:   msg.approval_id!,
            target_id:     msg.target,
            repo_url:      msg.repo_url ?? "",
            file_path:     msg.file_path ?? "",
            patch_code:    msg.full_patch ?? "",
            original_code: msg.original_code ?? "",
            ping_result:   (msg.ping as Record<string, unknown>) ?? {},
            logs:          msg.logs_tail ?? [],
            created_at:    msg.ts,
            status:        "pending",
          };
          setPendingApprovals((prev) => {
            const exists = prev.find((p) => p.approval_id === appr.approval_id);
            return exists ? prev : [appr, ...prev];
          });
          setActiveModal(appr);
          setActiveTab("dashboard");
          setAgentStep(5);
        }

        if (msg.type === "deploy_complete") {
          setAgentStep(6);
          setActiveModal((current) => current?.approval_id === msg.approval_id ? null : current);
          setApprovalToast(`✅ Patch applied to the default branch. Commit: ${msg.commit_sha ?? "—"}`);
          setApprovalCommitUrl(msg.commit_url ?? null);
          setPendingApprovals((prev) =>
            prev.map((p) =>
              p.approval_id === msg.approval_id
                ? { ...p, status: "applied" }
                : p
            )
          );
        }

        if (msg.type === "approval_rejected") {
          setApprovalToast(`❌ Patch rejected for ${msg.target}`);
          setPendingApprovals((prev) =>
            prev.map((p) =>
              p.approval_id === msg.approval_id
                ? { ...p, status: "rejected" }
                : p
            )
          );
        }
      } catch {
        // Non-JSON frame — ignore
      }
    };

    ws.onclose = () => {
      setDashWsConnected(false);
      if (!unmountedRef.current) dashReconnectRef.current = setTimeout(() => connectDashboardWsRef.current(), 2500);
    };

    ws.onerror = () => ws.close();
  }, []);

  useEffect(() => {
    unmountedRef.current = false;
    connectDashboardWsRef.current = connectDashboardWs;
    connectDashboardWs();
    return () => {
      unmountedRef.current = true;
      if (dashReconnectRef.current) clearTimeout(dashReconnectRef.current);
      dashWsRef.current?.close();
    };
  }, [connectDashboardWs]);

  // Keep-alive ping every 25 s
  useEffect(() => {
    const iv = setInterval(() => {
      if (dashWsRef.current?.readyState === WebSocket.OPEN) {
        dashWsRef.current.send("ping");
      }
    }, 25000);
    return () => clearInterval(iv);
  }, []);

  // ─────────────────────────────────────────────────────────────────────────
  // GHOST TERMINAL ENGINE
  // ─────────────────────────────────────────────────────────────────────────
  const triggerEngine = () => {
    if (!repoUrl || !filePath || !errorTrace.trim()) {
      setApprovalToast("Add the repository, exact Python file path, and incident details first.");
      return;
    }
    setIsEngineActive(true);
    setAgentStep(1);
    setIterationCount(1);
    setIsRetrying(false);
    setLogs(["🚀 [SYSTEM] Building an incident-scoped patch proposal..."]);

    const ws = new WebSocket(websocketUrl("/ws/ghost-terminal"));
    wsRef.current = ws;

    ws.onopen = () => ws.send(JSON.stringify({ repo_url: repoUrl, file_path: filePath, error_trace: errorTrace }));

    ws.onmessage = (event) => {
      const data: string = event.data;
      setLogs((prev) => [...prev, data]);

      if (data.includes("Connecting to GitHub") || data.includes("Extracted Abstract")) {
        setAgentStep(1);
      } else if (data.toLowerCase().includes("incident details") || data.includes("Anomaly detected")) {
        setAgentStep(2);
      } else if (data.includes("Synthesizing patch")) {
        setAgentStep(3);
        setIsRetrying(false);
      } else if (data.includes("SYNTAX CHECK") || data.includes("VALIDATION")) {
        setAgentStep(4);
      } else if (
        data.includes("Sandbox rejected patch") ||
        data.includes("[FEEDBACK LOOP]")
      ) {
        setIsRetrying(true);
        setIterationCount((prev) => prev + 1);
        setAgentStep(3);
      } else if (data.includes("REVIEW REQUIRED")) {
        setAgentStep(5);
      }
    };

    ws.onerror = () => {
      setLogs((prev) => [
        ...prev,
        "\n❌ [NETWORK ERROR] Connection to AI Core failed.",
      ]);
      setIsEngineActive(false);
      setAgentStep(0);
    };

    ws.onclose = () => setIsEngineActive(false);
  };

  const resetEngine = () => {
    setLogs([]);
    setAgentStep(0);
    setIterationCount(1);
    setIsRetrying(false);
  };

  // ─────────────────────────────────────────────────────────────────────────
  // APPROVAL GATE
  // ─────────────────────────────────────────────────────────────────────────
  const handleApprovalDecision = async (
    approvalId: string,
    decision: "approve" | "reject",
    note: string
  ) => {
    setIsSubmittingApproval(true);
    setApprovalCommitUrl(null);
    try {
      const res = await fetch(`${API_BASE}/approvals/decide`, {
        method: "POST",
        headers: apiHeaders(true),
        body: JSON.stringify({
          approval_id:   approvalId,
          decision,
          reviewer_note: note,
        }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.detail ?? `HTTP ${res.status}`);
      }
      const result = await res.json();
      setActiveModal(null);
      setPendingApprovals((prev) => prev.map((item) => item.approval_id === approvalId
        ? { ...item, status: decision === "approve" ? "applied" : "rejected" }
        : item));
      if (decision === "approve" && result.commit_url) {
        setApprovalCommitUrl(result.commit_url);
        setApprovalToast("✅ Reviewed patch committed directly to the default branch.");
      } else {
        setApprovalToast("❌ Patch rejected. No GitHub changes were made.");
      }
    } catch (err) {
      setApprovalToast(`⚠️ Approval failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setIsSubmittingApproval(false);
    }
  };

  // ─────────────────────────────────────────────────────────────────────────
  // TARGET REGISTRY ACTIONS
  // ─────────────────────────────────────────────────────────────────────────
  const handleRegisterTarget = async (target: MonitorTarget) => {
    setIsRegistering(true);
    setRegisterError(null);
    try {
      const res = await fetch(`${API_BASE}/monitor/register`, {
        method:  "POST",
        headers: apiHeaders(true),
        body:    JSON.stringify(target),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.detail ?? `HTTP ${res.status}`);
      }
      const data = await res.json();
      setTargets((prev) => [...prev.filter((item) => item.target_id !== target.target_id), target]);
      setApprovalToast(`✅ "${data.target_id}" registered — monitoring started.`);
    } catch (err) {
      const msg = `Registration failed: ${err}`;
      setRegisterError(msg);
      setApprovalToast(`⚠️ ${msg}`);
    } finally {
      setIsRegistering(false);
    }
  };

  const handleDeregisterTarget = async (targetId: string) => {
    try {
      const res = await fetch(`${API_BASE}/monitor/${targetId}`, {
        method: "DELETE",
        headers: apiHeaders(),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.detail ?? `HTTP ${res.status}`);
      }
      setTargets((prev) => prev.filter((t) => t.target_id !== targetId));
      setHealthSummary((prev) => {
        const next = { ...prev };
        delete next[targetId];
        return next;
      });
      setApprovalToast(`🗑 Target "${targetId}" removed from registry.`);
    } catch (err) {
      setApprovalToast(`⚠️ Deregistration failed: ${err}`);
    }
  };

  const pendingCount = pendingApprovals.filter((p) => p.status === "pending").length;

  // ─────────────────────────────────────────────────────────────────────────
  // RENDER
  // ─────────────────────────────────────────────────────────────────────────
  return (
    <div className="flex min-h-screen flex-col bg-[#050505] text-[#A1A1AA] font-sans selection:bg-[#10B981] selection:text-black xl:h-screen xl:flex-row xl:overflow-hidden">

      {/* Emergency approval modal */}
      {activeModal && (
        <ApprovalModal
          approval={activeModal as PendingApproval & Partial<TelemetryEvent>}
          onDecide={handleApprovalDecision}
          isSubmitting={isSubmittingApproval}
        />
      )}

      {/* ─────────────── SIDEBAR ─────────────── */}
      <aside className="w-full border-b border-white/10 bg-[#0A0A0A] flex flex-col justify-between z-20 shadow-2xl shrink-0 xl:w-64 xl:border-b-0 xl:border-r">
        <div>
          <div className="h-16 flex items-center px-6 border-b border-white/10 gap-3 bg-black/20">
            <ShieldAlert className="text-[#10B981] w-6 h-6 animate-pulse" />
            <span className="text-white font-bold tracking-widest text-lg">BLUEFIST</span>
          </div>

          <nav className="p-4 space-y-2 mt-4">
            <button
              onClick={() => setActiveTab("dashboard")}
              className={`w-full flex items-center gap-3 px-4 py-3 rounded-lg text-sm font-medium transition-all ${
                activeTab === "dashboard" ? "bg-white/10 text-white shadow-sm" : "hover:bg-white/5"
              }`}
            >
              <LayoutDashboard className="w-4 h-4" /> Global Telemetry
              {pendingCount > 0 && (
                <span className="ml-auto flex items-center justify-center w-5 h-5 rounded-full bg-[#FF5F56] text-white text-[10px] font-bold animate-bounce">
                  {pendingCount}
                </span>
              )}
            </button>

            <button
              onClick={() => setActiveTab("engine")}
              className={`w-full flex items-center gap-3 px-4 py-3 rounded-lg text-sm font-medium transition-all ${
                activeTab === "engine" ? "bg-[#10B981]/10 text-[#10B981] border border-[#10B981]/20 shadow-[0_0_15px_rgba(16,185,129,0.1)]" : "hover:bg-white/5"
              }`}
            >
              <Activity className="w-4 h-4" /> Live Orchestration
            </button>

            <button
              onClick={() => setActiveTab("repos")}
              className={`w-full flex items-center gap-3 px-4 py-3 rounded-lg text-sm font-medium transition-all ${
                activeTab === "repos" ? "bg-white/10 text-white" : "hover:bg-white/5"
              }`}
            >
              <GitBranch className="w-4 h-4" /> Target Repositories
            </button>

          </nav>

          {/* Pending approvals in sidebar */}
          {pendingCount > 0 && (
            <div className="mx-4 mt-2 p-3 bg-[#FF5F56]/10 border border-[#FF5F56]/20 rounded-xl">
              <p className="text-[#FF5F56] text-[10px] font-mono font-bold uppercase mb-2 flex items-center gap-1">
                <Eye className="w-3 h-3" /> Awaiting Review
              </p>
              {pendingApprovals
                .filter((p) => p.status === "pending")
                .map((p) => (
                  <button
                    key={p.approval_id}
                    onClick={() => {
                      setActiveModal(p);
                      setActiveTab("dashboard");
                    }}
                    className="w-full text-left text-xs text-white/70 font-mono truncate hover:text-white transition-colors mb-1"
                  >
                    → {p.target_id}
                  </button>
                ))}
            </div>
          )}
        </div>

        {/* User footer */}
        <div className="p-4 border-t border-white/10 bg-black/20">
          <div className="flex items-center gap-3 px-4 py-2">
            <div className="w-8 h-8 rounded-full bg-gradient-to-tr from-[#10B981] to-[#00F0FF] shadow-[0_0_10px_rgba(16,185,129,0.5)]" />
            <div>
              <p className="text-white text-xs font-bold">Bluefist operator</p>
              <p className="text-[10px] text-white/40 font-mono mt-0.5">LOCAL SESSION</p>
            </div>
          </div>
          <label className="mt-3 block px-4 text-[10px] uppercase tracking-wider text-white/40">
            API bearer token <span className="normal-case tracking-normal">(optional locally)</span>
            <input
              type="password"
              autoComplete="off"
              value={apiToken}
              onChange={(event) => setApiToken(event.target.value)}
              placeholder="Paste token for secured deployments"
              className="mt-1 w-full rounded-lg border border-white/10 bg-white/5 px-3 py-2 text-xs text-white outline-none focus:border-[#10B981]"
            />
          </label>
        </div>
      </aside>

      {/* ─────────────── MAIN ─────────────── */}
      <main className="min-w-0 flex-1 flex flex-col relative bg-[radial-gradient(ellipse_at_top_right,_var(--tw-gradient-stops))] from-[#10B981]/5 via-[#050505] to-[#050505]">

        <header className="h-16 border-b border-white/10 bg-[#0A0A0A]/80 backdrop-blur-md flex items-center justify-between px-8 z-10 shrink-0">
          <div className="text-sm font-medium text-white/50 flex items-center gap-2">
            Control Plane
            <span className="text-white/20">/</span>
            <span className="text-white font-bold">{activeTab.toUpperCase()}</span>
          </div>
          <div className="flex items-center gap-4">
            <div className={`flex items-center gap-2 px-3 py-1 rounded-full border text-xs font-mono ${
              dashWsConnected ? "bg-[#10B981]/10 border-[#10B981]/20 text-[#10B981]" : "bg-[#FF5F56]/10 border-[#FF5F56]/20 text-[#FF5F56]"
            }`}>
              {dashWsConnected ? <Wifi className="w-3 h-3" /> : <WifiOff className="w-3 h-3" />}
              {dashWsConnected ? "LIVE FEED" : "DISCONNECTED"}
            </div>

            {isRetrying && (
              <div className="flex items-center gap-2 px-3 py-1 bg-[#8B5CF6]/10 rounded-full border border-[#8B5CF6]/30 animate-pulse">
                <Flame className="w-3 h-3 text-[#8B5CF6]" />
                <span className="text-[#8B5CF6] text-xs font-bold tracking-wide">
                  RETRYING WITH VALIDATION FEEDBACK · {iterationCount}/3
                </span>
              </div>
            )}

          </div>
        </header>

        <div className="p-5 md:p-8 overflow-y-auto min-h-[calc(100vh-64px)] xl:h-[calc(100vh-64px)]">
          {/* ── ENGINE TAB ── */}
          {activeTab === "engine" && (
            <div className="animate-fade-in-up max-w-7xl mx-auto grid grid-cols-1 xl:grid-cols-12 gap-6 xl:gap-8 min-h-[620px]">
              <div className="xl:col-span-7 flex flex-col gap-6">
                <div className="rounded-2xl border border-white/10 bg-[#0A0A0A] p-5 shadow-xl space-y-4">
                  <div>
                    <p className="text-white font-semibold">Create a repair proposal</p>
                    <p className="text-xs text-white/45 mt-1">Give Bluefist the incident details and the exact Python file to inspect.</p>
                  </div>
                  <label className="block text-xs text-white/60">GitHub repository URL
                    <input type="url" value={repoUrl} onChange={(e) => setRepoUrl(e.target.value)} placeholder="https://github.com/owner/repository" className="mt-1 w-full bg-black/40 border border-white/10 rounded-xl px-4 py-3 text-white font-mono text-sm focus:outline-none focus:border-[#10B981]" />
                  </label>
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                    <label className="block text-xs text-white/60">Target Python file
                      <input type="text" value={filePath} onChange={(e) => setFilePath(e.target.value)} placeholder="src/service.py" className="mt-1 w-full bg-black/40 border border-white/10 rounded-xl px-4 py-3 text-white font-mono text-sm focus:outline-none focus:border-[#10B981]" />
                    </label>
                    <div className="flex items-end gap-3">
                  {agentStep === 6 || (agentStep === 0 && logs.length > 0) ? (
                    <button
                      onClick={resetEngine}
                      className="flex items-center gap-2 bg-white/10 text-white px-6 py-3 rounded-xl font-bold hover:bg-white/20 transition-all"
                    >
                      <RotateCcw className="w-4 h-4" /> Reset
                    </button>
                  ) : (
                      <button
                      onClick={triggerEngine}
                      disabled={isEngineActive}
                      className="flex items-center gap-2 bg-[#10B981] text-black px-6 py-3 rounded-xl font-bold hover:bg-[#059669] transition-all disabled:opacity-50 shadow-[0_0_20px_rgba(16,185,129,0.3)]"
                    >
                      <Play className="w-4 h-4" /> {isEngineActive ? "Preparing…" : "Prepare proposal"}
                    </button>
                  )}
                    </div>
                  </div>
                  <label className="block text-xs text-white/60">Error details or traceback
                    <textarea value={errorTrace} onChange={(e) => setErrorTrace(e.target.value)} maxLength={20000} rows={5} placeholder="Paste the relevant error, logs, or steps to reproduce. Remove secrets and personal data first." className="mt-1 w-full resize-y bg-black/40 border border-white/10 rounded-xl px-4 py-3 text-white font-mono text-xs leading-relaxed focus:outline-none focus:border-[#10B981]" />
                    <span className="mt-1 block text-right text-[10px] text-white/30">{errorTrace.length.toLocaleString()} / 20,000 characters</span>
                  </label>
                  <p className="rounded-lg border border-amber-400/20 bg-amber-400/5 px-3 py-2 text-[11px] leading-relaxed text-amber-100/70">Bluefist never executes generated code and does not run your repository’s tests. Production mode requires a locked-down Docker syntax check; local development falls back to a syntax parse if Docker is stopped. Review the full diff and run project tests before merging.</p>
                </div>

                <div className="flex-1 bg-[#050505] border border-white/10 rounded-2xl p-0 relative overflow-hidden shadow-[0_8px_30px_rgb(0,0,0,0.5)] flex flex-col h-[550px]">
                  <div className="w-full h-10 bg-[#0A0A0A] flex items-center px-4 gap-2 border-b border-white/10 shrink-0">
                    <div className="w-3 h-3 rounded-full bg-[#FF5F56]" />
                    <div className="w-3 h-3 rounded-full bg-[#FFBD2E]" />
                    <div className="w-3 h-3 rounded-full bg-[#27C93F]" />
                    <span className="text-xs ml-2 text-white/30 font-mono">bluefist · proposal stream</span>
                  </div>
                  <div className="p-6 overflow-y-auto font-mono text-[13px] leading-relaxed scrollbar-hide h-full">
                    {logs.length === 0 ? (
                      <div className="h-full flex flex-col items-center justify-center text-white/10">
                        <Terminal className="w-16 h-16 mb-4 opacity-50" />
                        <p>Awaiting target repository injection...</p>
                      </div>
                    ) : (
                      logs.map((log, i) => (
                        <div
                          key={i}
                          className={`${
                            log.includes("❌") || log.includes("FATAL")
                              ? "text-[#FF5F56]"
                              : log.includes("✅") || log.includes("SUCCESS")
                              ? "text-[#10B981]"
                              : log.includes("⚠️") || log.includes("DETECTOR")
                              ? "text-[#FFBD2E]"
                              : log.includes("🧠") || log.includes("ITERATION")
                              ? "text-[#8B5CF6]"
                              : log.includes("🚨") || log.includes("FEEDBACK")
                              ? "text-[#FF5F56] font-bold"
                              : "text-white/70"
                          } whitespace-pre-wrap break-all mb-1`}
                        >
                          {log}
                        </div>
                      ))
                    )}
                    <div ref={logsEndRef} />
                  </div>
                </div>
              </div>

              <div className="xl:col-span-5 min-h-[540px] xl:h-[620px]">
                <div className="bg-[#0A0A0A] border border-white/10 p-6 rounded-2xl shadow-xl h-full flex flex-col relative overflow-hidden">
                  <div className="absolute inset-0 bg-[linear-gradient(rgba(255,255,255,0.02)_1px,transparent_1px),linear-gradient(90deg,rgba(255,255,255,0.02)_1px,transparent_1px)] bg-[size:20px_20px] pointer-events-none" />
                  <h2 className="text-white font-semibold mb-6 flex items-center justify-between border-b border-white/10 pb-4 relative z-10">
                    <div className="flex items-center gap-2">
                      <Cpu className="w-5 h-5 text-[#00F0FF]" /> Patch workflow
                    </div>
                    <span className="text-xs font-mono bg-white/5 px-2 py-1 rounded text-white/50">Iter: {iterationCount}/3</span>
                  </h2>
                  <div className="flex-1 mt-2 relative z-10 pl-4">
                    <div className="flex gap-4 relative mb-8">
                      <div className={`absolute left-5 top-10 bottom-[-32px] w-0.5 ${agentStep > 1 ? "bg-[#3B82F6]" : "bg-white/10"}`} />
                      <div className={`w-10 h-10 rounded-xl flex items-center justify-center shrink-0 border z-10 transition-all duration-500 ${agentStep === 1 ? "bg-[#3B82F6]/20 border-[#3B82F6] text-[#3B82F6] shadow-[0_0_15px_#3B82F6] animate-pulse" : agentStep > 1 ? "bg-[#3B82F6] border-[#3B82F6] text-black" : "bg-black border-white/10 text-white/30"}`}>
                        <Search className="w-5 h-5" />
                      </div>
                      <div>
                        <h4 className={`text-sm font-bold ${agentStep === 1 ? "text-white" : agentStep > 1 ? "text-white/80" : "text-white/40"}`}>1. Codebase Scanning</h4>
                        <p className="text-xs text-white/50 mt-1">Loading the selected file from GitHub</p>
                      </div>
                    </div>

                    <div className="flex gap-4 relative mb-8">
                      <div className={`absolute left-5 top-10 bottom-[-32px] w-0.5 ${agentStep > 2 ? "bg-[#FFBD2E]" : "bg-white/10"}`} />
                      <div className={`w-10 h-10 rounded-xl flex items-center justify-center shrink-0 border z-10 transition-all duration-500 ${agentStep === 2 ? "bg-[#FFBD2E]/20 border-[#FFBD2E] text-[#FFBD2E] shadow-[0_0_15px_#FFBD2E] animate-pulse" : agentStep > 2 ? "bg-[#FFBD2E] border-[#FFBD2E] text-black" : "bg-black border-white/10 text-white/30"}`}>
                        <AlertTriangle className="w-5 h-5" />
                      </div>
                      <div>
                        <h4 className={`text-sm font-bold ${agentStep === 2 ? "text-white" : agentStep > 2 ? "text-white/80" : "text-white/40"}`}>2. Incident context</h4>
                        <p className="text-xs text-white/50 mt-1">Using the traceback you supplied</p>
                      </div>
                    </div>

                    <div className="flex gap-4 relative mb-8">
                      <div className={`absolute left-5 top-10 bottom-[-32px] w-0.5 ${agentStep > 3 ? "bg-[#8B5CF6]" : "bg-white/10"}`} />
                      <div className={`w-10 h-10 rounded-xl flex items-center justify-center shrink-0 border z-10 transition-all duration-500 ${agentStep === 3 ? "bg-[#8B5CF6]/20 border-[#8B5CF6] text-[#8B5CF6] shadow-[0_0_20px_#8B5CF6] animate-pulse" : agentStep > 3 ? "bg-[#8B5CF6] border-[#8B5CF6] text-white" : "bg-black border-white/10 text-white/30"}`}>
                        <BrainCircuit className="w-5 h-5" />
                      </div>
                      <div>
                        <h4 className={`text-sm font-bold ${agentStep === 3 ? "text-white" : agentStep > 3 ? "text-white/80" : "text-white/40"}`}>3. Patch proposal</h4>
                        <p className="text-xs text-white/50 mt-1">A single Gemini model drafts the change</p>
                        {isRetrying && agentStep === 3 && (
                          <span className="text-[10px] text-[#FF5F56] font-bold uppercase mt-1 block">↑ Debugging previous failure</span>
                        )}
                      </div>
                    </div>

                    <div className="flex gap-4 relative mb-8">
                      <div className={`absolute left-5 top-10 bottom-[-32px] w-0.5 ${agentStep > 4 ? "bg-[#10B981]" : "bg-white/10"}`} />
                      <div className={`w-10 h-10 rounded-xl flex items-center justify-center shrink-0 border z-10 transition-all duration-500 ${agentStep === 4 ? "bg-[#00F0FF]/20 border-[#00F0FF] text-[#00F0FF] shadow-[0_0_15px_#00F0FF] animate-pulse" : agentStep > 4 ? "bg-[#00F0FF] border-[#00F0FF] text-black" : "bg-black border-white/10 text-white/30"}`}>
                        <Box className="w-5 h-5" />
                      </div>
                      <div>
                        <h4 className={`text-sm font-bold ${agentStep === 4 ? "text-white" : agentStep > 4 ? "text-white/80" : "text-white/40"}`}>4. Syntax validation</h4>
                        <p className="text-xs text-white/50 mt-1">AST syntax check only · never executes code</p>
                      </div>
                    </div>

                    <div className="flex gap-4 relative mb-2">
                      <div className={`w-10 h-10 rounded-xl flex items-center justify-center shrink-0 border z-10 transition-all duration-500 ${agentStep === 5 ? "bg-[#10B981]/20 border-[#10B981] text-[#10B981] shadow-[0_0_15px_#10B981] animate-pulse" : agentStep > 5 ? "bg-[#10B981] border-[#10B981] text-black shadow-[0_0_20px_#10B981]" : "bg-black border-white/10 text-white/30"}`}>
                        <GitBranch className="w-5 h-5" />
                      </div>
                      <div>
                        <h4 className={`text-sm font-bold ${agentStep === 5 ? "text-white" : agentStep > 5 ? "text-[#10B981]" : "text-white/40"}`}>5. Human approval</h4>
                        <p className="text-xs text-white/50 mt-1">Approval commits the patch to the default branch</p>
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          )}

          {/* ── TELEMETRY TAB ── */}
          {activeTab === "dashboard" && (
            <TelemetryTab events={telemetryEvents} summary={healthSummary} wsConnected={dashWsConnected} />
          )}

          {/* ── REPOS TAB ── */}
          {activeTab === "repos" && (
            <RepoTab targets={targets} onRegister={handleRegisterTarget} onDeregister={handleDeregisterTarget} isRegistering={isRegistering} registerError={registerError} />
          )}

        </div>
      </main>

      {/* Generic action toast */}
      {approvalToast && (
        <div className="fixed bottom-8 left-1/2 -translate-x-1/2 flex max-w-[calc(100vw-2rem)] flex-wrap items-center justify-center gap-x-3 gap-y-1 px-6 py-3 bg-[#0A0A0A] border border-white/20 rounded-2xl text-white text-sm font-mono shadow-2xl z-50 animate-fade-in-up text-center">
          <span>{approvalToast}</span>
          {approvalCommitUrl && (
            <a href={approvalCommitUrl} target="_blank" rel="noreferrer" className="text-[#10B981] underline underline-offset-4">
              View GitHub commit ↗
            </a>
          )}
        </div>
      )}
    </div>
  );
}
