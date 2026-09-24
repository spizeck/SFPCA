// Template rendering tests (#172). Templates are pure — the same
// subject/body is snapshotted onto the communications row, so what this
// test asserts is what owners would receive.
import { describe, expect, test } from "vitest";
import { renderVaccinationReminder } from "@/lib/reminders/templates";

const BASE = {
  ownerName: "Jane Owner",
  animalName: "Rex",
  vaccineName: "Rabies",
  effectiveDate: "2026-10-10",
  overdue: false,
  siteUrl: "https://www.sabafpca.com",
};

describe("renderVaccinationReminder", () => {
  test("identifies SFPCA, the animal, the vaccine, and the action", () => {
    const rendered = renderVaccinationReminder(BASE);
    for (const body of [rendered.text, rendered.html]) {
      expect(body).toContain("Rex");
      expect(body).toContain("Rabies");
      expect(body).toContain("Saba Foundation");
      // A safe public link — no tokens, no PII in the URL.
      expect(body).toContain("https://www.sabafpca.com/contact");
      expect(body).not.toContain("jane@");
      expect(body).not.toContain("token=");
    }
    expect(rendered.subject).toBe("Vaccination reminder for Rex");
    expect(rendered.text).toContain("Jane Owner");
    expect(rendered.text).toContain("is due on 2026-10-10");
    expect(rendered.text).not.toContain("overdue");
  });

  test("overdue phrasing replaces the due-date phrasing", () => {
    const rendered = renderVaccinationReminder({ ...BASE, overdue: true });
    expect(rendered.text).toContain("was due on 2026-10-10");
    expect(rendered.text).toContain("overdue");
    expect(rendered.html).toContain("overdue");
  });

  test("HTML escapes every interpolated value", () => {
    const rendered = renderVaccinationReminder({
      ...BASE,
      ownerName: `Jane <script>alert("x")</script>`,
      animalName: "Rex & Friends",
      vaccineName: "Rabies <b>",
    });
    expect(rendered.html).not.toContain("<script>");
    expect(rendered.html).toContain("&lt;script&gt;");
    expect(rendered.html).toContain("Rex &amp; Friends");
    expect(rendered.html).toContain("Rabies &lt;b&gt;");
    // The plaintext body keeps raw values — escaping is HTML-only.
    expect(rendered.text).toContain("Rex & Friends");
  });
});
