"use client";

import { useState } from "react";
import { ChevronDown, ChevronRight, Plus } from "lucide-react";
import { api, ApiError } from "@/lib/api";
import { useAsync } from "@/lib/useControlPlane";
import { OrgPage } from "@/components/OrgPage";
import { EmptyState, ErrorNote, Spinner } from "@/components/primitives";
import type { Role, VaultConnection } from "@/lib/types";

function formatTtl(seconds: number): string {
  if (seconds % 3600 === 0) return `${seconds / 3600}h`;
  if (seconds % 60 === 0) return `${seconds / 60}m`;
  return `${seconds}s`;
}

function AddGrantForm({
  role,
  connections,
  onDone,
}: {
  role: Role;
  connections: VaultConnection[];
  onDone: () => void;
}) {
  const [connectionId, setConnectionId] = useState(connections[0]?.id ?? "");
  const [pathPattern, setPathPattern] = useState("");
  const [ttl, setTtl] = useState(900);
  const [error, setError] = useState<string | undefined>();
  const [saving, setSaving] = useState(false);

  const alias = connections.find((c) => c.id === connectionId)?.alias ?? "alias";

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setSaving(true);
    setError(undefined);
    try {
      await api.createGrant(role.id, {
        vaultConnectionId: connectionId,
        pathPattern: pathPattern.trim(),
        maxTtlSeconds: ttl,
      });
      onDone();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }

  return (
    <form onSubmit={submit} className="space-y-3 border-t border-white/5 bg-ink-950/40 p-4">
      <div className="grid gap-3 sm:grid-cols-3">
        <div>
          <label className="label mb-1.5 block" htmlFor={`conn-${role.id}`}>
            Vault
          </label>
          <select
            id={`conn-${role.id}`}
            className="field"
            value={connectionId}
            onChange={(e) => setConnectionId(e.target.value)}
          >
            {connections.map((c) => (
              <option key={c.id} value={c.id}>
                {c.alias}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label className="label mb-1.5 block" htmlFor={`pattern-${role.id}`}>
            Path pattern
          </label>
          <input
            id={`pattern-${role.id}`}
            className="field"
            placeholder="prod/db/*"
            value={pathPattern}
            onChange={(e) => setPathPattern(e.target.value)}
          />
        </div>
        <div>
          <label className="label mb-1.5 block" htmlFor={`ttl-${role.id}`}>
            Max credential lifetime
          </label>
          <select
            id={`ttl-${role.id}`}
            className="field"
            value={ttl}
            onChange={(e) => setTtl(Number(e.target.value))}
          >
            <option value={300}>5 minutes</option>
            <option value={900}>15 minutes</option>
            <option value={3600}>1 hour</option>
          </select>
        </div>
      </div>

      <p className="text-xs text-slate-600">
        Authorizes{" "}
        <code className="font-mono text-slate-400">
          sec://{alias}/{pathPattern || "…"}
        </code>
        . Patterns match exactly, or as a <code className="font-mono">prefix/*</code>, or{" "}
        <code className="font-mono">*</code> for everything in this vault.
      </p>

      {error ? <ErrorNote message={error} /> : null}

      <div className="flex gap-2">
        <button className="btn-primary !py-1.5 text-xs" type="submit" disabled={saving || !pathPattern.trim()}>
          {saving ? "Adding…" : "Add grant"}
        </button>
        <button className="btn-ghost !py-1.5 text-xs" type="button" onClick={onDone}>
          Cancel
        </button>
      </div>
    </form>
  );
}

function RoleRow({
  role,
  connections,
  orgId,
}: {
  role: Role;
  connections: VaultConnection[];
  orgId: string;
}) {
  const [open, setOpen] = useState(false);
  const [addingGrant, setAddingGrant] = useState(false);
  const grants = useAsync(() => (open ? api.listGrants(role.id) : Promise.resolve([])), [role.id, open]);
  const aliasFor = (id: string) => connections.find((c) => c.id === id)?.alias ?? "unknown";

  return (
    <li>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="flex w-full items-center gap-2 px-5 py-3 text-left hover:bg-white/5"
      >
        {open ? (
          <ChevronDown className="h-4 w-4 text-slate-600" aria-hidden />
        ) : (
          <ChevronRight className="h-4 w-4 text-slate-600" aria-hidden />
        )}
        <span className="text-sm text-slate-200">{role.name}</span>
      </button>

      {open ? (
        <div className="border-t border-white/5 bg-ink-950/30">
          {grants.loading ? (
            <Spinner />
          ) : grants.error ? (
            <div className="p-4">
              <ErrorNote message={grants.error} />
            </div>
          ) : grants.data?.length ? (
            <ul className="divide-y divide-white/5">
              {grants.data.map((g) => (
                <li key={g.id} className="flex items-center justify-between gap-4 px-5 py-2.5">
                  {/* The grant reads as the reference it authorizes - the
                      same string an engineer puts in their .env. */}
                  <code className="ref text-signal-400">
                    sec://{aliasFor(g.vault_connection_id)}/{g.path_pattern}
                  </code>
                  <span className="shrink-0 font-mono text-xs text-slate-600">
                    ≤ {formatTtl(g.max_ttl_seconds)}
                  </span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="px-5 py-4 text-sm text-slate-600">
              No grants yet — this role can&apos;t expand anything.
            </p>
          )}

          {addingGrant ? (
            <AddGrantForm
              role={role}
              connections={connections}
              onDone={() => {
                setAddingGrant(false);
                grants.reload();
              }}
            />
          ) : (
            <div className="border-t border-white/5 px-5 py-2.5">
              <button
                className="btn-ghost !py-1.5 text-xs"
                onClick={() => setAddingGrant(true)}
                disabled={connections.length === 0}
                title={connections.length === 0 ? "Connect a vault first" : undefined}
              >
                <Plus className="h-3.5 w-3.5" aria-hidden />
                Add grant
              </button>
            </div>
          )}
        </div>
      ) : null}
    </li>
  );
}

