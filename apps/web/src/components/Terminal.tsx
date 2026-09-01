import type React from "react";

/**
 * The terminal-window frame used across the site. Extracted from page.tsx
 * so the vendor page renders identical chrome rather than a near-copy that
 * drifts.
 */
export function TerminalWindow({
  title,
  children,
  className = "",
}: {
  title: string;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={`terminal ${className}`}>
      <div className="terminal-header">
        <span className="terminal-dot bg-[#ff5f56]" />
        <span className="terminal-dot bg-[#ffbd2e]" />
        <span className="terminal-dot bg-[#27c93f]" />
        <span className="ml-3 text-xs text-slate-400">{title}</span>
      </div>
      <div className="overflow-x-auto p-4 font-mono text-[13px] leading-relaxed sm:text-sm">
        {children}
      </div>
    </div>
  );
}

export function Line({ children, dim }: { children: React.ReactNode; dim?: boolean }) {
  return <div className={dim ? "text-slate-500" : "text-slate-200"}>{children}</div>;
}

export function Prompt({ children }: { children: React.ReactNode }) {
  return (
    <div className="prompt text-slate-200">
      <span>{children}</span>
    </div>
  );
}
