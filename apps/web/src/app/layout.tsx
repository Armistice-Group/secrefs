import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "SecRefs - Bring Your Own Vault secret reference engine",
  description:
    "SecRefs expands sec:// secret references in memory at runtime. No plaintext ever hits disk, no third-party SaaS vault required.",
  metadataBase: new URL("https://secrefs.com"),
  openGraph: {
    title: "SecRefs - Bring Your Own Vault",
    description:
      "Decouple secret storage from your application. sec:// references expand in memory, at runtime, from whatever vault you already run.",
    url: "https://secrefs.com",
    siteName: "SecRefs",
    type: "website",
  },
  twitter: {
    card: "summary_large_image",
    title: "SecRefs - Bring Your Own Vault",
    description: "Decouple secret storage from your application with sec:// references.",
  },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className="dark">
      <body className="bg-ink-950 font-sans text-slate-200 antialiased">{children}</body>
    </html>
  );
}
