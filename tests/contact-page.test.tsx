// Rendering tests for the public contact page content. These assert the
// behavior visitors depend on: contact methods render as usable links,
// and optional sections appear only when their data is present.
import { render, screen } from "@testing-library/react";
import { describe, expect, test } from "vitest";
import { ContactPageContent } from "@/components/contact/contact-page";

const contact = {
  phone: "+1 (555) 123-4567",
  email: "info@example.org",
  whatsapp: "+1 (555) 987-6543",
  address: "123 Windwardside, Saba",
  hours: "Mon-Fri 9am-5pm",
};

describe("ContactPageContent", () => {
  test("renders the heading and intro copy", () => {
    render(<ContactPageContent contact={contact} />);
    expect(
      screen.getByRole("heading", { name: "Contact Us" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("heading", { name: "Get in Touch" }),
    ).toBeInTheDocument();
  });

  test("renders each contact method as an actionable link", () => {
    render(<ContactPageContent contact={contact} />);

    const phone = screen.getByRole("link", { name: contact.phone });
    expect(phone).toHaveAttribute("href", `tel:${contact.phone}`);

    const email = screen.getByRole("link", { name: contact.email });
    expect(email).toHaveAttribute("href", `mailto:${contact.email}`);

    // The WhatsApp link must strip non-digit characters for wa.me.
    const whatsapp = screen.getByRole("link", { name: contact.whatsapp });
    expect(whatsapp).toHaveAttribute("href", "https://wa.me/15559876543");

    expect(screen.getByText(contact.address)).toBeInTheDocument();
    expect(screen.getByText(contact.hours)).toBeInTheDocument();
  });

  test("shows no contact cards when contact data is absent", () => {
    render(<ContactPageContent />);
    // The page chrome still renders, but no contact-method cards.
    expect(
      screen.getByRole("heading", { name: "Contact Us" }),
    ).toBeInTheDocument();
    expect(screen.queryByText("Phone")).not.toBeInTheDocument();
    expect(screen.queryByText("Email")).not.toBeInTheDocument();
    expect(screen.queryByText("WhatsApp")).not.toBeInTheDocument();
  });

  test("renders the map section only when an embed URL is provided", () => {
    const { rerender } = render(<ContactPageContent contact={contact} />);
    expect(
      screen.queryByRole("heading", { name: "Find Us" }),
    ).not.toBeInTheDocument();

    rerender(
      <ContactPageContent
        contact={contact}
        mapEmbedUrl="https://maps.example.com/embed"
      />,
    );
    expect(
      screen.getByRole("heading", { name: "Find Us" }),
    ).toBeInTheDocument();
  });

  test("renders provided social links and omits the section without them", () => {
    const { rerender } = render(<ContactPageContent contact={contact} />);
    expect(
      screen.queryByRole("heading", { name: "Follow Us" }),
    ).not.toBeInTheDocument();

    rerender(
      <ContactPageContent
        contact={contact}
        social={{ facebook: "https://facebook.com/sfpca" }}
      />,
    );
    const facebook = screen.getByRole("link", { name: "Facebook" });
    expect(facebook).toHaveAttribute("href", "https://facebook.com/sfpca");
    expect(
      screen.queryByRole("link", { name: "Instagram" }),
    ).not.toBeInTheDocument();
  });
});
