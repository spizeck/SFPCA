// Component tests for the owner-portal animal card (#295): the card must
// present the annual confirmation (an ownership/residency attestation)
// and the annual registration (the authoritative registry record with a
// fee) as two visibly separate statuses. An owner who just confirmed
// must never read confirmation as completing registration. Server
// actions and the toast hook are mocked at the module boundary.
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, test, vi } from "vitest";
import type { PortalAnimal } from "@/lib/registry/ownership";

const { mockConfirmAnimal, mockRequestRegistration, mockToast } = vi.hoisted(
  () => ({
    mockConfirmAnimal: vi.fn(),
    mockRequestRegistration: vi.fn(),
    mockToast: vi.fn(),
  }),
);

vi.mock("@/app/portal/actions", () => ({
  confirmAnimalAction: mockConfirmAnimal,
  requestRegistrationAction: mockRequestRegistration,
  submitOwnerReportAction: vi.fn(),
  reportMissingAction: vi.fn(),
  cancelOwnerRequestAction: vi.fn(),
  updateOwnerProfileAction: vi.fn(),
}));

vi.mock("@/hooks/use-toast", () => ({
  useToast: () => ({ toast: mockToast }),
}));

import { AnimalCard } from "@/app/portal/portal-client";

// Captain-like default: a person-owned dog with prior-year registration
// only. Individual tests override the two states under scrutiny.
function fixture(overrides: Partial<PortalAnimal>): PortalAnimal {
  return {
    ownershipId: "own-1",
    animalId: "animal-1",
    name: "Captain",
    species: "dog",
    sex: "male",
    approxAge: "~8 years",
    photoUrl: null,
    basis: "person",
    householdName: null,
    validFrom: "2024-05-18",
    chipNumber: null,
    registration: null,
    registrationYear: 2026,
    registrationYears: [2025],
    registrationRequest: null,
    registrationCancelled: false,
    lastConfirmedOn: null,
    confirmationDueOn: "2026-05-18",
    confirmationDue: false,
    ...overrides,
  };
}

