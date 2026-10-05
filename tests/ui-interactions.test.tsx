// Tests for the shared interaction primitives (#280): the Button
// loading contract (width-stable, non-reentrant, accessible), Spinner,
// Skeleton, and Checkbox state feedback.
import { fireEvent, render, screen } from "@testing-library/react";
import type { MouseEvent } from "react";
import { describe, expect, test, vi } from "vitest";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Skeleton } from "@/components/ui/skeleton";
import { Spinner } from "@/components/ui/spinner";

describe("Button press + pointer affordances", () => {
  test("buttons advertise pointer cursor and a press state", () => {
    render(<Button>Save</Button>);
    const button = screen.getByRole("button", { name: "Save" });
    expect(button.className).toContain("cursor-pointer");
    expect(button.className).toContain("active:scale-[0.98]");
  });

  test("link variant opts out of the scale press", () => {
    render(
      <Button variant="link" asChild>
        <a href="/somewhere">Read more</a>
      </Button>,
    );
    expect(screen.getByRole("link", { name: "Read more" }).className).toContain(
      "active:scale-100",
    );
  });
});

describe("Button loading", () => {
  test("exposes aria-busy, becomes non-interactive, and announces Loading", () => {
    render(<Button loading>Save changes</Button>);
    const button = screen.getByRole("button", { name: "Loading…" });
    expect(button).toBeDisabled();
    expect(button).toHaveAttribute("aria-busy", "true");
  });

  test("preserves the label's layout box while loading", () => {
    // The children keep their (invisible) layout footprint so the
    // button can't shrink or grow when the spinner appears.
    render(<Button loading>Save changes</Button>);
    const labelSpan = screen.getByText("Save changes");
    expect(labelSpan).toHaveAttribute("aria-hidden", "true");
    expect(labelSpan.className).toContain("opacity-0");
  });

  test("cannot be re-clicked while loading", () => {
    const onClick = vi.fn();
    render(
      <Button loading onClick={onClick}>
        Save changes
      </Button>,
    );
    fireEvent.click(screen.getByRole("button"));
    expect(onClick).not.toHaveBeenCalled();
  });

  test("resumes normal behaviour once loading clears", () => {
    const onClick = vi.fn();
    const { rerender } = render(
      <Button loading={false} onClick={onClick}>
        Save changes
      </Button>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
    expect(onClick).toHaveBeenCalledTimes(1);
    rerender(
      <Button loading onClick={onClick}>
        Save changes
      </Button>,
    );
    expect(screen.getByRole("button")).toHaveAttribute("aria-busy", "true");
    rerender(
      <Button loading={false} onClick={onClick}>
        Save changes
      </Button>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
    expect(onClick).toHaveBeenCalledTimes(2);
  });

  test("a loading slotted anchor is not keyboard-activatable", () => {
    // A slotted <a> has no native disabled — aria-disabled +
    // pointer-events-none alone leave Enter able to fire the href.
    const onClick = vi.fn();
    render(
      <Button asChild loading onClick={onClick}>
        <a href="/somewhere">Read more</a>
      </Button>,
    );
    const link = screen.getByRole("link", { name: "Read more" });
    expect(link).toHaveAttribute("aria-disabled", "true");
    expect(link).toHaveAttribute("aria-busy", "true");
    expect(link).toHaveAttribute("tabIndex", "-1");
    // Enter activation on an anchor is keydown's default action —
    // preventing it prevents the click entirely.
    expect(fireEvent.keyDown(link, { key: "Enter" })).toBe(false);
    expect(fireEvent.keyDown(link, { key: " " })).toBe(false);
    fireEvent.click(link);
    expect(onClick).not.toHaveBeenCalled();
  });

  test("a disabled slotted anchor gets the same inert treatment", () => {
    const onClick = vi.fn();
    render(
      <Button asChild disabled onClick={onClick}>
        <a href="/somewhere">Read more</a>
      </Button>,
    );
    const link = screen.getByRole("link", { name: "Read more" });
    expect(link).toHaveAttribute("aria-disabled", "true");
    expect(link).toHaveAttribute("tabIndex", "-1");
    expect(fireEvent.keyDown(link, { key: "Enter" })).toBe(false);
    fireEvent.click(link);
    expect(onClick).not.toHaveBeenCalled();
  });

  test("an interactive slotted anchor keeps full keyboard behaviour", () => {
    // Guard keys only while inert — Enter/Space and click work, and
    // unrelated keys (Tab) must pass through so focus can still move.
    // preventDefault keeps jsdom from logging a navigation notice.
    const onClick = vi.fn((e: MouseEvent) => e.preventDefault());
    render(
      <Button asChild onClick={onClick}>
        <a href="/somewhere">Read more</a>
      </Button>,
    );
    const link = screen.getByRole("link", { name: "Read more" });
    expect(link).not.toHaveAttribute("aria-disabled");
    expect(link).not.toHaveAttribute("tabIndex");
    expect(fireEvent.keyDown(link, { key: "Enter" })).toBe(true);
    expect(fireEvent.keyDown(link, { key: "Tab" })).toBe(true);
    fireEvent.click(link);
    expect(onClick).toHaveBeenCalledTimes(1);
  });
});

describe("Spinner", () => {
  test("is purely decorative — callers own the loading semantics", () => {
    const { container } = render(<Spinner />);
    expect(container.querySelector("svg")).toHaveAttribute(
      "aria-hidden",
      "true",
    );
  });
});

describe("Skeleton", () => {
  test("is hidden from AT and only pulses when motion is allowed", () => {
    render(<Skeleton data-testid="s" className="h-10 w-24" />);
    const el = screen.getByTestId("s");
    expect(el).toHaveAttribute("aria-hidden", "true");
    expect(el.className).toContain("motion-safe:animate-pulse");
  });
});

describe("Checkbox", () => {
  test("still toggles through pointer and keyboard semantics", () => {
    render(<Checkbox aria-label="Agree" />);
    const box = screen.getByRole("checkbox", { name: "Agree" });
    expect(box).toHaveAttribute("data-state", "unchecked");
    fireEvent.click(box);
    expect(box).toHaveAttribute("data-state", "checked");
  });
});
