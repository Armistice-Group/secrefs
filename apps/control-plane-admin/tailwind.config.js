/** @type {import('tailwindcss').Config} */
module.exports = {
  content: ["./src/**/*.{js,ts,jsx,tsx,mdx}"],
  theme: {
    extend: {
      fontFamily: {
        // Same stacks as apps/web - no webfont, so builds stay hermetic.
        // The sans/mono split does real work here: mono marks anything
        // machine-addressable (aliases, paths, patterns, ids, tokens),
        // sans is human chrome. That distinction is the type system.
        mono: [
          "ui-monospace",
          "SFMono-Regular",
          "Menlo",
          "Consolas",
          "Liberation Mono",
          "monospace",
        ],
      },
      colors: {
        // Inherited verbatim from apps/web's tailwind config - the
        // console is the same product, not a separate brand.
        ink: {
          950: "#05070a",
          900: "#0a0e14",
          800: "#10161f",
          700: "#1a2230",
          600: "#2a3444",
        },
        signal: {
          400: "#4ee8b0",
          500: "#22d3a0",
          600: "#16a37e",
        },
        // Semantic state, deliberately distinct from the brand accent so
        // "allow" never reads as merely "branded". Used for decisions
        // (allow/deny) and operational warnings.
        warn: {
          400: "#e0b34d",
          500: "#c79433",
        },
        deny: {
          400: "#f0776b",
          500: "#d95b4f",
        },
      },
      backgroundImage: {
        grid: "linear-gradient(to right, rgba(255,255,255,0.04) 1px, transparent 1px), linear-gradient(to bottom, rgba(255,255,255,0.04) 1px, transparent 1px)",
      },
      backgroundSize: {
        grid: "40px 40px",
      },
    },
  },
  plugins: [],
};
