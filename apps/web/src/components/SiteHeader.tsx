import { Github, Terminal as TerminalIcon } from "lucide-react";
import MobileNav, { type NavLink } from "./MobileNav";

/**
 * Shared header. `relative z-30`, not z-10: z-10 establishes a stacking
 * context, so the mobile panel's own z-20 cannot escape it and page
 * sections - later siblings also at z-10 - paint over the open menu.
 */
export default function SiteHeader({ links }: { links: NavLink[] }) {
  return (
    <header className="relative z-30 border-b border-white/5">
      <div className="mx-auto flex max-w-6xl items-center justify-between px-6 py-5">
        <a
          href="/"
          className="flex items-center gap-2 font-mono text-sm font-semibold tracking-tight text-white"
        >
          <TerminalIcon className="h-4 w-4 text-signal-400" />
          secrefs
        </a>
        <nav className="hidden items-center gap-8 text-sm text-slate-400 sm:flex">
          {links.map((link) => (
            <a key={link.href} href={link.href} className="hover:text-white">
              {link.label}
            </a>
          ))}
        </nav>
        <div className="flex items-center gap-2">
          <a
            href="https://github.com/Armistice-Group/secrefs"
            className="flex items-center gap-2 rounded-md border border-white/10 px-3 py-1.5 text-xs font-medium text-slate-300 hover:border-white/20 hover:text-white"
          >
            <Github className="h-3.5 w-3.5" />
            GitHub
          </a>
          <MobileNav links={links} />
        </div>
      </div>
    </header>
  );
}
