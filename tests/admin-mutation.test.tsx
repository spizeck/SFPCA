// Unit tests for the shared admin mutation primitives added in #91:
// useMutation (pending + re-entrancy guard), ConfirmDialog (named
// destructive confirmation), LoadError (retryable load failure), and
// useUnsavedChangesGuard (navigation warning while dirty).
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, test, vi } from "vitest";
import { useMutation } from "@/hooks/use-mutation";
import { useUnsavedChangesGuard } from "@/hooks/use-unsaved-changes";
import { ConfirmDialog } from "@/components/admin/confirm-dialog";
import { LoadError } from "@/components/admin/load-error";

function MutationProbe({ fn }: { fn: () => Promise<unknown> }) {
  const mutation = useMutation();
  return (
    <button
      disabled={mutation.pending}
      onClick={() => void mutation.run(fn)}
    >
      {mutation.pending ? "Saving…" : "Save"}
    </button>
  );
}

describe("useMutation", () => {
  test("exposes pending while the action is in flight", async () => {
    let resolve: () => void = () => {};
    const fn = vi.fn(
      () => new Promise<void>((r) => { resolve = r; }),
    );
    render(<MutationProbe fn={fn} />);

    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "Saving…" }),
      ).toBeDisabled(),
    );

    resolve();
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Save" })).toBeEnabled(),
    );
  });

  test("a double-click only invokes the action once", async () => {
    let resolve: () => void = () => {};
    const fn = vi.fn(
      () => new Promise<void>((r) => { resolve = r; }),
    );
    render(<MutationProbe fn={fn} />);

    const button = screen.getByRole("button", { name: "Save" });
    fireEvent.click(button);
    fireEvent.click(button);
    fireEvent.click(button);
    expect(fn).toHaveBeenCalledTimes(1);

    resolve();
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Save" })).toBeEnabled(),
    );
  });

  test("a second action is allowed after the first completes", async () => {
    const fn = vi.fn(() => Promise.resolve());
    render(<MutationProbe fn={fn} />);

    const button = screen.getByRole("button", { name: "Save" });
    fireEvent.click(button);
    await waitFor(() => expect(fn).toHaveBeenCalledTimes(1));
    fireEvent.click(button);
    await waitFor(() => expect(fn).toHaveBeenCalledTimes(2));
  });

  test("exposes pendingKey for per-row actions", async () => {
    function KeyedProbe() {
      const mutation = useMutation();
      return (
        <button onClick={() => void mutation.run(() => Promise.resolve(), "row-7")}>
          {mutation.pendingKey === "row-7" ? "busy" : "idle"}
        </button>
      );
    }
    render(<KeyedProbe />);
    fireEvent.click(screen.getByRole("button"));
    await waitFor(() =>
      expect(screen.getByRole("button")).toHaveTextContent("idle"),
    );
  });
});

describe("ConfirmDialog", () => {
  test("identifies the object being destroyed and fires callbacks", () => {
    const onConfirm = vi.fn();
    const onCancel = vi.fn();
    render(
      <ConfirmDialog
        open
        title="Delete FAQ"
        description={
          <>Permanently delete <strong>&ldquo;How do I register?&rdquo;</strong>?</>
        }
        onConfirm={onConfirm}
        onCancel={onCancel}
      />,
    );

    expect(
      screen.getByText(/How do I register\?/),
    ).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    expect(onConfirm).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  test("disables both actions while the mutation is pending", () => {
    render(
      <ConfirmDialog
        open
        title="Delete animal"
        description="Permanently delete Buddy?"
        pending
        onConfirm={() => {}}
        onCancel={() => {}}
      />,
    );
    expect(screen.getByRole("button", { name: "Deleting…" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Cancel" })).toBeDisabled();
  });
});

describe("LoadError", () => {
  test("shows an alert with a working retry", () => {
    const onRetry = vi.fn();
    render(<LoadError label="animals" onRetry={onRetry} />);

    expect(screen.getByRole("alert")).toHaveTextContent(
      /Couldn.t load animals/,
    );
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });
});

describe("useUnsavedChangesGuard", () => {
  function DirtyPage({ dirty }: { dirty: boolean }) {
    useUnsavedChangesGuard(dirty);
    return <a href="/admin">Admin home</a>;
  }

  test("intercepts in-app navigation while dirty", () => {
    const confirmSpy = vi
      .spyOn(window, "confirm")
      .mockImplementation(() => false);
    render(<DirtyPage dirty />);

    const link = screen.getByRole("link", { name: "Admin home" });
    const event = new MouseEvent("click", { bubbles: true, cancelable: true });
    link.dispatchEvent(event);

    expect(confirmSpy).toHaveBeenCalled();
    expect(event.defaultPrevented).toBe(true);
    confirmSpy.mockRestore();
  });

  test("does not intercept navigation when clean", () => {
    const confirmSpy = vi.spyOn(window, "confirm");
    render(<DirtyPage dirty={false} />);

    const link = screen.getByRole("link", { name: "Admin home" });
    const event = new MouseEvent("click", { bubbles: true, cancelable: true });
    link.dispatchEvent(event);

    expect(confirmSpy).not.toHaveBeenCalled();
    expect(event.defaultPrevented).toBe(false);
    confirmSpy.mockRestore();
  });

  test("leaves new-tab links alone even while dirty", () => {
    const confirmSpy = vi.spyOn(window, "confirm");
    function Page() {
      useUnsavedChangesGuard(true);
      return (
        <a href="/" target="_blank">
          View site
        </a>
      );
    }
    render(<Page />);
    screen.getByRole("link").dispatchEvent(
      new MouseEvent("click", { bubbles: true, cancelable: true }),
    );
    expect(confirmSpy).not.toHaveBeenCalled();
    confirmSpy.mockRestore();
  });
});
