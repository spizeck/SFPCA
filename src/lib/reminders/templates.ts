// Reminder email templates (#172). Pure renderers — no DB, no env reads
// beyond the injected siteUrl — so output is fully testable and the same
// subject/body is what gets snapshotted onto the communications row
// before delivery.
//
// Template rules:
// - identify SFPCA by name (recipients may not recognize "reminder" mail)
// - name the animal and the concrete action needed
// - link only to plain public pages — no tokens, no PII in URLs
// - plain text is the canonical body; HTML is a minimal wrapped version
//   with every interpolated value escaped

import { absoluteUrl } from "@/lib/seo";

export interface RenderedEmail {
  subject: string;
  text: string;
  html: string;
}

const ORG_NAME = "Saba Foundation for the Prevention of Cruelty to Animals (SFPCA)";

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function htmlShell(bodyParagraphs: string[]): string {
  const inner = bodyParagraphs
    .map((p) => `<p style="margin:0 0 12px">${p}</p>`)
    .join("\n");
  return [
    '<div style="font-family:system-ui,sans-serif;font-size:15px;line-height:1.5;color:#1f2937;max-width:36rem">',
    inner,
    `<p style="margin:24px 0 0;font-size:13px;color:#6b7280">— ${escapeHtml(ORG_NAME)}</p>`,
    "</div>",
  ].join("\n");
}

export interface VaccinationReminderContext {
  ownerName: string;
  animalName: string;
  vaccineName: string;
  // The dose's effective next-relevant date (ISO), and whether that
  // date has already passed at send time.
  effectiveDate: string;
  overdue: boolean;
  siteUrl: string;
}

export function renderVaccinationReminder(
  ctx: VaccinationReminderContext,
): RenderedEmail {
  const contactUrl = absoluteUrl("/contact", {
    NEXT_PUBLIC_SITE_URL: ctx.siteUrl,
  });
  const timing = ctx.overdue
    ? `was due on ${ctx.effectiveDate} and is now overdue`
    : `is due on ${ctx.effectiveDate}`;

  const subject = `Vaccination reminder for ${ctx.animalName}`;
  const text = [
    `Hello ${ctx.ownerName},`,
    ``,
    `This is a reminder from the ${ORG_NAME}: ${ctx.animalName}'s ${ctx.vaccineName} vaccination ${timing}.`,
    ``,
    `Please contact us to arrange a visit: ${contactUrl}`,
    ``,
    `If ${ctx.animalName} has already had this vaccination, or is no longer in your care, please let us know so we can update our records.`,
    ``,
    `— ${ORG_NAME}`,
  ].join("\n");

  const html = htmlShell([
    `Hello ${escapeHtml(ctx.ownerName)},`,
    `This is a reminder from the ${escapeHtml(ORG_NAME)}: <strong>${escapeHtml(ctx.animalName)}</strong>&rsquo;s ${escapeHtml(ctx.vaccineName)} vaccination ${ctx.overdue ? `was due on <strong>${escapeHtml(ctx.effectiveDate)}</strong> and is now overdue` : `is due on <strong>${escapeHtml(ctx.effectiveDate)}</strong>`}.`,
    `Please <a href="${escapeHtml(contactUrl)}">contact us</a> to arrange a visit.`,
    `If ${escapeHtml(ctx.animalName)} has already had this vaccination, or is no longer in your care, please let us know so we can update our records.`,
  ]);

  return { subject, text, html };
}

export interface AnnualConfirmationReminderContext {
  ownerName: string;
  animalName: string;
  // The date this relationship's annual confirmation fell due (ISO).
  dueOn: string;
  siteUrl: string;
}

