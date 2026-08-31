"use client";

import { Suspense } from "react";
import { useSearchParams } from "next/navigation";
import Link from "next/link";
import { ConsoleShell } from "./ConsoleShell";
import { Spinner } from "./primitives";
import { api } from "@/lib/api";
import { useAsync } from "@/lib/useControlPlane";

function MissingOrg() {
  return (
    <div className="mx-auto max-w-md px-6 py-24 text-center">
      <p className="text-sm text-slate-400">No organization selected.</p>
      <Link href="/" className="btn-primary mt-4 inline-flex">
        Choose an organization
      </Link>
    </div>
  );
}

function OrgPageInner({
  title,
  description,
  children,
}: {
  title: string;
  description: string;
  children: (orgId: string) => React.ReactNode;
}) {
  const orgId = useSearchParams().get("org");
  if (!orgId) return <MissingOrg />;
  return (
    <OrgPageWithOrg orgId={orgId} title={title} description={description}>
      {children}
    </OrgPageWithOrg>
  );
}

function OrgPageWithOrg({
  orgId,
  title,
  description,
  children,
}: {
  orgId: string;
  title: string;
  description: string;
  children: (orgId: string) => React.ReactNode;
}) {
  // Best-effort: a failed lookup just leaves the sidebar showing the id,
  // it never blocks the screen the admin actually came for.
  const org = useAsync(() => api.getOrganization(orgId).catch(() => undefined), [orgId]);

  return (
    <ConsoleShell orgId={orgId} orgName={org.data?.name}>
      <header className="mb-5">
        <h1 className="text-base font-semibold text-slate-100">{title}</h1>
        <p className="mt-0.5 text-sm text-slate-500">{description}</p>
      </header>
      {children(orgId)}
    </ConsoleShell>
  );
}

/** Every console screen is the same shape: read `?org=`, render the shell,
 * hand the org id to the screen body. `useSearchParams` needs a Suspense
 * boundary under static export, so it lives here once rather than in
 * four screens. */
export function OrgPage(props: {
  title: string;
  description: string;
  children: (orgId: string) => React.ReactNode;
}) {
  return (
    <Suspense fallback={<Spinner />}>
      <OrgPageInner {...props} />
    </Suspense>
  );
}
