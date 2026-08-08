"use client";

import { useEffect, useState, useRef, useCallback } from "react";
import {
  Terminal, GitBranch, Activity, ShieldAlert, MessageSquare,
  LayoutDashboard, Cpu, Play, AlertTriangle, Search, BrainCircuit,
  Box, GitPullRequest, RotateCcw, Flame, Wifi, WifiOff, Eye,
  CheckCircle2, XCircle, Clock, Plus, Trash2, Globe, Radio,
  ChevronDown, ChevronUp, Zap, Server, TrendingUp, Shield, CreditCard
} from "lucide-react";

// ─────────────────────────────────────────────────────────────────────────────
// CONSTANTS
// ─────────────────────────────────────────────────────────────────────────────
const API_BASE  = "http://localhost:8000";
const WS_BASE   = "ws://localhost:8000";

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
  file_path?: string;
  patch_preview?: string;
  full_patch?: string;
  original_code?: string;
  logs_tail?: string[];
  pr_url?: string;
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
    deployed:    { color: "text-[#10B981] border-[#10B981]/40 bg-[#10B981]/10", label: "DEPLOYED"    },
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
            Authorize Patch
          </button>
        </div>
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
                  {ev.pr_url           && ` → ${ev.pr_url}`}
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
  const [fieldErrors, setFieldErrors] = useState<Partial<MonitorTarget>>({});

  const validate = (): boolean => {
    const errs: Partial<Record<keyof MonitorTarget, string>> = {};
    if (!form.target_id.trim())    errs.target_id    = "Required";
    if (!form.repo_url.trim())     errs.repo_url     = "Required";
    if (!form.endpoint_url.trim()) errs.endpoint_url = "Required";
    if (form.check_interval < 15)  errs.check_interval = "Min 15 s" as unknown as number;
    setFieldErrors(errs as Partial<MonitorTarget>);
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
function PricingTab() {
  const [isYearly, setIsYearly] = useState(true);

  const plans = [
    {
      name: "Developer",
      tagline: "For individual builders and open-source maintainers.",
      monthlyPrice: 0,
      yearlyPrice: 0,
      badge: "Free Forever",
      highlight: false,
      features: [
        "Up to 50 AI-TDD Fixes / mo",
        "Single GitHub Repository",
        "Local Circuit Breaker Engine (Ollama)",
        "Basic AST Context Parser",
        "Community Discord Support",
      ],
      cta: "Get Started Free",
    },
    {
      name: "Team & Startup",
      tagline: "For growing dev teams requiring autonomous incident remediation.",
      monthlyPrice: 3499,
      yearlyPrice: 2799,
      badge: "Most Popular",
      highlight: true,
      features: [
        "Up to 1,000 AI-TDD Fixes / mo",
        "Up to 10 Repositories",
        "Cross-File AST Call-Graph Tracing",
        "Automated PyTest Suite Synthesis",
        "GitHub Actions & Webhook Integration",
        "Twilio & WhatsApp Incident Alerts",
        "Priority Support (4-hour SLA)",
      ],
      cta: "Start 14-Day Free Trial",
    },
    {
      name: "Enterprise SRE",
      tagline: "For mission-critical infrastructure requiring zero-trust security.",
      monthlyPrice: 14999,
      yearlyPrice: 11999,
      badge: "Zero-Trust Ready",
      highlight: false,
      features: [
        "Unlimited AI-TDD Hotfixes",
        "Unlimited Repositories & Microservices",
        "Skyflow Zero-Trust PII / Secret Vault",
        "Custom LLM Routing (Gemini, Claude, Self-Hosted)",
        "Role-Based Access Control (RBAC) & Audit Logs",
        "Dedicated SRE Account Manager",
        "99.99% Uptime Guarantee (SLA)",
      ],
      cta: "Contact Enterprise Sales",
    },
  ];

  return (
    <div className="max-w-7xl mx-auto space-y-12 animate-fade-in-up pb-16">
      <div className="text-center max-w-3xl mx-auto pt-8">
        <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-[#10B981]/10 border border-[#10B981]/30 text-[#10B981] text-xs font-semibold tracking-wide uppercase mb-4 shadow-[0_0_15px_rgba(16,185,129,0.15)]">
          🛡️ Enterprise-Grade Reliability
        </div>
        <h1 className="text-4xl sm:text-5xl font-extrabold tracking-tight bg-gradient-to-r from-white via-slate-200 to-slate-400 bg-clip-text text-transparent">
          Predictable Pricing for Autonomous SRE
        </h1>
        <p className="mt-4 text-white/50 text-lg">
          Stop burning engineer hours on manual hotfixes. Choose a plan that scales with your codebase.
        </p>

        <div className="mt-8 flex justify-center items-center gap-4">
          <span className={`text-sm font-medium ${!isYearly ? "text-white" : "text-white/40"}`}>
            Monthly Billing
          </span>
          <button
            onClick={() => setIsYearly(!isYearly)}
            className="relative w-14 h-8 rounded-full bg-[#0A0A0A] p-1 transition-colors duration-200 border border-white/10 focus:outline-none"
          >
            <div
              className={`w-6 h-6 rounded-full bg-[#10B981] shadow-md transform transition-transform duration-200 ${
                isYearly ? "translate-x-6" : "translate-x-0"
              }`}
            />
          </button>
          <span className={`text-sm font-medium flex items-center gap-2 ${isYearly ? "text-white" : "text-white/40"}`}>
            Yearly Billing
            <span className="bg-[#10B981]/20 text-[#10B981] border border-[#10B981]/30 text-[10px] font-bold px-2 py-0.5 rounded-full uppercase">
              Save 20%
            </span>
          </span>
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-8 items-stretch">
        {plans.map((plan, index) => {
          const price = isYearly ? plan.yearlyPrice : plan.monthlyPrice;

          return (
            <div
              key={index}
              className={`relative flex flex-col justify-between rounded-2xl p-8 transition-all duration-300 ${
                plan.highlight
                  ? "bg-[#0A0A0A]/90 border-2 border-[#10B981]/60 shadow-[0_0_35px_rgba(16,185,129,0.15)] scale-105 z-10"
                  : "bg-[#0A0A0A]/40 border border-white/10 hover:border-white/20 hover:bg-[#0A0A0A]/60"
              }`}
            >
              {plan.badge && (
                <div className="absolute -top-3.5 left-1/2 -translate-x-1/2">
                  <span
                    className={`px-3 py-1 rounded-full text-xs font-bold tracking-wider uppercase shadow-md ${
                      plan.highlight
                        ? "bg-[#10B981] text-black"
                        : "bg-[#050505] border border-white/10 text-white/80"
                    }`}
                  >
                    {plan.badge}
                  </span>
                </div>
              )}

              <div>
                <h3 className="text-2xl font-bold text-white mb-2">{plan.name}</h3>
                <p className="text-white/50 text-sm min-h-[40px]">{plan.tagline}</p>

                <div className="my-6 flex items-baseline gap-1">
                  <span className="text-4xl font-extrabold text-white">
                    ₹{price.toLocaleString("en-IN")}
                  </span>
                  <span className="text-white/40 text-sm font-medium">
                    {price === 0 ? "" : "/ month"}
                  </span>
                </div>

                <hr className="border-white/10 my-6" />

                <ul className="space-y-3.5 mb-8">
                  {plan.features.map((feature, idx) => (
                    <li key={idx} className="flex items-start gap-3 text-sm text-white/70">
                      <svg
                        className="w-5 h-5 text-[#10B981] shrink-0 mt-0.5"
                        fill="none"
                        stroke="currentColor"
                        viewBox="0 0 24 24"
                      >
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2.5" d="M5 13l4 4L19 7" />
                      </svg>
                      <span>{feature}</span>
                    </li>
                  ))}
                </ul>
              </div>

              <button
                className={`w-full py-3.5 px-6 rounded-xl font-bold text-sm tracking-wide transition-all duration-200 ${
                  plan.highlight
                    ? "bg-[#10B981] hover:bg-[#059669] text-black shadow-[0_0_20px_rgba(16,185,129,0.4)]"
                    : "bg-[#050505] hover:bg-white/5 text-white border border-white/10"
                }`}
              >
                {plan.cta}
              </button>
            </div>
          );
        })}
      </div>

      <div className="max-w-4xl mx-auto mt-16 text-center border border-white/10 rounded-2xl p-6 bg-[#0A0A0A]/40 backdrop-blur-sm">
        <div className="flex flex-wrap justify-around items-center gap-6 text-white/50 text-xs font-semibold uppercase tracking-wider">
          <div className="flex items-center gap-2">
            <span className="text-[#10B981] text-lg">⚡</span> Instant Setup in 2 Minutes
          </div>
          <div className="flex items-center gap-2">
            <span className="text-[#10B981] text-lg">🛡️</span> Circuit Breaker Failover Included
          </div>
          <div className="flex items-center gap-2">
            <span className="text-[#10B981] text-lg">💳</span> Cancel or Upgrade Anytime
          </div>
        </div>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// MAIN APPLICATION
// ─────────────────────────────────────────────────────────────────────────────
export default function BluefistEnterprise() {

  // ── Tab state ──────────────────────────────────────────────────────────────
  const [activeTab, setActiveTab] = useState<"engine" | "dashboard" | "repos" | "pricing">("engine");

  // ── Ghost Terminal ─────────────────────────────────────────────────────────
  const [repoUrl, setRepoUrl]               = useState("https://github.com/akshat/checkout-service");
  const [logs, setLogs]                     = useState<string[]>([]);
  const [isEngineActive, setIsEngineActive] = useState(false);
  const [showWhatsApp, setShowWhatsApp]     = useState(false);
  const [agentStep, setAgentStep]           = useState(0);
  const [iterationCount, setIterationCount] = useState(1);
  const [isCriticActive, setIsCriticActive] = useState(false);

  // ── Dashboard WebSocket ────────────────────────────────────────────────────
  const [dashWsConnected, setDashWsConnected] = useState(false);
  const [telemetryEvents, setTelemetryEvents] = useState<TelemetryEvent[]>([]);
  const [healthSummary, setHealthSummary]     = useState<Record<string, TargetHealth>>({});

  // ── Approval gate ──────────────────────────────────────────────────────────
  const [pendingApprovals, setPendingApprovals]       = useState<PendingApproval[]>([]);
  const [activeModal, setActiveModal]                 = useState<PendingApproval | null>(null);
  const [isSubmittingApproval, setIsSubmittingApproval] = useState(false);
  const [approvalToast, setApprovalToast]             = useState<string | null>(null);

  // ── Target registry ────────────────────────────────────────────────────────
  const [targets, setTargets]           = useState<MonitorTarget[]>([]);
  const [isRegistering, setIsRegistering] = useState(false);
  const [registerError, setRegisterError] = useState<string | null>(null);

  // ── Refs ───────────────────────────────────────────────────────────────────
  const logsEndRef = useRef<HTMLDivElement>(null);
  const wsRef      = useRef<WebSocket | null>(null);
  const dashWsRef  = useRef<WebSocket | null>(null);

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
    if (dashWsRef.current?.readyState === WebSocket.OPEN) return;

    const ws = new WebSocket(`${WS_BASE}/ws/dashboard`);
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
          pr_url:        msg.pr_url,
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
            repo_url:      "",
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
        }

        if (msg.type === "deploy_complete") {
          setApprovalToast(`✅ Patch deployed! PR: ${msg.pr_url ?? "—"}`);
          setPendingApprovals((prev) =>
            prev.map((p) =>
              p.approval_id === msg.approval_id
                ? { ...p, status: "deployed" }
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
      setTimeout(connectDashboardWs, 5000);
    };

    ws.onerror = () => ws.close();
  }, []);

  useEffect(() => {
    connectDashboardWs();
    return () => { dashWsRef.current?.close(); };
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
    if (!repoUrl) return;
    setIsEngineActive(true);
    setAgentStep(1);
    setIterationCount(1);
    setIsCriticActive(false);
    setShowWhatsApp(false);
    setLogs(["🚀 [SYSTEM] Initializing BLUEFIST Reflexive Execution Engine..."]);

    const ws = new WebSocket(`${WS_BASE}/ws/ghost-terminal`);
    wsRef.current = ws;

    ws.onopen = () => ws.send(JSON.stringify({ repo_url: repoUrl }));

    ws.onmessage = (event) => {
      const data: string = event.data;
      setLogs((prev) => [...prev, data]);

      if (data.includes("Connecting to GitHub") || data.includes("Extracted Abstract")) {
        setAgentStep(1);
      } else if (data.includes("Anomaly detected")) {
        setAgentStep(2);
      } else if (data.includes("Synthesizing patch")) {
        setAgentStep(3);
        setIsCriticActive(false);
      } else if (data.includes("Running verification sequence")) {
        setAgentStep(4);
      } else if (
        data.includes("Sandbox rejected patch") ||
        data.includes("[FEEDBACK LOOP]")
      ) {
        setIsCriticActive(true);
        setIterationCount((prev) => prev + 1);
        setAgentStep(3);
      } else if (data.includes("Creating feature branch")) {
        setAgentStep(5);
      } else if (data.includes("Pull Request established")) {
        setAgentStep(6);
        setTimeout(() => setShowWhatsApp(true), 1500);
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
    setIsCriticActive(false);
    setShowWhatsApp(false);
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
    try {
      const res = await fetch(`${API_BASE}/approvals/decide`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
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
      setActiveModal(null);
      setApprovalToast(
        decision === "approve"
          ? "🚀 Patch authorized — deploying to GitHub..."
          : "❌ Patch rejected — anomaly logged."
      );
    } catch (err) {
      setApprovalToast(`⚠️ Request failed: ${err}`);
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
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify(target),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.detail ?? `HTTP ${res.status}`);
      }
      const data = await res.json();
      setTargets((prev) => [...prev, target]);
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
    <div className="flex h-screen bg-[#050505] text-[#A1A1AA] font-sans overflow-hidden selection:bg-[#10B981] selection:text-black">

      {/* Emergency approval modal */}
      {activeModal && (
        <ApprovalModal
          approval={activeModal as PendingApproval & Partial<TelemetryEvent>}
          onDecide={handleApprovalDecision}
          isSubmitting={isSubmittingApproval}
        />
      )}

      {/* ─────────────── SIDEBAR ─────────────── */}
      <aside className="w-64 border-r border-white/10 bg-[#0A0A0A] flex flex-col justify-between z-20 shadow-2xl shrink-0">
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

            {/* ADDED PRICING TAB BUTTON */}
            <button
              onClick={() => setActiveTab("pricing")}
              className={`w-full flex items-center gap-3 px-4 py-3 rounded-lg text-sm font-medium transition-all ${
                activeTab === "pricing" ? "bg-white/10 text-white shadow-sm" : "hover:bg-white/5"
              }`}
            >
              <CreditCard className="w-4 h-4" /> Plans & Pricing
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
              <p className="text-white text-xs font-bold">Akshat Upadhyay</p>
              <p className="text-[10px] text-[#10B981] font-mono mt-0.5">ADMIN_ROOT</p>
            </div>
          </div>
        </div>
      </aside>

      {/* ─────────────── MAIN ─────────────── */}
      <main className="flex-1 flex flex-col relative bg-[radial-gradient(ellipse_at_top_right,_var(--tw-gradient-stops))] from-[#10B981]/5 via-[#050505] to-[#050505]">

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

            {isCriticActive && (
              <div className="flex items-center gap-2 px-3 py-1 bg-[#8B5CF6]/10 rounded-full border border-[#8B5CF6]/30 animate-pulse">
                <Flame className="w-3 h-3 text-[#8B5CF6]" />
                <span className="text-[#8B5CF6] text-xs font-bold tracking-wide">
                  CRITIC LOOP ACTIVE (Iter {iterationCount})
                </span>
              </div>
            )}

            <div className="flex items-center gap-2 px-3 py-1 bg-[#10B981]/10 rounded-full border border-[#10B981]/20">
              <PulsingDot color="#10B981" />
              <span className="text-[#10B981] text-xs font-bold tracking-wide">SYSTEM ONLINE</span>
            </div>
          </div>
        </header>

        <div className="p-8 overflow-y-auto h-[calc(100vh-64px)]">
          {/* ── ENGINE TAB ── */}
          {activeTab === "engine" && (
            <div className="animate-fade-in-up max-w-7xl mx-auto grid grid-cols-12 gap-8 h-full min-h-[620px]">
              <div className="col-span-7 flex flex-col gap-6">
                <div className="flex gap-4">
                  <input
                    type="text"
                    value={repoUrl}
                    onChange={(e) => setRepoUrl(e.target.value)}
                    className="flex-1 bg-[#0A0A0A] border border-white/10 rounded-xl px-4 text-white font-mono text-sm focus:outline-none focus:border-[#10B981] transition-all shadow-inner"
                  />
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
                      <Play className="w-4 h-4" /> Execute Target
                    </button>
                  )}
                </div>

                <div className="flex-1 bg-[#050505] border border-white/10 rounded-2xl p-0 relative overflow-hidden shadow-[0_8px_30px_rgb(0,0,0,0.5)] flex flex-col h-[550px]">
                  <div className="w-full h-10 bg-[#0A0A0A] flex items-center px-4 gap-2 border-b border-white/10 shrink-0">
                    <div className="w-3 h-3 rounded-full bg-[#FF5F56]" />
                    <div className="w-3 h-3 rounded-full bg-[#FFBD2E]" />
                    <div className="w-3 h-3 rounded-full bg-[#27C93F]" />
                    <span className="text-xs ml-2 text-white/30 font-mono">root@bluefist-agent:~</span>
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

              <div className="col-span-5 h-[620px]">
                <div className="bg-[#0A0A0A] border border-white/10 p-6 rounded-2xl shadow-xl h-full flex flex-col relative overflow-hidden">
                  <div className="absolute inset-0 bg-[linear-gradient(rgba(255,255,255,0.02)_1px,transparent_1px),linear-gradient(90deg,rgba(255,255,255,0.02)_1px,transparent_1px)] bg-[size:20px_20px] pointer-events-none" />
                  <h2 className="text-white font-semibold mb-6 flex items-center justify-between border-b border-white/10 pb-4 relative z-10">
                    <div className="flex items-center gap-2">
                      <Cpu className="w-5 h-5 text-[#00F0FF]" /> Reflexive State Machine
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
                        <p className="text-xs text-white/50 mt-1">Cloning target & extracting AST</p>
                      </div>
                    </div>

                    <div className="flex gap-4 relative mb-8">
                      <div className={`absolute left-5 top-10 bottom-[-32px] w-0.5 ${agentStep > 2 ? "bg-[#FFBD2E]" : "bg-white/10"}`} />
                      <div className={`w-10 h-10 rounded-xl flex items-center justify-center shrink-0 border z-10 transition-all duration-500 ${agentStep === 2 ? "bg-[#FFBD2E]/20 border-[#FFBD2E] text-[#FFBD2E] shadow-[0_0_15px_#FFBD2E] animate-pulse" : agentStep > 2 ? "bg-[#FFBD2E] border-[#FFBD2E] text-black" : "bg-black border-white/10 text-white/30"}`}>
                        <AlertTriangle className="w-5 h-5" />
                      </div>
                      <div>
                        <h4 className={`text-sm font-bold ${agentStep === 2 ? "text-white" : agentStep > 2 ? "text-white/80" : "text-white/40"}`}>2. Context Slicing</h4>
                        <p className="text-xs text-white/50 mt-1">Isolating runtime anomaly</p>
                      </div>
                    </div>

                    <div className="flex gap-4 relative mb-8">
                      <div className={`absolute left-5 top-10 bottom-[-32px] w-0.5 ${agentStep > 3 ? "bg-[#8B5CF6]" : "bg-white/10"}`} />
                      <div className={`w-10 h-10 rounded-xl flex items-center justify-center shrink-0 border z-10 transition-all duration-500 ${agentStep === 3 ? "bg-[#8B5CF6]/20 border-[#8B5CF6] text-[#8B5CF6] shadow-[0_0_20px_#8B5CF6] animate-pulse" : agentStep > 3 ? "bg-[#8B5CF6] border-[#8B5CF6] text-white" : "bg-black border-white/10 text-white/30"}`}>
                        <BrainCircuit className="w-5 h-5" />
                      </div>
                      <div>
                        <h4 className={`text-sm font-bold ${agentStep === 3 ? "text-white" : agentStep > 3 ? "text-white/80" : "text-white/40"}`}>3. Swarm Synthesis</h4>
                        <p className="text-xs text-white/50 mt-1">Gemini 2.5 generating patch</p>
                        {isCriticActive && agentStep === 3 && (
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
                        <h4 className={`text-sm font-bold ${agentStep === 4 ? "text-white" : agentStep > 4 ? "text-white/80" : "text-white/40"}`}>4. Isothermal Sandbox</h4>
                        <p className="text-xs text-white/50 mt-1">Testing for Exit Code 0</p>
                      </div>
                    </div>

                    <div className="flex gap-4 relative mb-2">
                      <div className={`w-10 h-10 rounded-xl flex items-center justify-center shrink-0 border z-10 transition-all duration-500 ${agentStep === 5 ? "bg-[#10B981]/20 border-[#10B981] text-[#10B981] shadow-[0_0_15px_#10B981] animate-pulse" : agentStep > 5 ? "bg-[#10B981] border-[#10B981] text-black shadow-[0_0_20px_#10B981]" : "bg-black border-white/10 text-white/30"}`}>
                        <GitPullRequest className="w-5 h-5" />
                      </div>
                      <div>
                        <h4 className={`text-sm font-bold ${agentStep === 5 ? "text-white" : agentStep > 5 ? "text-[#10B981]" : "text-white/40"}`}>5. Git Deployment</h4>
                        <p className="text-xs text-white/50 mt-1">Pushing verified PR to remote</p>
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

          {/* ── PRICING TAB ── */}
          {activeTab === "pricing" && (
            <PricingTab />
          )}
        </div>
      </main>

      {/* Twilio WhatsApp toast */}
      {showWhatsApp && (
        <div className="fixed bottom-8 right-8 w-80 bg-[#128C7E] text-white p-4 rounded-2xl shadow-[0_20px_50px_rgba(37,211,102,0.3)] animate-fade-in-up flex gap-4 items-start border border-[#25D366]/30 z-50">
          <div className="bg-white/20 p-2 rounded-full shrink-0">
            <MessageSquare className="w-5 h-5 text-white" />
          </div>
          <div>
            <p className="text-sm font-bold mb-1">Twilio System Alert</p>
            <p className="text-xs leading-relaxed text-white/90">
              🚨 Incident Resolved: Patch verified with <span className="font-bold text-[#25D366]">Exit Code 0</span> in sandbox.
              <br /><br />
              <span className="underline font-bold cursor-pointer hover:text-white/80 transition-colors">View Pull Request →</span>
            </p>
          </div>
        </div>
      )}

      {/* Generic action toast */}
      {approvalToast && (
        <div className="fixed bottom-8 left-1/2 -translate-x-1/2 px-6 py-3 bg-[#0A0A0A] border border-white/20 rounded-full text-white text-sm font-mono shadow-2xl z-50 animate-fade-in-up whitespace-nowrap">
          {approvalToast}
        </div>
      )}
    </div>
  );
}