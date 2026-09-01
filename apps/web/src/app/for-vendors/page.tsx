import type { Metadata } from "next";
import {
  ArrowRight,
  Ban,
  Clock,
  Database,
  FileWarning,
  Mail,
  RefreshCw,
  ShieldOff,
  Trash2,
} from "lucide-react";
import SiteHeader from "@/components/SiteHeader";
import { TerminalWindow, Line } from "@/components/Terminal";

export const metadata: Metadata = {
  title: "SecRefs for vendors - stop storing your customers' API keys",
  description:
    "Accept a sec:// reference instead of a customer's API key. Resolve it at use time. A breach of your database leaks pointers, not live credentials.",
  openGraph: {
    title: "SecRefs for vendors",
    description:
      "Accept a reference instead of a key. Your database stops being a place customer credentials live.",
    url: "https://secrefs.com/for-vendors",
    siteName: "SecRefs",
    type: "website",
  },
};

const NAV_LINKS = [
  { href: "/#how-it-works", label: "How it works" },
  { href: "/#providers", label: "Providers" },
  { href: "/#sandbox", label: "Sandbox" },
  { href: "/for-vendors", label: "For vendors" },
];

const OUTCOMES = [
  {
    icon: ShieldOff,
    title: "A breach leaks pointers",
    body: "A dump of your integrations table is a list of references. Without the customer's authorization, a reference resolves to nothing. It is not a credential, and it cannot be replayed.",
  },
  {
    icon: RefreshCw,
    title: "Rotation stops breaking you",
    body: "Today, a customer rotating a key silently breaks their integration and opens a support ticket blaming you. A reference survives rotation - the name is stable, the value underneath it moves.",
  },
  {
    icon: Trash2,
    title: "Offboarding is theirs, not yours",
    body: "\"Please confirm you have deleted our API key\" becomes a question they answer themselves by revoking the grant. You stop being the custodian of something you never wanted to hold.",
  },
  {
    icon: FileWarning,
    title: "The questionnaire answer changes",
    body: "\"How do you store customer credentials?\" is the question that stalls enterprise deals. Answering \"we don't\" - and being able to show it - is worth more than any control you could describe.",
  },
];

const COSTS = [
  {
    icon: Clock,
    title: "A round trip before use",
    body: "Resolving at use time puts a network call in front of the customer's API call. Cacheable within a bounded window if you accept the staleness, but it is not free, and we will hold ourselves to a published latency budget rather than hand-wave it.",
  },
  {
    icon: Ban,
    title: "A dependency in your critical path",
    body: "If the control plane is unreachable, resolution fails and so does your integration. That is a real operational coupling and it belongs in a contract, not a footnote.",
  },
  {
    icon: Database,
    title: "The value passes through us",
    body: "Responses are encrypted to a public key you enrol, so the plaintext never reaches a log, a load balancer, or anything else that terminates TLS. But resolving still means fetching from your customer's vault into our memory - so the honest claim is a smaller exposure window, not zero. Code execution on our resolve path would still see it.",
  },
];

