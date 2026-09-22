// Component tests for /admin/homepage (#91). The load/save boundary is
// the ./actions module (server actions); it is mocked at the boundary.
// These tests pin down the two highest-risk defects: a failed load
// rendering a blank editor that could overwrite live content, and a
// double-clicked save firing the server action twice.
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, test, vi } from "vitest";

const { mockLoad, mockSave, mockToast } = vi.hoisted(() => ({
  mockLoad: vi.fn(),
  mockSave: vi.fn(),
  mockToast: vi.fn(),
}));

vi.mock("@/app/admin/homepage/actions", () => ({
  loadHomepageData: mockLoad,
  saveHomepageData: mockSave,
}));

vi.mock("@/hooks/use-toast", () => ({
  useToast: () => ({ toast: mockToast }),
}));

// TeamManager touches Firebase Storage; stub it — its own behavior is
// tested separately.
vi.mock("@/components/admin/team-manager", () => ({
  TeamManager: () => <div data-testid="team-manager" />,
}));

import HomepageEditor from "@/app/admin/homepage/page";

const CONTENT = {
  hero: { title: "Welcome", subtitle: "To SFPCA" },
  about: { title: "About", content: "We help animals." },
  whoWeAre: { title: "Team", subtitle: "", team: [] },
  services: {
    title: "Services",
    items: [
      { title: "A", description: "a" },
      { title: "B", description: "b" },
      { title: "C", description: "c" },
    ],
  },
  whereWeAre: {
    title: "Find us",
    subtitle: "",
    address: "Saba",
    mapEmbedUrl: "",
    hours: "",
  },
  donation: { title: "Donate", content: "", paymentMethods: "" },
};

beforeEach(() => {
  vi.clearAllMocks();
  mockLoad.mockResolvedValue(CONTENT);
  mockSave.mockResolvedValue(undefined);
});

describe("admin homepage editor", () => {
  test("failed load shows a retryable error instead of a blank editor", async () => {
    mockLoad
      .mockRejectedValueOnce(new Error("backend exploded"))
      .mockResolvedValueOnce(CONTENT);

    render(<HomepageEditor />);

    await waitFor(() =>
      expect(screen.getByRole("alert")).toHaveTextContent(
        /Couldn.t load homepage content/,
      ),
    );
    // No editable form is shown, so a failed load cannot be saved over
    // live content.
    expect(screen.queryByLabelText("Title")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await waitFor(() =>
      expect(screen.getByDisplayValue("Welcome")).toBeInTheDocument(),
    );
  });

  test("editing content does not retrigger the load effect", async () => {
    // loadData is a stable useCallback dep of the mount effect; if it
    // closed over `data`, every keystroke would re-run the load.
    render(<HomepageEditor />);
    await waitFor(() => screen.getByDisplayValue("Welcome"));
    expect(mockLoad).toHaveBeenCalledTimes(1);

    fireEvent.change(screen.getByDisplayValue("Welcome"), {
      target: { value: "Edited title" },
    });
    fireEvent.change(screen.getByDisplayValue("To SFPCA"), {
      target: { value: "Edited subtitle" },
    });
    expect(mockLoad).toHaveBeenCalledTimes(1);
  });

  test("double-clicking Save only calls the server action once", async () => {
    let resolveSave: () => void = () => {};
    mockSave.mockImplementation(
      () => new Promise<void>((r) => { resolveSave = r; }),
    );
    render(<HomepageEditor />);
    await waitFor(() => screen.getByDisplayValue("Welcome"));

    const save = screen.getAllByRole("button", { name: "Save Changes" })[0];
    fireEvent.click(save);
    fireEvent.click(save);
    fireEvent.click(save);
    expect(mockSave).toHaveBeenCalledTimes(1);

    resolveSave();
    await waitFor(() =>
      expect(mockToast).toHaveBeenCalledWith(
        expect.objectContaining({ title: "Success" }),
      ),
    );
  });

  test("failed save keeps edits and reports a safe error", async () => {
    mockSave.mockRejectedValue(new Error("deadline exceeded xyz"));
    render(<HomepageEditor />);
    await waitFor(() => screen.getByDisplayValue("Welcome"));

    const heroTitle = screen.getByDisplayValue("Welcome");
    fireEvent.change(heroTitle, { target: { value: "Edited title" } });

    fireEvent.click(
      screen.getAllByRole("button", { name: "Save Changes" })[0],
    );
    await waitFor(() =>
      expect(mockToast).toHaveBeenCalledWith(
        expect.objectContaining({ variant: "destructive" }),
      ),
    );
    expect(
      mockToast.mock.calls.map((c) => c[0].description).join(" "),
    ).not.toContain("deadline exceeded xyz");
    expect(screen.getByDisplayValue("Edited title")).toBeInTheDocument();
  });
});
