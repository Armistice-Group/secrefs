"use client";

import { AlertTriangle, Check, Copy, Loader2 } from "lucide-react";
import { useState } from "react";

export function Spinner({ label }: { label?: string }) {
  return (
    <div className="flex items-center gap-2 px-5 py-8 text-sm text-slate-500">
      <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
      {label ?? "Loading…"}
    </div>
  );
}

/** Errors state what went wrong and, where the cause is knowable, what to
 * do about it - the API client already puts the actionable part in the
 * message (see api.ts's network/CORS case). */
export function ErrorNote({ message }: { message: string }) {
  return (
    <div
      role="alert"
      className="flex items-start gap-2.5 rounded-md border border-deny-400/30 bg-deny-400/5 px-4 py-3 text-sm text-deny-400"
    >
      <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
      <span>{message}</span>
    </div>
  );
}

/** An empty screen is an invitation to act, so every one of these takes
 * the action that fills it rather than just saying "nothing here". */
export function EmptyState({
  title,
  hint,
  action,
}: {
  title: string;
  hint: string;
  action?: React.ReactNode;
}) {
  return (
    <div className="flex flex-col items-center gap-3 px-5 py-12 text-center">
      <p className="text-sm text-slate-400">{title}</p>
      <p className="max-w-sm text-sm text-slate-600">{hint}</p>
      {action ? <div className="mt-1">{action}</div> : null}
    </div>
  );
}

export function CopyButton({ value, label }: { value: string; label?: string }) {
  const [copied, setCopied] = useState(false);

  return (
    <button
      type="button"
      className="btn-ghost !px-2.5 !py-1.5 text-xs"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(value);
          setCopied(true);
          setTimeout(() => setCopied(false), 1600);
        } catch {
          // Clipboard is permission-gated and unavailable over plain HTTP
          // on some browsers; the value is selectable on screen either way.
        }
      }}
    >
      {copied ? <Check className="h-3.5 w-3.5 text-signal-400" aria-hidden /> : <Copy className="h-3.5 w-3.5" aria-hidden />}
      {copied ? "Copied" : (label ?? "Copy")}
    </button>
  );
}

export function ProviderBadge({ provider }: { provider: string }) {
  return (
    <span className="rounded border border-white/10 bg-white/5 px-1.5 py-0.5 font-mono text-[11px] uppercase tracking-wide text-slate-400">
      {provider}
    </span>
  );
}

/** Decisions encode in shape as well as color - a filled dot for allow, a
 * hollow ring for deny - so the log stays readable without relying on
 * color alone. */
export function DecisionPill({ decision }: { decision: "allow" | "deny" }) {
  const allow = decision === "allow";
  return (
    <span
      className={`inline-flex items-center gap-1.5 font-mono text-[11px] uppercase tracking-wider ${
        allow ? "text-signal-400" : "text-deny-400"
      }`}
    >
      <span
        aria-hidden
        className={`h-1.5 w-1.5 rounded-full ${
          allow ? "bg-signal-400" : "border border-deny-400 bg-transparent"
        }`}
      />
      {decision}
    </span>
  );
}