export default function ForVendorsPage() {
  return (
    <div className="relative min-h-screen overflow-hidden">
      <div className="pointer-events-none absolute inset-0 bg-grid bg-grid [mask-image:radial-gradient(ellipse_60%_50%_at_50%_0%,black,transparent)]" />

      <SiteHeader links={NAV_LINKS} />

      {/* Hero */}
      <section className="relative z-10 mx-auto max-w-6xl px-6 pb-16 pt-20 sm:pt-24">
        <div className="mb-6 inline-flex items-center gap-2 rounded-full border border-signal-500/20 bg-signal-500/5 px-3 py-1 text-xs font-medium text-signal-400">
          For product teams that receive customer credentials
        </div>
        <h1 className="glow-text max-w-3xl text-balance text-4xl font-bold leading-[1.1] tracking-tight text-white sm:text-5xl">
          Your customers&apos; API keys are a liability you didn&apos;t ask for.
        </h1>
        <p className="mt-6 max-w-2xl text-lg leading-relaxed text-slate-400">
          Every integration that asks a customer to paste an API key makes your database a place
          other companies&apos; credentials live. You inherit the blast radius, the rotation
          support burden, and the questionnaire. SecRefs lets you accept a{" "}
          <code className="text-signal-400">sec://</code> reference instead, and resolve it at the
          moment you use it.
        </p>

        {/* Signature: what a dump of your integrations table actually contains. */}
        <div className="mt-12 grid gap-6 lg:grid-cols-2">
          <div className="rounded-xl border border-red-500/20 bg-red-500/[0.03] p-6">
            <div className="mb-4 text-sm font-semibold text-red-400">
              Your integrations table today
            </div>
            <TerminalWindow title="SELECT * FROM customer_integrations">
              <Line dim>customer_id | credential</Line>
              <Line dim>------------+----------------------------</Line>
              <Line>acme_corp | sk_live_51NxAb9Kq2mZ...</Line>
              <Line>globex | ghp_8Kd0sLpQm4vX1nR...</Line>
              <Line>initech | xoxb-4471-9920-jHqL...</Line>
            </TerminalWindow>
            <p className="mt-5 text-sm leading-relaxed text-slate-400">
              Every row is a live credential belonging to someone else. One dump and you are the
              subject of three other companies&apos; incident reports.
            </p>
          </div>

          <div className="rounded-xl border border-signal-500/20 bg-signal-500/[0.03] p-6">
            <div className="mb-4 text-sm font-semibold text-signal-400">
              Your integrations table with SecRefs
            </div>
            <TerminalWindow title="SELECT * FROM customer_integrations">
              <Line dim>customer_id | credential</Line>
              <Line dim>------------+----------------------------</Line>
              <Line>acme_corp | sec://acme/stripe#key</Line>
              <Line>globex | sec://globex/github#token</Line>
              <Line>initech | sec://initech/slack#bot</Line>
            </TerminalWindow>
            <p className="mt-5 text-sm leading-relaxed text-slate-400">
              Every row is a pointer. Resolving one requires an authorization the attacker
              doesn&apos;t have, and the customer can revoke yours without touching anyone
              else&apos;s.
            </p>
          </div>
        </div>
      </section>

      {/* Mechanic */}
      <section className="relative z-10 mx-auto max-w-6xl px-6 py-16">
        <h2 className="text-3xl font-bold tracking-tight text-white">What you actually change</h2>
        <p className="mt-4 max-w-2xl text-slate-400">
          One call, at the point where you already read the credential out of your own storage.
          Everything downstream of that line is unchanged.
        </p>

        <div className="mt-10 grid gap-6 lg:grid-cols-2">
          <TerminalWindow title="before.ts">
            <Line dim>{"// the key you stored at connect time"}</Line>
            <Line>{"const key = integration.credential;"}</Line>
            <div className="h-3" />
            <Line>{"await stripe(key).charges.create(...);"}</Line>
            <div className="h-4" />
            <Line dim>{"// you are holding a live credential"}</Line>
            <Line dim>{"// for as long as the row exists"}</Line>
          </TerminalWindow>

          <TerminalWindow title="after.ts">
            <Line dim>{"// the reference you stored at connect time"}</Line>
            <Line>{"const key = await secRefs.expandString("}</Line>
            <Line>{"  integration.credential"}</Line>
            <Line>{");"}</Line>
            <div className="h-3" />
            <Line>{"await stripe(key).charges.create(...);"}</Line>
            <div className="h-4" />
            <Line dim>{"// the value exists in memory, for this call"}</Line>
          </TerminalWindow>
        </div>

        <p className="mt-6 max-w-2xl text-sm leading-relaxed text-slate-500">
          A plain value passed to <code className="text-signal-400">expandString</code> comes back
          unchanged, so you can accept both and migrate customers gradually rather than flag-day
          your whole integration surface.
        </p>
        <p className="mt-3 max-w-2xl text-sm leading-relaxed text-slate-500">
          Enrolling also means registering a public key. Responses are sealed to it with{" "}
          <a
            href="https://www.rfc-editor.org/rfc/rfc9180"
            className="text-slate-400 underline decoration-slate-600 underline-offset-2 hover:text-white"
          >
            HPKE
          </a>
          , bound to the specific reference being resolved, so a response cannot be replayed as
          the answer to a different one. The SDK unseals it; your code sees a string.
        </p>
      </section>

      {/* Outcomes */}
      <section className="relative z-10 mx-auto max-w-6xl px-6 py-16">
        <h2 className="text-3xl font-bold tracking-tight text-white">What it buys you</h2>
        <div className="mt-10 grid gap-6 sm:grid-cols-2">
          {OUTCOMES.map((item) => (
            <div
              key={item.title}
              className="rounded-xl border border-white/10 bg-white/[0.02] p-6"
            >
              <item.icon className="h-6 w-6 text-signal-400" />
              <h3 className="mt-4 font-semibold text-white">{item.title}</h3>
              <p className="mt-2 text-sm leading-relaxed text-slate-400">{item.body}</p>
            </div>
          ))}
        </div>
      </section>

      {/* Costs - stated at the same volume as the benefits, deliberately. */}
      <section className="relative z-10 mx-auto max-w-6xl px-6 py-16">
        <h2 className="text-3xl font-bold tracking-tight text-white">What it costs you</h2>
        <p className="mt-4 max-w-2xl text-slate-400">
          Three real tradeoffs. If we only listed the upside, your security team would find these
          in the first review anyway, and rightly trust the rest of the page less.
        </p>
        <div className="mt-10 grid gap-6 lg:grid-cols-3">
          {COSTS.map((item) => (
            <div
              key={item.title}
              className="rounded-xl border border-amber-500/20 bg-amber-500/[0.02] p-6"
            >
              <item.icon className="h-6 w-6 text-amber-400" />
              <h3 className="mt-4 font-semibold text-white">{item.title}</h3>
              <p className="mt-2 text-sm leading-relaxed text-slate-400">{item.body}</p>
            </div>
          ))}
        </div>
      </section>

      {/* Status + CTA */}
      <section className="relative z-10 mx-auto max-w-6xl px-6 py-16">
        <div className="mx-auto max-w-3xl rounded-xl border border-white/10 bg-white/[0.02] p-8 sm:p-10">
          <div className="mb-4 inline-flex items-center gap-2 rounded-full border border-amber-500/25 bg-amber-500/5 px-3 py-1 text-xs font-medium text-amber-400">
            In design - not yet shipped
          </div>
          <h2 className="max-w-2xl text-balance text-3xl font-bold tracking-tight text-white">
            We are looking for the first vendor to build this with.
          </h2>
          <div className="mt-6 max-w-2xl space-y-4 text-slate-400">
            <p>
              The client libraries are shipped and in production use. Pass-through resolution -
              the part described on this page - is specified in full and deliberately unbuilt.
              Speculative security surface is the worst kind, so we are not writing the endpoint
              until a real integration is driving its shape.
            </p>
            <p>
              If your product asks customers for API keys and you would rather it didn&apos;t, we
              want to design the interface against your use case: your auth model, your latency
              budget, your revocation story. The specification is public and unflattering about
              its own tradeoffs - read it before you talk to us.
            </p>
          </div>
          <div className="mt-8 flex flex-wrap items-center gap-4">
            <a
              href="mailto:hello@secrefs.com?subject=SecRefs%20pass-through%20-%20design%20partner"
              className="flex items-center gap-2 rounded-md bg-signal-500 px-5 py-3 text-sm font-semibold text-ink-950 transition hover:bg-signal-400"
            >
              <Mail className="h-4 w-4" />
              Talk to us
            </a>
            <a
              href="https://github.com/Armistice-Group/secrefs/blob/main/docs/proxy-mode-design.md"
              className="flex items-center gap-2 rounded-md border border-white/15 px-5 py-3 text-sm font-semibold text-white transition hover:border-white/30"
            >
              Read the specification
              <ArrowRight className="h-4 w-4" />
            </a>
          </div>
        </div>
      </section>

      <footer className="relative z-10 border-t border-white/5">
        <div className="mx-auto flex max-w-6xl flex-col items-center justify-between gap-4 px-6 py-10 text-sm text-slate-500 sm:flex-row">
          <a href="/" className="font-mono text-slate-400 hover:text-white">
            secrefs.com
          </a>
          <div className="flex gap-6">
            <a href="https://github.com/Armistice-Group/secrefs" className="hover:text-white">
              GitHub
            </a>
            <a href="/#quickstart" className="hover:text-white">
              Docs
            </a>
            <span>MIT Licensed</span>
          </div>
        </div>
      </footer>
    </div>
  );
}
