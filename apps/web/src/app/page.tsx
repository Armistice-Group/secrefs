import {
  ArrowRight,
  Boxes,
  Check,
  Cloud,
  Github,
  KeyRound,
  Lock,
  Server,
  Share2,
  Shield,
  ShieldCheck,
  Terminal as TerminalIcon,
  Workflow,
  X,
} from "lucide-react";
import Sandbox from "@/components/Sandbox";
import SiteHeader from "@/components/SiteHeader";
import { TerminalWindow, Line, Prompt } from "@/components/Terminal";

const PROVIDERS = [
  {
    icon: Cloud,
    name: "AWS Secrets Manager",
    alias: "sec://aws/prod/db#password",
    detail: "Ambient AWS credentials or an IAM role - never a static key in your config.",
  },
  {
    icon: Server,
    name: "HashiCorp Vault",
    alias: "sec://vault/kv/stripe#key",
    detail: "KV v1 & v2, authenticated via VAULT_ADDR / VAULT_TOKEN already in your environment.",
  },
  {
    icon: Shield,
    name: "Bitwarden Secrets Manager",
    alias: "sec://bitwarden/stripe-key",
    detail:
      "End-to-end encrypted, decrypted client-side via a machine account token. Address a secret by name or UUID. Self-hosted instances supported.",
  },
  {
    icon: KeyRound,
    name: "Local (dev only)",
    alias: "sec://local/mock-db#password",
    detail: "A gitignored .secrefs.local.json for teammates who don't have vault access yet.",
  },
];

const NAV_LINKS = [
  { href: "#how-it-works", label: "How it works" },
  { href: "#providers", label: "Providers" },
  { href: "#sandbox", label: "Sandbox" },
  { href: "/for-vendors", label: "For vendors" },
];

const HOW_IT_WORKS = [
  {
    step: "01",
    title: "Write a reference, not a value",
    description:
      'Put sec://aws/prod/db#password in .env instead of the plaintext password. It\'s safe to commit.',
  },
  {
    step: "02",
    title: "Run your app through secrefs",
    description: "secrefs run -- node server.js intercepts your environment before your app boots.",
  },
  {
    step: "03",
    title: "References resolve in memory",
    description:
      "Every sec:// value is fetched from its real vault concurrently, entirely in the CLI's memory.",
  },
  {
    step: "04",
    title: "Your process gets real values",
    description:
      "The child process inherits a fully-hydrated environment. Nothing was ever written to disk - and a reference resolved at use time picks up a rotation without a restart.",
  },
];

