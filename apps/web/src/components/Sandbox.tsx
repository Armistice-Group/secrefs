"use client";

import { useMemo, useState } from "react";
import { AlertTriangle, CheckCircle2, Loader2, Play, ShieldCheck } from "lucide-react";
import { isSecretRef, parseSecretRef, SecRefParseError, type ParsedSecretRef } from "@secrefs/node/parser";

/**
 * A fully client-side, in-memory mock of each provider's backing store.
 * This is the ONLY place the sandbox "resolves" a value - there is no
 * server behind this component, and nothing here is a real vault. It
 * exists purely to demonstrate what `secrefs run` does to real providers,
 * using the exact same `sec://` parser SecRefs itself ships
 * (`@secrefs/node/parser`), reused here rather than reimplemented.
 */
export const MOCK_VAULT: Record<string, Record<string, Record<string, string> | string>> = {
  aws: {
    "prod/db": { password: "S3cur3-P@ss-mock-2024", user: "app_prod" },
    "prod/api-key": "ak_live_mock_9f8e7d6c5b4a",
  },
  vault: {
    "secret/data/stripe": { key: "sk_test_mock_51AbCdEf", webhook_secret: "whsec_mock_7788" },
  },
  local: {
    "mock-db": { password: "hunter2", user: "postgres" },
  },
};

const DEFAULT_ENV = `# Paste (or edit) a mock .env below, then hit Expand.
PORT=3000
DB_PASSWORD=sec://aws/prod/db#password
STRIPE_KEY=sec://vault/secret/data/stripe#key
LOCAL_DEV_PASSWORD=sec://local/mock-db#password
UNKNOWN_REF=sec://aws/does-not-exist#token
`;

type LineStatus = "plain" | "malformed" | "pending" | "resolved" | "error";

interface ParsedLine {
  key: string;
  rawValue: string;
  ref: ParsedSecretRef | null;
  parseError: string | null;
}

interface LineResult extends ParsedLine {
  status: LineStatus;
  resolvedValue?: string;
  errorMessage?: string;
}

export function parseEnvText(text: string): ParsedLine[] {
  const lines: ParsedLine[] = [];
  for (const rawLine of text.split("\n")) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const eqIndex = line.indexOf("=");
    if (eqIndex === -1) continue;

    const key = line.slice(0, eqIndex).trim();
    const rawValue = line.slice(eqIndex + 1).trim();
    if (!key) continue;

    if (!isSecretRef(rawValue)) {
      lines.push({ key, rawValue, ref: null, parseError: null });
      continue;
    }

    try {
      lines.push({ key, rawValue, ref: parseSecretRef(rawValue), parseError: null });
    } catch (err) {
      const message = err instanceof SecRefParseError ? err.reason : "invalid reference";
      lines.push({ key, rawValue, ref: null, parseError: message });
    }
  }
  return lines;
}

/** Simulates a network round-trip to a mock provider - never a real one. */
export function mockFetch(ref: ParsedSecretRef): Promise<string> {
  const delay = 250 + Math.random() * 500;
  return new Promise((resolve, reject) => {
    setTimeout(() => {
      const providerData = MOCK_VAULT[ref.provider];
      if (!providerData) {
        reject(new Error(`unknown provider "${ref.provider}" in this sandbox's mock data`));
        return;
      }
      const entry = providerData[ref.path];
      if (entry === undefined) {
        reject(new Error(`no mock entry for path "${ref.path}" under provider "${ref.provider}"`));
        return;
      }

      const raw = typeof entry === "string" ? entry : JSON.stringify(entry);
      if (!ref.field) {
        resolve(raw);
        return;
      }

      try {
        const parsed = typeof entry === "string" ? JSON.parse(raw) : entry;
        const value = (parsed as Record<string, unknown>)[ref.field];
        if (value === undefined) {
          reject(new Error(`field "${ref.field}" not found at "${ref.path}"`));
          return;
        }
        resolve(String(value));
      } catch {
        reject(new Error(`"${ref.path}" is not JSON, cannot extract field "${ref.field}"`));
      }
    }, delay);
  });
}

function StatusIcon({ status }: { status: LineStatus }) {
  switch (status) {
    case "pending":
      return <Loader2 className="h-4 w-4 animate-spin text-slate-400" />;
    case "resolved":
      return <CheckCircle2 className="h-4 w-4 text-signal-400" />;
    case "error":
    case "malformed":
      return <AlertTriangle className="h-4 w-4 text-amber-400" />;
    default:
      return <span className="h-4 w-4 rounded-full border border-slate-600" />;
  }
}

