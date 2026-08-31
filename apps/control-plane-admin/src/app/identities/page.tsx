"use client";

import { useState } from "react";
import { KeyRound, Plus, ShieldCheck } from "lucide-react";
import { api, ApiError } from "@/lib/api";
import { useAsync, useControlPlaneConfig } from "@/lib/useControlPlane";
import { OrgPage } from "@/components/OrgPage";
import { CopyButton, EmptyState, ErrorNote, Spinner } from "@/components/primitives";
import type { Role, ServiceIdentityWithToken } from "@/lib/types";

/** The token is returned exactly once, by the create call. This is the
 * only place it will ever be visible, so the screen says so plainly
 * rather than letting someone navigate away and find out later. */
function TokenReveal({ identity, onDismiss }: { identity: ServiceIdentityWithToken; onDismiss: () => void }) {
  return (
    <div className="border-b border-signal-500/20 bg-signal-500/[0.06] p-5">
      <div className="mb-2 flex items-center gap-2 text-sm font-medium text-signal-400">
        <KeyRound className="h-4 w-4" aria-hidden />
        Bootstrap token for {identity.name}
      </div>
      <p className="mb-3 text-sm text-slate-400">
        Copy this now — it is not stored and cannot be shown again. Set it as{" "}
        <code className="font-mono text-slate-300">SECREFS_CONTROL_PLANE_TOKEN</code> wherever this
        identity runs.
      </p>
      <div className="flex items-center gap-2">
        <code className="ref flex-1 overflow-x-auto rounded border border-white/10 bg-ink-950/70 px-3 py-2 text-signal-400">
          {identity.bootstrapToken}
        </code>
        <CopyButton value={identity.bootstrapToken} label="Copy token" />
      </div>
      <button className="btn-ghost mt-3 !py-1.5 text-xs" onClick={onDismiss}>
        I&apos;ve saved it
      </button>
    </div>
  );
}

function AddOidcBindingForm({ identityId, onDone }: { identityId: string; onDone: () => void }) {
  const [issuer, setIssuer] = useState("https://token.actions.githubusercontent.com");
  const [subjectPattern, setSubjectPattern] = useState("");
  const [error, setError] = useState<string | undefined>();
  const [saving, setSaving] = useState(false);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setSaving(true);
    setError(undefined);
    try {
      await api.createOidcBinding(identityId, { issuer: issuer.trim(), subjectPattern: subjectPattern.trim() });
      onDone();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }

  return (
    <form onSubmit={submit} className="space-y-3 border-t border-white/5 bg-ink-950/40 p-4">
      <div className="grid gap-3 sm:grid-cols-2">
        <div>
          <label className="label mb-1.5 block" htmlFor={`issuer-${identityId}`}>
            Issuer
          </label>
          <input
            id={`issuer-${identityId}`}
            className="field"
            value={issuer}
            onChange={(e) => setIssuer(e.target.value)}
          />
        </div>
        <div>
          <label className="label mb-1.5 block" htmlFor={`subject-${identityId}`}>
            Subject pattern
          </label>
          <input
            id={`subject-${identityId}`}
            className="field"
            placeholder="repo:acme/api:ref:refs/heads/main"
            value={subjectPattern}
            onChange={(e) => setSubjectPattern(e.target.value)}
          />
        </div>
      </div>
      <p className="text-xs text-slate-600">
        Lets a CI job authenticate with its own OIDC token instead of a stored bootstrap token — no
        long-lived secret to leak. Matched against the token&apos;s <code className="font-mono">sub</code>{" "}
        claim.
      </p>
      {error ? <ErrorNote message={error} /> : null}
      <div className="flex gap-2">
        <button className="btn-primary !py-1.5 text-xs" type="submit" disabled={saving || !subjectPattern.trim()}>
          {saving ? "Trusting…" : "Trust this identity"}
        </button>
        <button className="btn-ghost !py-1.5 text-xs" type="button" onClick={onDone}>
          Cancel
        </button>
      </div>
    </form>
  );
}

export default function IdentitiesPage() {
  return (
    <OrgPage
      title="Service identities"
      description="The machines — CI jobs, running services — that expand references at runtime."
    >
      {(orgId) => <IdentitiesBody orgId={orgId} />}
    </OrgPage>
  );
}

