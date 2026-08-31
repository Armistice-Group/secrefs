"use client";

import { RefreshCw } from "lucide-react";
import { api } from "@/lib/api";
import { useAsync } from "@/lib/useControlPlane";
import { OrgPage } from "@/components/OrgPage";
import { DecisionPill, EmptyState, ErrorNote, Spinner } from "@/components/primitives";

export default function AuditPage() {
  return (
    <OrgPage
      title="Audit log"
      description="Every expansion this control plane authorized or refused, and why."
    >
      {(orgId) => <AuditBody orgId={orgId} />}
    </OrgPage>
  );
}

function AuditBody({ orgId }: { orgId: string }) {
  // An admin session isn't tied to one org the way a machine token is,
  // so the org is passed explicitly - see the control plane's audit route.
  const events = useAsync(() => api.listAuditEvents(orgId), [orgId]);

  return (
    <section className="panel">
      <div className="panel-header">
        <h2 className="text-sm font-medium text-slate-200">
          Decisions
          {events.data ? (
            <span className="ml-2 font-mono text-xs text-slate-600">{events.data.length}</span>
          ) : null}
        </h2>
        <button className="btn-ghost !py-1.5 text-xs" onClick={() => events.reload()}>
          <RefreshCw className="h-3.5 w-3.5" aria-hidden />
          Refresh
        </button>
      </div>

      {events.loading ? (
        <Spinner />
      ) : events.error ? (
        <div className="p-5">
          <ErrorNote message={events.error} />
        </div>
      ) : events.data?.length ? (
        <ul className="divide-y divide-white/5">
          {events.data.map((event) => (
            <li key={event.id} className="px-5 py-3">
              <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                <DecisionPill decision={event.decision} />
                <code className="ref text-slate-200">
                  sec://{event.alias}/{event.path}
                </code>
                <time
                  className="ml-auto shrink-0 font-mono text-xs text-slate-600"
                  dateTime={event.requested_at}
                >
                  {event.requested_at}
                </time>
              </div>
              {event.reason ? (
                <p className="mt-1 text-xs text-warn-400">{event.reason}</p>
              ) : null}
            </li>
          ))}
        </ul>
      ) : (
        <EmptyState
          title="Nothing has been expanded yet."
          hint="Once a service identity resolves a sec:// reference, every allow and deny shows up here with the reason."
        />
      )}
    </section>
  );
}
