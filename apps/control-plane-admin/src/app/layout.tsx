import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "SecRefs Control Plane",
  description:
    "Manage vault connections, roles, grants, and service identities for your organization.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className="dark">
      <body className="min-h-screen bg-ink-950 font-sans text-slate-200 antialiased">
        {children}
      </body>
    </html>
  );
}
