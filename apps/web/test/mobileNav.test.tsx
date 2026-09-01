import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import MobileNav from "@/components/MobileNav";

const LINKS = [
  { href: "#how-it-works", label: "How it works" },
  { href: "#providers", label: "Providers" },
];

describe("<MobileNav />", () => {
  it("starts closed, with the links out of the accessibility tree entirely", () => {
    render(<MobileNav links={LINKS} />);
    expect(screen.getByRole("button", { name: "Open menu" })).toHaveAttribute(
      "aria-expanded",
      "false",
    );
    // `hidden` removes the panel from the a11y tree, so a screen reader
    // never announces links a sighted user cannot see either. queryByRole
    // (not getByRole) because absence is the assertion.
    expect(screen.queryByRole("link", { name: "Providers" })).toBeNull();
  });

  it("opens on click and reveals every link", async () => {
    const user = userEvent.setup();
    render(<MobileNav links={LINKS} />);
    await user.click(screen.getByRole("button", { name: "Open menu" }));

    for (const link of LINKS) {
      const el = screen.getByRole("link", { name: link.label });
      expect(el).toBeVisible();
      expect(el).toHaveAttribute("href", link.href);
    }
  });

  it("closes after a link is tapped - the panel must not cover the section it just jumped to", async () => {
    const user = userEvent.setup();
    render(<MobileNav links={LINKS} />);
    await user.click(screen.getByRole("button", { name: "Open menu" }));
    await user.click(screen.getByRole("link", { name: "Providers" }));

    expect(screen.getByRole("button", { name: "Open menu" })).toHaveAttribute(
      "aria-expanded",
      "false",
    );
  });

  it("closes on Escape and returns focus to the button", async () => {
    const user = userEvent.setup();
    render(<MobileNav links={LINKS} />);
    const button = screen.getByRole("button", { name: "Open menu" });
    await user.click(button);

    await user.keyboard("{Escape}");

    expect(screen.getByRole("button", { name: "Open menu" })).toHaveAttribute(
      "aria-expanded",
      "false",
    );
    // Focus must not be stranded on a now-hidden panel.
    expect(screen.getByRole("button", { name: "Open menu" })).toHaveFocus();
  });

  it("closes when pointing outside the panel", async () => {
    const user = userEvent.setup();
    render(
      <div>
        <MobileNav links={LINKS} />
        <p data-testid="elsewhere">elsewhere</p>
      </div>,
    );
    await user.click(screen.getByRole("button", { name: "Open menu" }));
    await user.click(screen.getByTestId("elsewhere"));

    expect(screen.getByRole("button", { name: "Open menu" })).toHaveAttribute(
      "aria-expanded",
      "false",
    );
  });

  it("wires aria-controls to the panel it actually controls", async () => {
    const user = userEvent.setup();
    const { container } = render(<MobileNav links={LINKS} />);
    const button = screen.getByRole("button", { name: "Open menu" });
    const panelId = button.getAttribute("aria-controls");

    expect(panelId).toBeTruthy();
    expect(container.querySelector(`#${panelId}`)).toBeTruthy();

    await user.click(button);
    expect(screen.getByRole("button", { name: "Close menu" })).toHaveAttribute(
      "aria-expanded",
      "true",
    );
  });
});
