"use client";

import { useEffect, useRef, useState } from "react";
import { Menu, X } from "lucide-react";

export interface NavLink {
  href: string;
  label: string;
}

/**
 * The section links are `hidden sm:flex` in the header, so below the `sm`
 * breakpoint they were simply unreachable - a phone visitor could only
 * scroll. This restores them behind a disclosure button.
 */
export default function MobileNav({ links }: { links: NavLink[] }) {
  const [open, setOpen] = useState(false);
  const panelRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;

    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        setOpen(false);
        buttonRef.current?.focus(); // don't strand focus on a hidden panel
      }
    }
    function onPointerDown(event: PointerEvent) {
      const target = event.target as Node;
      if (!panelRef.current?.contains(target) && !buttonRef.current?.contains(target)) {
        setOpen(false);
      }
    }

    document.addEventListener("keydown", onKeyDown);
    document.addEventListener("pointerdown", onPointerDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      document.removeEventListener("pointerdown", onPointerDown);
    };
  }, [open]);

  return (
    <div className="sm:hidden">
      <button
        ref={buttonRef}
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-controls="mobile-nav-panel"
        aria-label={open ? "Close menu" : "Open menu"}
        className="flex h-9 w-9 items-center justify-center rounded-md border border-white/10 text-slate-300 transition hover:border-white/20 hover:text-white focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-signal-400"
      >
        {open ? <X className="h-4 w-4" /> : <Menu className="h-4 w-4" />}
      </button>

      <div
        id="mobile-nav-panel"
        ref={panelRef}
        hidden={!open}
        className="absolute left-0 right-0 top-full z-20 border-b border-white/10 bg-ink-950/95 backdrop-blur"
      >
        <nav className="flex flex-col px-6 py-2">
          {links.map((link) => (
            <a
              key={link.href}
              href={link.href}
              onClick={() => setOpen(false)}
              className="border-b border-white/5 py-3 text-sm text-slate-300 last:border-b-0 hover:text-white focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-signal-400"
            >
              {link.label}
            </a>
          ))}
        </nav>
      </div>
    </div>
  );
}