export default function HomePage() {
  return (
    <div className="relative min-h-screen overflow-hidden">
      <div className="pointer-events-none absolute inset-0 bg-grid bg-grid [mask-image:radial-gradient(ellipse_60%_50%_at_50%_0%,black,transparent)]" />

      <SiteHeader links={NAV_LINKS} />

      {/* Hero */}
      <section className="relative z-10 mx-auto max-w-6xl px-6 pb-20 pt-20 sm:pt-28">
        <div className="grid items-center gap-14 lg:grid-cols-2">
          <div>
            <div className="mb-6 inline-flex items-center gap-2 rounded-full border border-signal-500/20 bg-signal-500/5 px-3 py-1 text-xs font-medium text-signal-400">
              <ShieldCheck className="h-3.5 w-3.5" />
              Bring Your Own Vault
            </div>
            <h1 className="glow-text text-balance text-4xl font-bold leading-[1.1] tracking-tight text-white sm:text-5xl">
              Your secrets stay in your vault.
              <br />
              <span className="text-signal-400">Only references</span> ever leave it.
            </h1>
            <p className="mt-6 max-w-lg text-lg leading-relaxed text-slate-400">
              SecRefs expands declarative <code className="text-signal-400">sec://</code> URIs
              directly in memory, at the moment they&apos;re used. Your vault stays the system of
              record - SecRefs resolves secrets, and never stores one.
            </p>
            <div className="mt-9 flex flex-wrap items-center gap-4">
              <a
                href="#quickstart"
                className="flex items-center gap-2 rounded-md bg-signal-500 px-5 py-3 text-sm font-semibold text-ink-950 transition hover:bg-signal-400"
              >
                Get started
                <ArrowRight className="h-4 w-4" />
              </a>
              <a
                href="#sandbox"
                className="flex items-center gap-2 rounded-md border border-white/15 px-5 py-3 text-sm font-semibold text-white transition hover:border-white/30"
              >
                Try the sandbox
              </a>
            </div>
          </div>

          <TerminalWindow title="quickstart.sh">
            <Prompt>pnpm add @secrefs/node</Prompt>
            <Line dim>+ @secrefs/node 0.1.0</Line>
            <div className="h-3" />
            <Prompt>echo &apos;DB_PASSWORD=sec://aws/prod/db#password&apos; {">>"} .env</Prompt>
            <div className="h-3" />
            <Prompt>npx secrefs run -- node server.js</Prompt>
            <Line dim>secrefs: resolved 1 secret reference(s): DB_PASSWORD</Line>
            <Line>server listening on :3000</Line>
          </TerminalWindow>
        </div>
      </section>

      {/* Problem / solution */}
      <section className="relative z-10 mx-auto max-w-6xl px-6 py-20">
        <div className="mb-12 max-w-2xl">
          <h2 className="text-3xl font-bold tracking-tight text-white">
            You already have a vault. Stop copying secrets out of it.
          </h2>
          <p className="mt-4 text-slate-400">
            Every plaintext secret that leaves your vault - into a{" "}
            <code className="text-signal-400">.env</code> file, a CI variable, a teammate&apos;s
            clipboard - is a copy you now have to track, rotate, and eventually leak. SecRefs
            replaces the copy with a pointer.
          </p>
        </div>

        <div className="grid gap-6 lg:grid-cols-2">
          <div className="rounded-xl border border-red-500/20 bg-red-500/[0.03] p-6">
            <div className="mb-4 flex items-center gap-2 text-sm font-semibold text-red-400">
              <X className="h-4 w-4" />
              .env sprawl
            </div>
            <TerminalWindow title=".env (committed to 6 places, rotated in 0)">
              <Line>DB_PASSWORD=correcthorsebatterystaple</Line>
              <Line>STRIPE_KEY=sk_live_51N...</Line>
              <Line>VAULT_TOKEN=hvs.CAESIJ...</Line>
              <Line dim># ^ now living on 3 laptops, in Slack, and in CI logs</Line>
            </TerminalWindow>
            <ul className="mt-5 space-y-2 text-sm text-slate-400">
              <li className="flex gap-2">
                <X className="mt-0.5 h-4 w-4 shrink-0 text-red-400" />
                Plaintext secrets on disk, in shell history, in CI logs
              </li>
              <li className="flex gap-2">
                <X className="mt-0.5 h-4 w-4 shrink-0 text-red-400" />
                No single source of truth once a value is copy-pasted
              </li>
              <li className="flex gap-2">
                <X className="mt-0.5 h-4 w-4 shrink-0 text-red-400" />
                Rotation means chasing down every place a copy landed
              </li>
            </ul>
          </div>

          <div className="rounded-xl border border-signal-500/20 bg-signal-500/[0.03] p-6">
            <div className="mb-4 flex items-center gap-2 text-sm font-semibold text-signal-400">
              <Check className="h-4 w-4" />
              SecRefs
            </div>
            <TerminalWindow title=".env (safe to commit)">
              <Line>DB_PASSWORD=sec://aws/prod/db#password</Line>
              <Line>STRIPE_KEY=sec://vault/secret/data/stripe#key</Line>
              <Line>VAULT_TOKEN=sec://local/mock-vault-token</Line>
              <Line dim># ^ just pointers - the real values never left the vault</Line>
            </TerminalWindow>
            <ul className="mt-5 space-y-2 text-sm text-slate-400">
              <li className="flex gap-2">
                <Check className="mt-0.5 h-4 w-4 shrink-0 text-signal-400" />
                Values expand in memory, at the moment they&apos;re used
              </li>
              <li className="flex gap-2">
                <Check className="mt-0.5 h-4 w-4 shrink-0 text-signal-400" />
                Your vault stays the single source of truth
              </li>
              <li className="flex gap-2">
                <Check className="mt-0.5 h-4 w-4 shrink-0 text-signal-400" />
                Rotate in the vault; running apps pick it up without a restart
              </li>
            </ul>
          </div>
        </div>
      </section>

      {/* How it works */}
      <section id="how-it-works" className="relative z-10 mx-auto max-w-6xl px-6 py-20">
        <div className="mb-14 flex items-center gap-3">
          <Workflow className="h-6 w-6 text-signal-400" />
          <h2 className="text-3xl font-bold tracking-tight text-white">How it works</h2>
        </div>
        <div className="grid gap-6 sm:grid-cols-2 lg:grid-cols-4">
          {HOW_IT_WORKS.map((item) => (
            <div
              key={item.step}
              className="relative rounded-xl border border-white/10 bg-white/[0.02] p-6"
            >
              <div className="font-mono text-3xl font-bold text-white/10">{item.step}</div>
              <h3 className="mt-3 font-semibold text-white">{item.title}</h3>
              <p className="mt-2 text-sm leading-relaxed text-slate-400">{item.description}</p>
            </div>
          ))}
        </div>
      </section>

      {/* Sandbox */}
      <section id="sandbox" className="relative z-10 mx-auto max-w-6xl px-6 py-20">
        <div className="mb-10 max-w-2xl">
          <div className="mb-3 flex items-center gap-2 text-sm font-semibold text-signal-400">
            <Boxes className="h-4 w-4" />
            Interactive
          </div>
          <h2 className="text-3xl font-bold tracking-tight text-white">
            See the expansion happen, safely
          </h2>
          <p className="mt-4 text-slate-400">
            Paste a mock <code className="text-signal-400">.env</code>, pick which lines are mock
            provider secrets, and watch SecRefs validate and expand them entirely in your
            browser&apos;s memory. Nothing here ever leaves your machine - there&apos;s no backend
            behind this sandbox.
          </p>
        </div>
        <Sandbox />
      </section>

      {/* Providers */}
      <section id="providers" className="relative z-10 mx-auto max-w-6xl px-6 py-20">
        <div className="mb-10 flex items-center gap-3">
          <Lock className="h-6 w-6 text-signal-400" />
          <h2 className="text-3xl font-bold tracking-tight text-white">Bring your own vault</h2>
        </div>
        <div className="grid gap-6 sm:grid-cols-2 lg:grid-cols-4">
          {PROVIDERS.map((provider) => (
            <div
              key={provider.name}
              className="flex flex-col rounded-xl border border-white/10 bg-white/[0.02] p-6"
            >
              <provider.icon className="h-6 w-6 shrink-0 text-signal-400" />
              <h3 className="mt-4 text-balance font-semibold text-white">{provider.name}</h3>
              {/* These are long enough to overflow a quarter-width card, so
                  they scroll on their own rather than widening the page. */}
              <code className="mt-1 block overflow-x-auto text-xs text-slate-500">
                {provider.alias}
              </code>
              <p className="mt-3 text-sm leading-relaxed text-slate-400">{provider.detail}</p>
            </div>
          ))}
        </div>
      </section>

      {/* The other side of the platform. Deliberately after the sandbox: a
          visitor should understand what a reference is before being asked
          to imagine handing one to a vendor. */}
      <section id="pass-through" className="relative z-10 mx-auto max-w-6xl px-6 py-20">
        <div className="rounded-xl border border-white/10 bg-white/[0.02] p-8 sm:p-10">
          <div className="grid gap-10 lg:grid-cols-2 lg:items-center">
            <div>
              <div className="mb-3 flex items-center gap-2 text-sm font-semibold text-signal-400">
                <Share2 className="h-4 w-4" />
                Pass-through
              </div>
              <h2 className="text-balance text-3xl font-bold tracking-tight text-white">
                The same idea, pointed outward.
              </h2>
              <div className="mt-4 space-y-4 text-slate-400">
                <p>
                  A reference works just as well when the thing reading it isn&apos;t yours. Give a
                  vendor <code className="text-signal-400">sec://acme/stripe#key</code> instead of
                  the key, and they resolve it when they use it - so rotating at the source
                  never breaks their integration, and revoking their access never touches anyone
                  else&apos;s.
                </p>
                <p>
                  Their database stops holding your credentials. Yours stays the only place the
                  value lives.
                </p>
              </div>
              <a
                href="/for-vendors"
                className="mt-7 inline-flex items-center gap-2 rounded-md border border-white/15 px-5 py-3 text-sm font-semibold text-white transition hover:border-white/30"
              >
                If you&apos;re a vendor, start here
                <ArrowRight className="h-4 w-4" />
              </a>
            </div>

            <TerminalWindow title="what the vendor stores">
              <Line dim># not your key - a pointer to it</Line>
              <Line>sec://acme/stripe#key</Line>
              <div className="h-4" />
              <Line dim># you rotate at the source</Line>
              <Line dim># their next call gets the new value</Line>
              <Line dim># nothing on their side changed</Line>
            </TerminalWindow>
          </div>
        </div>
      </section>

      {/* Quickstart / code examples */}
      <section id="quickstart" className="relative z-10 mx-auto max-w-6xl px-6 py-20">
        <h2 className="mb-10 text-3xl font-bold tracking-tight text-white">Quickstart</h2>
        <div className="grid gap-6 lg:grid-cols-3">
          <TerminalWindow title="Node.js / CLI">
            <Line dim>{"// package.json"}</Line>
            <Prompt>pnpm add @secrefs/node</Prompt>
            <div className="h-3" />
            <Line dim>{"// .env"}</Line>
            <Line>DB_PASSWORD=sec://aws/prod/db#password</Line>
            <div className="h-3" />
            <Prompt>secrefs run -- node server.js</Prompt>
          </TerminalWindow>

          <TerminalWindow title="Node.js / library">
            <Line>{"import { secRefs } from '@secrefs/node';"}</Line>
            <div className="h-2" />
            <Line>{"await secRefs.init();"}</Line>
            <Line dim>{"// process.env.DB_PASSWORD is now the real value"}</Line>
            <div className="h-2" />
            <Line>{"const key = await secRefs.expandString("}</Line>
            <Line>{"  'sec://vault/secret/data/stripe#key'"}</Line>
            <Line>{");"}</Line>
          </TerminalWindow>

          <TerminalWindow title="Python">
            <Prompt>pip install secrefs</Prompt>
            <div className="h-3" />
            <Line>{"from secrefs import sec_refs"}</Line>
            <div className="h-2" />
            <Line>{"await sec_refs.init()"}</Line>
            <Line dim>{"# os.environ['DB_PASSWORD'] is now the real value"}</Line>
            <div className="h-2" />
            <Prompt>secrefs-py run -- python app.py</Prompt>
          </TerminalWindow>
        </div>
      </section>

      <footer className="relative z-10 border-t border-white/5">
        <div className="mx-auto flex max-w-6xl flex-col items-center justify-between gap-4 px-6 py-10 text-sm text-slate-500 sm:flex-row">
          <div className="flex items-center gap-2 font-mono text-slate-400">
            <TerminalIcon className="h-4 w-4 text-signal-400" />
            secrefs.com
          </div>
          <div className="flex flex-wrap justify-center gap-6">
            <a href="/for-vendors" className="hover:text-white">
              For vendors
            </a>
            <a href="https://github.com/Armistice-Group/secrefs" className="hover:text-white">
              GitHub
            </a>
            <a href="#quickstart" className="hover:text-white">
              Docs
            </a>
            <span>MIT Licensed</span>
          </div>
        </div>
      </footer>
    </div>
  );
}
