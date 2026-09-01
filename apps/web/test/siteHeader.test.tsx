import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import SiteHeader from "@/components/SiteHeader";

const LINKS = [
  { href: "#sandbox", label: "Sandbox" },
  { href: "/for-vendors", label: "For vendors" },
];

describe("<SiteHeader />", () => {
  it("renders every link in the desktop nav", () => {
    render(<SiteHeader links={LINKS} />);
    // Two of each: the desktop nav and the (closed, hidden) mobile panel.
    expect(screen.getAllByRole("link", { name: "For vendors" })[0]).toHaveAttribute(
      "href",
      "/for-vendors",
    );
    expect(screen.getAllByRole("link", { name: "Sandbox" })[0]).toHaveAttribute("href", "#sandbox");
  });

  it("keeps the wordmark a link home, so every page can get back", () => {
    render(<SiteHeader links={LINKS} />);
    expect(screen.getByRole("link", { name: /secrefs/i })).toHaveAttribute("href", "/");
  });

  it("ships the mobile disclosure alongside the desktop nav", () => {
    render(<SiteHeader links={LINKS} />);
    expect(screen.getByRole("button", { name: "Open menu" })).toBeInTheDocument();
  });
});