export default function Sandbox() {
  const [envText, setEnvText] = useState(DEFAULT_ENV);
  const [results, setResults] = useState<LineResult[] | null>(null);
  const [isRunning, setIsRunning] = useState(false);

  const parsedPreview = useMemo(() => parseEnvText(envText), [envText]);
  const refCount = parsedPreview.filter((l) => l.ref !== null).length;

  async function handleExpand() {
    setIsRunning(true);
    const lines = parseEnvText(envText);

    const initial: LineResult[] = lines.map((line) => ({
      ...line,
      status: line.parseError ? "malformed" : line.ref ? "pending" : "plain",
    }));
    setResults(initial);

    // Mirrors the real resolver: every reference resolves concurrently via
    // Promise.allSettled, so one failure never blocks the others.
    const refLines = lines
      .map((line, index) => ({ line, index }))
      .filter((entry): entry is { line: ParsedLine & { ref: ParsedSecretRef }; index: number } =>
        entry.line.ref !== null,
      );

    const settled = await Promise.allSettled(refLines.map(({ line }) => mockFetch(line.ref)));

    setResults((prev) => {
      if (!prev) return prev;
      const next = [...prev];
      settled.forEach((outcome, i) => {
        const targetIndex = refLines[i]?.index;
        if (targetIndex === undefined) return;
        next[targetIndex] =
          outcome.status === "fulfilled"
            ? { ...next[targetIndex]!, status: "resolved", resolvedValue: outcome.value }
            : {
                ...next[targetIndex]!,
                status: "error",
                errorMessage:
                  outcome.reason instanceof Error ? outcome.reason.message : String(outcome.reason),
              };
      });
      return next;
    });

    setIsRunning(false);
  }

  return (
    <div className="grid gap-6 lg:grid-cols-2">
      <div className="terminal flex flex-col">
        <div className="terminal-header justify-between">
          <div className="flex items-center gap-1.5">
            <span className="terminal-dot bg-[#ff5f56]" />
            <span className="terminal-dot bg-[#ffbd2e]" />
            <span className="terminal-dot bg-[#27c93f]" />
            <span className="ml-3 text-xs text-slate-400">.env</span>
          </div>
          <span className="text-xs text-slate-500">
            {refCount} sec:// reference{refCount === 1 ? "" : "s"} detected
          </span>
        </div>
        <textarea
          value={envText}
          onChange={(e) => {
            setEnvText(e.target.value);
            setResults(null);
          }}
          spellCheck={false}
          className="min-h-[280px] flex-1 resize-none bg-transparent p-4 font-mono text-[13px] leading-relaxed text-slate-200 outline-none sm:text-sm"
        />
        <div className="flex items-center justify-between border-t border-white/10 px-4 py-3">
          <div className="flex items-center gap-1.5 text-xs text-slate-500">
            <ShieldCheck className="h-3.5 w-3.5 text-signal-500/70" />
            Resolved entirely in your browser&apos;s memory. Nothing is sent over the network.
          </div>
          <button
            onClick={handleExpand}
            disabled={isRunning}
            className="flex shrink-0 items-center gap-2 rounded-md bg-signal-500 px-4 py-2 text-xs font-semibold text-ink-950 transition hover:bg-signal-400 disabled:cursor-not-allowed disabled:opacity-60"
          >
            {isRunning ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <Play className="h-3.5 w-3.5" />
            )}
            Expand
          </button>
        </div>
      </div>

      <div className="terminal flex flex-col">
        <div className="terminal-header">
          <span className="terminal-dot bg-[#ff5f56]" />
          <span className="terminal-dot bg-[#ffbd2e]" />
          <span className="terminal-dot bg-[#27c93f]" />
          <span className="ml-3 text-xs text-slate-400">resolved environment</span>
        </div>
        <div className="flex-1 space-y-1 overflow-y-auto p-4 font-mono text-[13px] sm:text-sm">
          {!results && (
            <p className="text-slate-500">
              Hit <span className="text-signal-400">Expand</span> to simulate resolving every{" "}
              <code>sec://</code> reference above.
            </p>
          )}
          {results?.map((line, i) => (
            <div key={`${line.key}-${i}`} className="rounded-md px-2 py-1.5 hover:bg-white/[0.03]">
              <div className="flex items-start gap-2">
                <div className="mt-0.5">
                  <StatusIcon status={line.status} />
                </div>
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-baseline gap-x-2">
                    <span className="text-slate-300">{line.key}=</span>
                    {line.status === "resolved" && (
                      <span className="break-all text-signal-400">{line.resolvedValue}</span>
                    )}
                    {line.status === "plain" && (
                      <span className="break-all text-slate-400">{line.rawValue}</span>
                    )}
                    {line.status === "pending" && (
                      <span className="break-all text-slate-500">{line.rawValue}</span>
                    )}
                    {(line.status === "error" || line.status === "malformed") && (
                      <span className="break-all text-slate-600 line-through">{line.rawValue}</span>
                    )}
                  </div>
                  {line.status === "error" && (
                    <p className="mt-0.5 text-xs text-amber-400">{line.errorMessage}</p>
                  )}
                  {line.status === "malformed" && (
                    <p className="mt-0.5 text-xs text-amber-400">Invalid reference: {line.parseError}</p>
                  )}
                </div>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