describe("AnimalCard — confirmation vs registration presentation", () => {
  test("confirmation due + registration incomplete keeps both calls to action distinct", () => {
    render(<AnimalCard animal={fixture({ confirmationDue: true })} />);

    // Confirmation area: its own label, status, meaning, and action.
    expect(screen.getByText("Annual confirmation")).toBeInTheDocument();
    expect(screen.getByText("Due now")).toBeInTheDocument();
    expect(
      screen.getByText("Confirms Captain still lives on Saba with you."),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", {
        name: "Confirm still living on Saba with me",
      }),
    ).toBeEnabled();

    // Registration area: clearly the registry record, not the
    // confirmation, with the portal-native request action offered.
    expect(screen.getByText("2026 registration")).toBeInTheDocument();
    expect(screen.getByText("Not registered")).toBeInTheDocument();
    expect(
      screen.getByText("Previously registered: 2025"),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Register Captain for 2026" }),
    ).toBeEnabled();
  });

  test("confirmation complete + registration still incomplete — the Captain acceptance state", () => {
    render(
      <AnimalCard
        animal={fixture({
          confirmationDue: false,
          lastConfirmedOn: "2026-10-04",
        })}
      />,
    );

    // The completed confirmation reads as an attestation, not as a
    // registration — and no disabled button has to explain anything.
    expect(screen.getByText("Confirmed Oct 4, 2026")).toBeInTheDocument();
    expect(
      screen.queryByRole("button", {
        name: "Confirm still living on Saba with me",
      }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Confirmed for this year" }),
    ).not.toBeInTheDocument();

    // Registration is visibly unchanged and still outstanding.
    expect(screen.getByText("Not registered")).toBeInTheDocument();
    expect(
      screen.getByText("Previously registered: 2025"),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Register Captain for 2026" }),
    ).toBeEnabled();
  });

  test("confirmation complete + paid current registration is calm (Sunny)", () => {
    render(
      <AnimalCard
        animal={fixture({
          name: "Sunny",
          confirmationDue: false,
          lastConfirmedOn: "2026-08-25",
          chipNumber: "985-113-000-111-222",
          registration: {
            year: 2026,
            paymentState: "paid",
            amountDueCents: 1000,
            paidCents: 1000,
            outstandingCents: 0,
            currency: "USD",
          },
          registrationYears: [2026, 2025],
        })}
      />,
    );

    expect(screen.getByText("Confirmed Aug 25, 2026")).toBeInTheDocument();
    expect(screen.getByText("Paid")).toBeInTheDocument();
    expect(screen.getByText(/Microchip:/)).toBeInTheDocument();
    // No attention state — and the current year is filtered out of the
    // history line so it isn't restated as "previously registered".
    expect(screen.queryByText("Due now")).not.toBeInTheDocument();
    expect(screen.queryByText(/outstanding/)).not.toBeInTheDocument();
    const history = screen.getByText(/Previously registered:/);
    expect(history).toHaveTextContent("2025");
    expect(history).not.toHaveTextContent("2026");
  });

  test("partial balance shows the outstanding figure with paid context (Mochi)", () => {
    render(
      <AnimalCard
        animal={fixture({
          name: "Mochi",
          registration: {
            year: 2026,
            paymentState: "partial",
            amountDueCents: 10000,
            paidCents: 500,
            outstandingCents: 9500,
            currency: "USD",
          },
          registrationYears: [2026],
        })}
      />,
    );

    expect(screen.getByText("$95.00 outstanding")).toBeInTheDocument();
    expect(
      screen.getByText("$5.00 of $100.00 paid"),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("link", { name: "Contact us" }),
    ).toHaveAttribute("href", "/contact");
    // An outstanding balance is still a registration — never rendered
    // as "not registered".
    expect(screen.queryByText("Not registered")).not.toBeInTheDocument();
  });

  test("unpaid balance shows the full amount with no paid context", () => {
    render(
      <AnimalCard
        animal={fixture({
          registration: {
            year: 2026,
            paymentState: "unpaid",
            amountDueCents: 10000,
            paidCents: 0,
            outstandingCents: 10000,
            currency: "USD",
          },
        })}
      />,
    );

    expect(screen.getByText("$100.00 outstanding")).toBeInTheDocument();
    expect(screen.queryByText(/of \$100\.00 paid/)).not.toBeInTheDocument();
  });

  test.each([
    ["waived", "Waived"],
    ["complimentary", "Complimentary"],
    ["no-fee", "No fee"],
  ] as const)(
    "resolved registration state %s reads as %s",
    (paymentState, label) => {
      render(
        <AnimalCard
          animal={fixture({
            registration: {
              year: 2026,
              paymentState,
              amountDueCents: 1000,
              paidCents: 0,
              outstandingCents: 0,
              currency: "USD",
            },
          })}
        />,
      );
      expect(screen.getByText(label)).toBeInTheDocument();
      expect(screen.queryByText(/outstanding/)).not.toBeInTheDocument();
    },
  );

  test("microchip line is omitted when the animal has no chip", () => {
    render(<AnimalCard animal={fixture({ chipNumber: null })} />);
    expect(screen.queryByText(/Microchip:/)).not.toBeInTheDocument();
  });

  test("'With you since' no longer says 'registered' — ownership is not registration", () => {
    render(<AnimalCard animal={fixture({})} />);
    expect(screen.getByText("With you since May 18, 2024")).toBeInTheDocument();
    expect(screen.queryByText(/Registered with you since/)).not.toBeInTheDocument();
  });

  test("status areas stack on mobile and split on sm+", () => {
    const { container } = render(
      <AnimalCard animal={fixture({ confirmationDue: true })} />,
    );
    const grid = container.querySelector(".grid.gap-4.border-t");
    expect(grid).toHaveClass("sm:grid-cols-2");
    expect(grid).not.toHaveClass("grid-cols-2");
  });

  test("pending portal request shows awaiting-review and no CTA", () => {
    render(
      <AnimalCard
        animal={fixture({
          registrationRequest: {
            status: "pending",
            submittedAt: "2026-10-04T12:00:00.000Z",
          },
        })}
      />,
    );
    expect(screen.getByText("Request submitted")).toBeInTheDocument();
    expect(
      screen.getByText("Awaiting SFPCA review · sent Oct 4, 2026"),
    ).toBeInTheDocument();
    expect(screen.queryByText("Not registered")).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /Register Captain for/ }),
    ).not.toBeInTheDocument();
  });

  test("approved request shows finalizing state and no CTA", () => {
    render(
      <AnimalCard
        animal={fixture({
          registrationRequest: {
            status: "approved",
            submittedAt: "2026-10-04T12:00:00.000Z",
          },
        })}
      />,
    );
    expect(screen.getByText("Approved")).toBeInTheDocument();
    expect(
      screen.getByText("SFPCA is finalizing the registration."),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /Register Captain for/ }),
    ).not.toBeInTheDocument();
  });

  test("rejected request shows declined state with contact path, no CTA", () => {
    render(
      <AnimalCard
        animal={fixture({
          registrationRequest: {
            status: "rejected",
            submittedAt: "2026-10-04T12:00:00.000Z",
          },
        })}
      />,
    );
    expect(screen.getByText("Request declined")).toBeInTheDocument();
    expect(
      screen.getByRole("link", { name: "contact us" }),
    ).toHaveAttribute("href", "/contact");
    expect(
      screen.queryByRole("button", { name: /Register Captain for/ }),
    ).not.toBeInTheDocument();
  });

  test("cancelled current-year registration suppresses the CTA", () => {
    render(
      <AnimalCard animal={fixture({ registrationCancelled: true })} />,
    );
    expect(screen.getByText("Not registered")).toBeInTheDocument();
    expect(
      screen.getByRole("link", { name: "Contact us" }),
    ).toHaveAttribute("href", "/contact");
    expect(
      screen.queryByRole("button", { name: /Register Captain for/ }),
    ).not.toBeInTheDocument();
  });

  test("request dialog shows canonical animal + owner info and submits", async () => {
    mockRequestRegistration.mockResolvedValue({
      ok: true,
      submissionId: "sub-1",
    });
    render(
      <AnimalCard
        animal={fixture({ chipNumber: "985-113-000-111-222" })}
        owner={{
          fullName: "Maria Hendricks",
          email: "maria.hendricks@example.com",
          phone: "+599 416 2201",
          address: "Windwardside 14, Saba",
        }}
      />,
    );

    fireEvent.click(
      screen.getByRole("button", { name: "Register Captain for 2026" }),
    );

    // Prefilled canonical data — nothing typed by the owner.
    expect(
      screen.getByRole("heading", { name: "Register Captain for 2026" }),
    ).toBeInTheDocument();
    expect(screen.getByText(/Maria Hendricks/)).toBeInTheDocument();
    expect(
      screen.getByText(/maria.hendricks@example.com/),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/Microchip 985-113-000-111-222/),
    ).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Submit request" }));

    await waitFor(() => {
      expect(mockRequestRegistration).toHaveBeenCalledWith(
        expect.objectContaining({
          ownershipId: "own-1",
          submissionId: expect.any(String),
        }),
      );
      expect(mockToast).toHaveBeenCalledWith(
        expect.objectContaining({ title: "Request submitted" }),
      );
    });
  });

  test("confirm action calls the server action for this ownership only", async () => {
    mockConfirmAnimal.mockResolvedValue({ ok: true });
    render(<AnimalCard animal={fixture({ confirmationDue: true })} />);

    fireEvent.click(
      screen.getByRole("button", {
        name: "Confirm still living on Saba with me",
      }),
    );

    await waitFor(() => {
      expect(mockConfirmAnimal).toHaveBeenCalledWith("own-1");
      expect(mockToast).toHaveBeenCalledWith(
        expect.objectContaining({
          title: "Confirmed",
          description:
            "Thanks — Captain is confirmed as still living on Saba with you.",
        }),
      );
    });
  });
});