function IdentitiesBody({ orgId }: { orgId: string }) {
  const identities = useAsync(() => api.listServiceIdentities(orgId), [orgId]);
  const roles = useAsync(() => api.listRoles(orgId), [orgId]);
  const { config } = useControlPlaneConfig();

  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState("");
  const [revealed, setRevealed] = useState<ServiceIdentityWithToken | undefined>();
  const [error, setError] = useState<string | undefined>();
  const [bindingFor, setBindingFor] = useState<string | undefined>();
  const [assigning, setAssigning] = useState<string | undefined>();

  async function createIdentity(event: React.FormEvent) {
    event.preventDefault();
    setError(undefined);
    try {
      const created = await api.createServiceIdentity(orgId, newName.trim());
      setRevealed(created);
      setNewName("");
      setCreating(false);
      identities.reload();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
    }
  }

  async function assignRole(identityId: string, role: Role) {
    setError(undefined);
    try {
      await api.bindIdentityToRole(role.id, identityId);
      setAssigning(undefined);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
    }
  }

  return (
    <section className="panel">
      <div className="panel-header">
        <h2 className="text-sm font-medium text-slate-200">
          Identities
          {identities.data ? (
            <span className="ml-2 font-mono text-xs text-slate-600">{identities.data.length}</span>
          ) : null}
        </h2>
        {!creating ? (
          <button className="btn-ghost !py-1.5 text-xs" onClick={() => setCreating(true)}>
            <Plus className="h-3.5 w-3.5" aria-hidden />
            New identity
          </button>
        ) : null}
      </div>

      {revealed ? <TokenReveal identity={revealed} onDismiss={() => setRevealed(undefined)} /> : null}

      {creating ? (
        <form onSubmit={createIdentity} className="flex gap-2 border-b border-white/5 p-4">
          <input
            className="field"
            placeholder="ci-deploy-bot"
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            aria-label="Identity name"
            autoFocus
          />
          <button className="btn-primary shrink-0" type="submit" disabled={!newName.trim()}>
            Create
          </button>
          <button className="btn-ghost shrink-0" type="button" onClick={() => setCreating(false)}>
            Cancel
          </button>
        </form>
      ) : null}

      {error ? (
        <div className="p-4">
          <ErrorNote message={error} />
        </div>
      ) : null}

      {identities.loading ? (
        <Spinner />
      ) : identities.error ? (
        <div className="p-5">
          <ErrorNote message={identities.error} />
        </div>
      ) : identities.data?.length ? (
        <ul className="divide-y divide-white/5">
          {identities.data.map((identity) => (
            <li key={identity.id}>
              <div className="flex items-center justify-between gap-4 px-5 py-3">
                <div className="min-w-0">
                  <p className="text-sm text-slate-200">{identity.name}</p>
                  <p className="ref truncate text-xs text-slate-600">{identity.id}</p>
                </div>
                <div className="flex shrink-0 gap-2">
                  <button
                    className="btn-ghost !py-1.5 text-xs"
                    onClick={() => setAssigning(assigning === identity.id ? undefined : identity.id)}
                    disabled={!roles.data?.length}
                    title={!roles.data?.length ? "Create a role first" : undefined}
                  >
                    <ShieldCheck className="h-3.5 w-3.5" aria-hidden />
                    Assign role
                  </button>
                  {config?.oidcEnabled ? (
                    <button
                      className="btn-ghost !py-1.5 text-xs"
                      onClick={() => setBindingFor(bindingFor === identity.id ? undefined : identity.id)}
                    >
                      Trust OIDC
                    </button>
                  ) : null}
                </div>
              </div>

              {assigning === identity.id ? (
                <div className="flex flex-wrap gap-2 border-t border-white/5 bg-ink-950/40 px-5 py-3">
                  {roles.data?.map((role) => (
                    <button
                      key={role.id}
                      className="btn-ghost !py-1.5 text-xs"
                      onClick={() => assignRole(identity.id, role)}
                    >
                      {role.name}
                    </button>
                  ))}
                </div>
              ) : null}

              {bindingFor === identity.id ? (
                <AddOidcBindingForm identityId={identity.id} onDone={() => setBindingFor(undefined)} />
              ) : null}
            </li>
          ))}
        </ul>
      ) : !creating ? (
        <EmptyState
          title="No service identities yet."
          hint="Each CI job or service that expands references gets its own identity, so the audit log shows which one asked."
          action={
            <button className="btn-primary" onClick={() => setCreating(true)}>
              <Plus className="h-4 w-4" aria-hidden />
              New identity
            </button>
          }
        />
      ) : null}
    </section>
  );
}
