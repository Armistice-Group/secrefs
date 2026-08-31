"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { ArrowRight, Plus, Terminal } from "lucide-react";
import { api, ApiError, CONTROL_PLANE_URL } from "@/lib/api";
import { useAsync, useControlPlaneConfig } from "@/lib/useControlPlane";
import { ErrorNote, Spinner } from "@/components/primitives";

export default function OrganizationPicker() {
  const router = useRouter();
  const { config, error: configError } = useControlPlaneConfig();
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState("");
  const [createError, setCreateError] = useState<string | undefined>();

  // In no-auth mode there's no signed-in admin to scope this to, and the
  // control plane's GET /v1/organizations exists only to answer "which
  // orgs does *this admin* administer" - so it 400s without auth
  // configured. Fall back to asking for the org id directly, which is
  // the only thing that identifies an org in that mode anyway.
  const authRequired = config?.adminAuthRequired ?? false;
  const orgs = useAsync(
    () => (authRequired ? api.listOrganizations() : Promise.resolve([])),
    [authRequired],
  );

  const [manualOrgId, setManualOrgId] = useState("");

  async function createOrganization(event: React.FormEvent) {
    event.preventDefault();
    setCreateError(undefined);
    try {
      const org = await api.createOrganization(newName.trim());
      router.push(`/connections?org=${encodeURIComponent(org.id)}`);
    } catch (err) {
      setCreateError(err instanceof ApiError ? err.message : String(err));
    }
  }

  return (
    <div className="mx-auto flex min-h-screen max-w-2xl flex-col justify-center px-6 py-16">
      <div className="mb-8 flex items-center gap-2.5">
        <Terminal className="h-5 w-5 text-signal-500" aria-hidden />
        <h1 className="text-lg font-semibold text-slate-100">secrefs control plane</h1>
      </div>

      <p className="mb-6 text-sm text-slate-400">
        Connected to <code className="ref text-slate-300">{CONTROL_PLANE_URL}</code>
      </p>

      {configError ? (
        <ErrorNote message={configError} />
      ) : !config ? (
        <Spinner label="Checking control plane…" />
      ) : (
        <div className="space-y-4">
          {authRequired ? (
            <section className="panel">
              <div className="panel-header">
                <h2 className="text-sm font-medium text-slate-200">Your organizations</h2>
              </div>
              {orgs.loading ? (
                <Spinner />
              ) : orgs.error ? (
                <div className="p-5">
                  <ErrorNote message={orgs.error} />
                </div>
              ) : orgs.data?.length ? (
                <ul className="divide-y divide-white/5">
                  {orgs.data.map((org) => (
                    <li key={org.id}>
                      <button
                        type="button"
                        onClick={() => router.push(`/connections?org=${encodeURIComponent(org.id)}`)}
                        className="flex w-full items-center justify-between px-5 py-3.5 text-left hover:bg-white/5"
                      >
                        <span>
                          <span className="block text-sm text-slate-200">{org.name}</span>
                          <span className="ref text-xs text-slate-600">{org.id}</span>
                        </span>
                        <ArrowRight className="h-4 w-4 text-slate-600" aria-hidden />
                      </button>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="px-5 py-8 text-center text-sm text-slate-500">
                  You don&apos;t administer any organizations yet. Create one below.
                </p>
              )}
            </section>
          ) : (
            <section className="panel p-5">
              <h2 className="mb-1 text-sm font-medium text-slate-200">Open an organization</h2>
              <p className="mb-3 text-sm text-slate-500">
                This control plane has no admin auth configured, so there&apos;s no signed-in
                account to list organizations for. Enter an organization ID to manage it.
              </p>
              <form
                className="flex gap-2"
                onSubmit={(e) => {
                  e.preventDefault();
                  if (manualOrgId.trim()) {
                    router.push(`/connections?org=${encodeURIComponent(manualOrgId.trim())}`);
                  }
                }}
              >
                <input
                  className="field"
                  placeholder="00000000-0000-0000-0000-000000000000"
                  value={manualOrgId}
                  onChange={(e) => setManualOrgId(e.target.value)}
                  aria-label="Organization ID"
                />
                <button className="btn-primary shrink-0" type="submit" disabled={!manualOrgId.trim()}>
                  Open
                </button>
              </form>
            </section>
          )}

          <section className="panel p-5">
            {creating ? (
              <form onSubmit={createOrganization} className="space-y-3">
                <div>
                  <label className="label mb-1.5 block" htmlFor="org-name">
                    Organization name
                  </label>
                  <input
                    id="org-name"
                    className="field"
                    placeholder="Acme Corp"
                    value={newName}
                    onChange={(e) => setNewName(e.target.value)}
                    autoFocus
                  />
                </div>
                {createError ? <ErrorNote message={createError} /> : null}
                <div className="flex gap-2">
                  <button className="btn-primary" type="submit" disabled={!newName.trim()}>
                    Create organization
                  </button>
                  <button className="btn-ghost" type="button" onClick={() => setCreating(false)}>
                    Cancel
                  </button>
                </div>
              </form>
            ) : (
              <button className="btn-ghost" type="button" onClick={() => setCreating(true)}>
                <Plus className="h-4 w-4" aria-hidden />
                New organization
              </button>
            )}
          </section>
        </div>
      )}
    </div>
  );
}
