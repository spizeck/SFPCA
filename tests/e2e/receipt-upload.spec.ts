// Receipt upload boundary (#219 review): the single byte-acceptance
// path is POST /api/receipts/<submissionId>, exercised here against
// the Storage emulator with the same security semantics as production
// (Admin SDK write, claim-before-bytes, magic-byte typing, 5 MB cap).
//
// The happy path drives the real UI end-to-end; the negative cases
// POST to the route directly via page.request so no UI timing is
// involved. Fine-grained status coverage for every rejection reason
// lives in tests/receipt-upload.test.ts — here we prove the transport
// itself carries a >1 MB receipt and that the authorization order
// holds against a live datastore and bucket.
import { expect, test, dbQuery } from "./fixtures";
import { dismissConsentNotice } from "./helpers";

const STORAGE_EMULATOR =
  process.env.FIREBASE_STORAGE_EMULATOR_HOST ?? "127.0.0.1:9199";
const BUCKET = "demo-sfpca.appspot.com";

// A payload the route's magic-byte sniffer accepts as PNG — the full
// signature plus filler, sized on demand.
function pngPayload(bytes: number): Buffer {
  const buf = Buffer.alloc(bytes, 0x61);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(buf);
  return buf;
}

async function objectExists(path: string): Promise<boolean> {
  const res = await fetch(
    `http://${STORAGE_EMULATOR}/storage/v1/b/${BUCKET}/o/` +
      encodeURIComponent(path),
  );
  return res.ok;
}

// Drives the public form; attaches a receipt file only when `receipt`
// is non-null. Returns the new registration_submissions id.
async function submitRegistration(
  page: import("@playwright/test").Page,
  suffix: string,
  receipt: Buffer | null,
): Promise<string> {
  await page.goto("/animal-registration");
  await dismissConsentNotice(page);
  await page.getByLabel("Full Name").fill(`E2E Receipt ${suffix}`);
  await page
    .getByRole("textbox", { name: "Address", exact: true })
    .fill("Windwardside, Saba (synthetic)");
  await page.getByLabel("Phone Number").fill("+599 416 0000");
  await page
    .getByLabel("Email Address")
    .fill(`e2e-receipt-${suffix}@example.com`);
  await page.getByLabel("Animal's Name").fill(`Receipt Pet ${suffix}`);
  await page.getByLabel("Type of Animal").fill("Dog");
  await page.getByText("Male", { exact: true }).click();
  await page.getByText("Yes", { exact: true }).click();
  await page.getByLabel(/I certify/).check();
  if (receipt) {
    await page.getByLabel(/Upload Payment Receipt/).setInputFiles({
      name: "receipt.png",
      mimeType: "image/png",
      buffer: receipt,
    });
  }
  await page.getByRole("button", { name: /Submit Registration/ }).click();
  await expect(
    page.getByText("Registration Submitted").first(),
  ).toBeVisible();
  const rows = await dbQuery<{ id: string }>(
    `select id from registration_submissions
     where owner_name = 'E2E Receipt ${suffix}'`,
  );
  expect(rows).toHaveLength(1);
  return rows[0].id;
}

// A row whose submitter declared a receipt but no upload has claimed
// it yet: the UI auto-uploads on success, so flip receipt_requested on
// a no-receipt row to reach the claimable state directly.
async function claimableSubmission(
  page: import("@playwright/test").Page,
  suffix: string,
): Promise<string> {
  const id = await submitRegistration(page, suffix, null);
  await dbQuery(
    `update registration_submissions set receipt_requested = true
     where id = '${id}'`,
  );
  return id;
}

test.describe("receipt upload boundary (#219)", () => {
  test("a real registration with a >1 MB receipt lands through the route", async ({
    page,
  }) => {
    // ~2 MB — squarely inside the 1–5 MB band the old Server Action
    // fallback could not transport (default 1 MB body cap).
    const id = await submitRegistration(
      page,
      `${Date.now()}-big`,
      pngPayload(2 * 1024 * 1024),
    );

    const claimed = await dbQuery<{ p: string | null }>(
      `select payment_receipt_path as p from registration_submissions
       where id = '${id}'`,
    );
    expect(claimed[0].p).toBe(`receipts/${id}`);
    expect(await objectExists(`receipts/${id}`)).toBe(true);
  });

  test("a second upload for the same submission cannot overwrite the first", async ({
    page,
  }) => {
    const id = await submitRegistration(
      page,
      `${Date.now()}-dup`,
      pngPayload(1024),
    );
    const second = await page.request.post(`/api/receipts/${id}`, {
      data: pngPayload(1024),
      headers: { "content-type": "image/png" },
    });
    expect(second.status()).toBe(409);
  });

  test("an unknown or unrequested submission cannot create a receipt object", async ({
    page,
  }) => {
    const missing = await page.request.post(
      "/api/receipts/11111111-2222-4333-8444-555555555555",
      { data: pngPayload(1024), headers: { "content-type": "image/png" } },
    );
    expect(missing.status()).toBe(404);

    const id = await submitRegistration(page, `${Date.now()}-norec`, null);
    const unclaimed = await page.request.post(`/api/receipts/${id}`, {
      data: pngPayload(1024),
      headers: { "content-type": "image/png" },
    });
    expect(unclaimed.status()).toBe(409);
    expect(await objectExists(`receipts/${id}`)).toBe(false);
  });

  test("oversized and mistyped uploads are rejected before persistence", async ({
    page,
  }) => {
    const id = await claimableSubmission(page, `${Date.now()}-rej`);

    // 6 MB — over the wire cap; the stream is aborted, nothing stored.
    const tooBig = await page.request.post(`/api/receipts/${id}`, {
      data: pngPayload(6 * 1024 * 1024),
      headers: { "content-type": "image/png" },
    });
    expect(tooBig.status()).toBe(413);

    // Post-413 the claim was released — this request claims again and
    // then fails magic-byte validation (HTML bytes under an image
    // header).
    const wrongType = await page.request.post(`/api/receipts/${id}`, {
      data: Buffer.from("<html><body>nope</body></html>"),
      headers: { "content-type": "image/png" },
    });
    expect(wrongType.status()).toBe(415);

    const malformed = await page.request.post("/api/receipts/not-a-uuid", {
      data: pngPayload(1024),
      headers: { "content-type": "image/png" },
    });
    expect(malformed.status()).toBe(400);

    expect(await objectExists(`receipts/${id}`)).toBe(false);
    expect(await objectExists("receipts/not-a-uuid")).toBe(false);
  });
});