// Annual "is this animal still living on Saba and associated with you?"
// nudge (#166). Links to the owner portal — the only place the
// confirmation can actually be recorded.
export function renderAnnualConfirmationReminder(
  ctx: AnnualConfirmationReminderContext,
): RenderedEmail {
  const portalUrl = absoluteUrl("/portal", {
    NEXT_PUBLIC_SITE_URL: ctx.siteUrl,
  });

  const subject = `Annual confirmation needed for ${ctx.animalName}`;
  const text = [
    `Hello ${ctx.ownerName},`,
    ``,
    `Each year the ${ORG_NAME} asks registered owners to confirm their animals so our records stay accurate.`,
    ``,
    `The annual confirmation for ${ctx.animalName} was due on ${ctx.dueOn}. Please sign in to the owner portal and confirm that ${ctx.animalName} is still living on Saba and in your care:`,
    `${portalUrl}`,
    ``,
    `If ${ctx.animalName} is no longer in your care, has died, or has left Saba, you can report that in the portal too — it only takes a minute and keeps the registry correct.`,
    ``,
    `— ${ORG_NAME}`,
  ].join("\n");

  const html = htmlShell([
    `Hello ${escapeHtml(ctx.ownerName)},`,
    `Each year the ${escapeHtml(ORG_NAME)} asks registered owners to confirm their animals so our records stay accurate.`,
    `The annual confirmation for <strong>${escapeHtml(ctx.animalName)}</strong> was due on <strong>${escapeHtml(ctx.dueOn)}</strong>. Please <a href="${escapeHtml(portalUrl)}">sign in to the owner portal</a> and confirm that ${escapeHtml(ctx.animalName)} is still living on Saba and in your care.`,
    `If ${escapeHtml(ctx.animalName)} is no longer in your care, has died, or has left Saba, you can report that in the portal too — it keeps the registry correct.`,
  ]);

  return { subject, text, html };
}

export interface RegistrationDueReminderContext {
  ownerName: string;
  animalName: string;
  // The registration period (calendar year) that is missing.
  year: number;
  siteUrl: string;
}

// "Your animal isn't registered for the current period" nudge (#169).
// Eligibility is the canonical listUnregisteredAnimals — an 'active'
// animal with no active registration row for the year. Operational,
// not suppressible: annual registration is a registry obligation.
// Deliberately says nothing about money — balance reminders wait for
// #170's authoritative ledger state.
export function renderRegistrationDueReminder(
  ctx: RegistrationDueReminderContext,
): RenderedEmail {
  const portalUrl = absoluteUrl("/portal", {
    NEXT_PUBLIC_SITE_URL: ctx.siteUrl,
  });
  const contactUrl = absoluteUrl("/contact", {
    NEXT_PUBLIC_SITE_URL: ctx.siteUrl,
  });

  const subject = `${ctx.year} registration needed for ${ctx.animalName}`;
  const text = [
    `Hello ${ctx.ownerName},`,
    ``,
    `Our records show that ${ctx.animalName} does not have a ${ctx.year} registration with the ${ORG_NAME}.`,
    ``,
    `Please register ${ctx.animalName} for ${ctx.year} — you can use the animal registration form on our website, or contact us and we will help:`,
    `${contactUrl}`,
    ``,
    `If ${ctx.animalName} is no longer in your care, has died, or has left Saba, please let us know in the owner portal so we can update the registry: ${portalUrl}`,
    ``,
    `— ${ORG_NAME}`,
  ].join("\n");

  const html = htmlShell([
    `Hello ${escapeHtml(ctx.ownerName)},`,
    `Our records show that <strong>${escapeHtml(ctx.animalName)}</strong> does not have a ${ctx.year} registration with the ${escapeHtml(ORG_NAME)}.`,
    `Please register ${escapeHtml(ctx.animalName)} for ${ctx.year} — use the animal registration form on our website, or <a href="${escapeHtml(contactUrl)}">contact us</a> and we will help.`,
    `If ${escapeHtml(ctx.animalName)} is no longer in your care, has died, or has left Saba, please let us know in the <a href="${escapeHtml(portalUrl)}">owner portal</a> so we can update the registry.`,
  ]);

  return { subject, text, html };
}
