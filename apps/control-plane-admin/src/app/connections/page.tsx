"use client";

import { useState } from "react";
import { Plus } from "lucide-react";
import { api, ApiError } from "@/lib/api";
import { useAsync } from "@/lib/useControlPlane";
import { OrgPage } from "@/components/OrgPage";
import { EmptyState, ErrorNote, ProviderBadge, Spinner } from "@/components/primitives";
import type { VaultProviderKind } from "@/lib/types";

function AddConnectionForm({ orgId, onDone }: { orgId: string; onDone: () => void }) {
  const [provider, setProvider] = useState<VaultProviderKind>("aws");
  const [alias, setAlias] = useState("");
  const [roleArn, setRoleArn] = useState("");
  const [region, setRegion] = useState("us-east-1");
  const [accessToken, setAccessToken] = useState("");
  const [bwOrgId, setBwOrgId] = useState("");
  const [error, setError] = useState<string | undefined>();
  const [saving, setSaving] = useState(false);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setSaving(true);
    setError(undefined);
    try {
      await api.createConnection({
        orgId,
        alias: alias.trim(),
        provider,
        credential:
          provider === "aws"
            ? { roleArn: roleArn.trim(), region: region.trim() }
            : {
                accessToken: accessToken.trim(),
                ...(bwOrgId.trim() ? { organizationId: bwOrgId.trim() } : {}),
              },
      });
      onDone();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }

  return (
    <form onSubmit={submit} className="space-y-4 border-t border-white/10 p-5">
      <div className="grid gap-4 sm:grid-cols-2">
        <div>
          <label className="label mb-1.5 block" htmlFor="provider">
            Vault
          </label>
          <select
            id="provider"
            className="field"
            value={provider}
            onChange={(e) => setProvider(e.target.value as VaultProviderKind)}
          >
            <option value="aws">AWS Secrets Manager</option>
            <option value="bitwarden">Bitwarden Secrets Manager</option>
          </select>
        </div>
        <div>
          <label className="label mb-1.5 block" htmlFor="alias">
            Alias
          </label>
          <input
            id="alias"
            className="field"
            placeholder="aws-prod"
            value={alias}
            onChange={(e) => setAlias(e.target.value)}
          />
          <p className="mt-1.5 text-xs text-slate-600">
            Used in references as{" "}
            <code className="font-mono text-slate-500">sec://{alias || "alias"}/…</code>
          </p>
        </div>
      </div>

      {provider === "aws" ? (
        <div className="grid gap-4 sm:grid-cols-2">
          <div>
            <label className="label mb-1.5 block" htmlFor="roleArn">
              Role ARN
            </label>
            <input
              id="roleArn"
              className="field"
              placeholder="arn:aws:iam::123456789012:role/SecRefs"
              value={roleArn}
              onChange={(e) => setRoleArn(e.target.value)}
            />
          </div>
          <div>
            <label className="label mb-1.5 block" htmlFor="region">
              Region
            </label>
            <input
              id="region"
              className="field"
              value={region}
              onChange={(e) => setRegion(e.target.value)}
            />
          </div>
        </div>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2">
          <div>
            <label className="label mb-1.5 block" htmlFor="accessToken">
              Machine account access token
            </label>
            <input
              id="accessToken"
              type="password"
              className="field"
              placeholder="0.xxxxx…"
              value={accessToken}
              onChange={(e) => setAccessToken(e.target.value)}
            />
          </div>
          <div>
            <label className="label mb-1.5 block" htmlFor="bwOrgId">
              Bitwarden organization ID <span className="normal-case text-slate-600">(optional)</span>
            </label>
            <input
              id="bwOrgId"
              className="field"
              value={bwOrgId}
              onChange={(e) => setBwOrgId(e.target.value)}
            />
            <p className="mt-1.5 text-xs text-slate-600">
              Only needed to address secrets by name instead of UUID.
            </p>
          </div>
        </div>
      )}

      <p className="text-xs text-slate-600">
        Stored encrypted. It is never returned by any read API, including to you — rotating means
        entering a new one, not reading this back.
      </p>

      {error ? <ErrorNote message={error} /> : null}

      <div className="flex gap-2">
        <button className="btn-primary" type="submit" disabled={saving || !alias.trim()}>
          {saving ? "Connecting…" : "Connect vault"}
        </button>
        <button className="btn-ghost" type="button" onClick={onDone}>
          Cancel
        </button>
      </div>
    </form>
  );
}

export default function ConnectionsPage() {
  return (
    <OrgPage
      title="Vault connections"
      description="The vaults this organization can expand sec:// references from."
    >
      {(orgId) => <ConnectionsBody orgId={orgId} />}
    </OrgPage>
  );
}

function ConnectionsBody({ orgId }: { orgId: string }) {
  const [adding, setAdding] = useState(false);
  const connections = useAsync(() => api.listConnections(orgId), [orgId]);

  return (
    <section className="panel">
      <div className="panel-header">
        <h2 className="text-sm font-medium text-slate-200">
          Connected vaults
          {connections.data ? (
            <span className="ml-2 font-mono text-xs text-slate-600">{connections.data.length}</span>
          ) : null}
        </h2>
        {!adding ? (
          <button className="btn-ghost !py-1.5 text-xs" onClick={() => setAdding(true)}>
            <Plus className="h-3.5 w-3.5" aria-hidden />
            Connect a vault
          </button>
        ) : null}
      </div>

      {connections.loading ? (
        <Spinner />
      ) : connections.error ? (
        <div className="p-5">
          <ErrorNote message={connections.error} />
        </div>
      ) : connections.data?.length ? (
        <table className="w-full">
          <thead className="border-b border-white/5">
            <tr>
              <th className="th">Alias</th>
              <th className="th">Vault</th>
              <th className="th">Reference prefix</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-white/5">
            {connections.data.map((c) => (
              <tr key={c.id}>
                <td className="td font-mono text-slate-200">{c.alias}</td>
                <td className="td">
                  <ProviderBadge provider={c.provider} />
                </td>
                <td className="td ref text-slate-500">sec://{c.alias}/…</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : !adding ? (
        <EmptyState
          title="No vaults connected yet."
          hint="Connect the vault you already store secrets in. SecRefs never copies the secrets — it brokers scoped access to them."
          action={
            <button className="btn-primary" onClick={() => setAdding(true)}>
              <Plus className="h-4 w-4" aria-hidden />
              Connect a vault
            </button>
          }
        />
      ) : null}

      {adding ? (
        <AddConnectionForm
          orgId={orgId}
          onDone={() => {
            setAdding(false);
            connections.reload();
          }}
        />
      ) : null}
    </section>
  );
}