export default function RolesPage() {
  return (
    <OrgPage
      title="Roles & grants"
      description="A role is what a service identity is allowed to expand. Grants scope it to specific references."
    >
      {(orgId) => <RolesBody orgId={orgId} />}
    </OrgPage>
  );
}

function RolesBody({ orgId }: { orgId: string }) {
  const roles = useAsync(() => api.listRoles(orgId), [orgId]);
  const connections = useAsync(() => api.listConnections(orgId), [orgId]);
  const [newRole, setNewRole] = useState("");
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | undefined>();

  async function createRole(event: React.FormEvent) {
    event.preventDefault();
    setError(undefined);
    try {
      await api.createRole(orgId, newRole.trim());
      setNewRole("");
      setCreating(false);
      roles.reload();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
    }
  }

  return (
    <section className="panel">
      <div className="panel-header">
        <h2 className="text-sm font-medium text-slate-200">
          Roles
          {roles.data ? (
            <span className="ml-2 font-mono text-xs text-slate-600">{roles.data.length}</span>
          ) : null}
        </h2>
        {!creating ? (
          <button className="btn-ghost !py-1.5 text-xs" onClick={() => setCreating(true)}>
            <Plus className="h-3.5 w-3.5" aria-hidden />
            New role
          </button>
        ) : null}
      </div>

      {creating ? (
        <form onSubmit={createRole} className="flex gap-2 border-b border-white/5 p-4">
          <input
            className="field"
            placeholder="ci-deploy"
            value={newRole}
            onChange={(e) => setNewRole(e.target.value)}
            aria-label="Role name"
            autoFocus
          />
          <button className="btn-primary shrink-0" type="submit" disabled={!newRole.trim()}>
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

      {roles.loading || connections.loading ? (
        <Spinner />
      ) : roles.error ? (
        <div className="p-5">
          <ErrorNote message={roles.error} />
        </div>
      ) : roles.data?.length ? (
        <ul className="divide-y divide-white/5">
          {roles.data.map((role) => (
            <RoleRow key={role.id} role={role} connections={connections.data ?? []} orgId={orgId} />
          ))}
        </ul>
      ) : !creating ? (
        <EmptyState
          title="No roles yet."
          hint="A role groups the references a set of service identities may expand — like ci-deploy, or backend-prod."
          action={
            <button className="btn-primary" onClick={() => setCreating(true)}>
              <Plus className="h-4 w-4" aria-hidden />
              New role
            </button>
          }
        />
      ) : null}
    </section>
  );
}
