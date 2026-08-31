"use client";

import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";
import { KeyRound, ScrollText, ShieldCheck, Terminal, Users, Boxes } from "lucide-react";
import { useControlPlaneConfig } from "@/lib/useControlPlane";

const NAV = [
  { href: "/connections", label: "Connections", icon: Boxes },
  { href: "/roles", label: "Roles & grants", icon: ShieldCheck },
  { href: "/identities", label: "Service identities", icon: Users },
  { href: "/audit", label: "Audit log", icon: ScrollText },
];

/**
 * The standing indicator of *how this control plane authenticates*. It's
 * permanent rather than dismissible on purpose: running with management
 * endpoints open is a legitimate self-hosted mode, but it should never be
 * something an operator forgets is true.
 */
function AuthModeBanner() {
  const { config } = useControlPlaneConfig();
  if (!config || config.adminAuthRequired) return null;

  return (
    <div className="flex items-start gap-2.5 border-b border-warn-400/20 bg-warn-400/[0.07] px-6 py-2.5 text-xs text-warn-400">
      <KeyRound className="mt-px h-3.5 w-3.5 shrink-0" aria-hidden />
      <p>
        <span className="font-medium">Admin auth is off.</span> This control plane has no WorkOS
        configured, so anyone who can reach it can change these settings. Fine on a machine only you
        can reach — set <code className="font-mono">WORKOS_API_KEY</code> and{" "}
        <code className="font-mono">WORKOS_CLIENT_ID</code> before exposing it.
      </p>
    </div>
  );
}

export function ConsoleShell({
  orgId,
  orgName,
  children,
}: {
  orgId: string;
  orgName?: string;
  children: React.ReactNode;
}) {
  const pathname = usePathname();
  const params = useSearchParams();
  const { config } = useControlPlaneConfig();

  const withOrg = (href: string) => `${href}?org=${encodeURIComponent(orgId)}`;

  return (
    <div className="flex min-h-screen">
      <aside className="flex w-60 shrink-0 flex-col border-r border-white/10 bg-ink-900/40">
        <div className="border-b border-white/10 px-5 py-4">
          <Link href="/" className="flex items-center gap-2 text-sm font-semibold text-slate-100">
            <Terminal className="h-4 w-4 text-signal-500" aria-hidden />
            secrefs
          </Link>
          <p className="mt-0.5 text-xs text-slate-500">control plane</p>
        </div>

        <div className="border-b border-white/10 px-5 py-3.5">
          <p className="label">Organization</p>
          <p className="mt-1 truncate text-sm text-slate-200" title={orgName ?? orgId}>
            {orgName ?? "…"}
          </p>
          <Link
            href="/"
            className="mt-1 inline-block text-xs text-slate-500 underline-offset-2 hover:text-slate-300 hover:underline"
          >
            Switch organization
          </Link>
        </div>

        <nav className="flex flex-1 flex-col gap-0.5 p-3">
          {NAV.map(({ href, label, icon: Icon }) => {
            const active = pathname === href;
            return (
              <Link
                key={href}
                href={withOrg(href)}
                aria-current={active ? "page" : undefined}
                className={`flex items-center gap-2.5 rounded-md px-3 py-2 text-sm transition-colors ${
                  active
                    ? "bg-signal-500/10 font-medium text-signal-400"
                    : "text-slate-400 hover:bg-white/5 hover:text-slate-200"
                }`}
              >
                <Icon className="h-4 w-4" aria-hidden />
                {label}
              </Link>
            );
          })}
        </nav>

        <div className="border-t border-white/10 px-5 py-3 text-[11px] leading-relaxed text-slate-600">
          <p className="font-mono">
            {config?.adminAuthRequired ? "auth: workos" : "auth: none"}
          </p>
          <p className="font-mono">{config?.oidcEnabled ? "oidc: enabled" : "oidc: off"}</p>
        </div>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        <AuthModeBanner />
        <main className="min-w-0 flex-1 px-6 py-6" key={params.toString()}>
          {children}
        </main>
      </div>
    </div>
  );
}
