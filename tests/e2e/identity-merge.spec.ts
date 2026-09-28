// E2E journeys for #211: person and household duplicate pairs surfaced by
// the data-quality workspace, compared side-by-side, merged under an
// explicit staff confirmation, and — critically — blocked when both
// person records hold independent sign-in accounts. Seeds registry rows
// through the db-server control endpoint (engine-direct — a second
// wire-protocol client can corrupt the app's in-flight queries);
// auth identities are synthetic — no real Firebase account is needed to
// prove the block.
import { dbQuery, expect, test, type Page } from "./fixtures";
import { E2E_ADMIN_EMAIL, E2E_ADMIN_PASSWORD } from "./env";
import { dismissConsentNotice, waitForDialogSettled } from "./helpers";

async function signInAsAdmin(page: Page) {
  await page.goto("/login");
  await dismissConsentNotice(page);
  await page.getByLabel("Email").fill(E2E_ADMIN_EMAIL);
  await page.getByLabel("Password").fill(E2E_ADMIN_PASSWORD);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(page).toHaveURL("/admin");
}

// Same normalized name + phone is the corroboration the duplicate-person
// detector requires; differing emails create a field conflict the merge
// UI must put to staff.
async function seedDuplicatePersons(opts: { withAuth?: boolean } = {}) {
  const [a, b] = await dbQuery<{ id: string }>(
    `insert into persons (full_name, email, phone)
     values
       ('E2E Duperson', 'dup-a@example.com', '+599 416 9999'),
       ('E2E Duperson', 'dup-b@example.com', '+5994169999')
     returning id`,
  );
  if (opts.withAuth) {
    await dbQuery(
      `insert into auth_identities (provider, provider_uid, email, person_id)
       values
         ('firebase', $1, 'dup-a@example.com', $2),
         ('firebase', $3, 'dup-b@example.com', $4)`,
      [`e2e-uid-${a.id}`, a.id, `e2e-uid-${b.id}`, b.id],
    );
  }
  return { a: a.id, b: b.id };
}

async function seedDuplicateHouseholds() {
  const [member] = await dbQuery<{ id: string }>(
    `insert into persons (full_name) values ('E2E Housemate') returning id`,
  );
  const [ha, hb] = await dbQuery<{ id: string }>(
    `insert into households (name, address)
     values
       ('E2E Duphousehold', 'Zealandia 1, Saba'),
       ('E2E Duphousehold', 'Zealandia 1, Saba')
     returning id`,
  );
  await dbQuery(
    `insert into household_members (household_id, person_id, role)
     values ($1, $2, 'member')`,
    [hb.id, member.id],
  );
  return { a: ha.id, b: hb.id, member: member.id };
}

function findingCard(page: Page, label: RegExp) {
  return page
    .locator("div")
    .filter({ hasText: label })
    .filter({
      has: page.getByRole("link", { name: /Compare & merge|Open record/ }),
    })
    .last();
}

test.describe("person merge", () => {
  test("duplicate people: finding → compare → conflict choice → confirm; retired record kept as lineage", async ({
    page,
  }) => {
    test.setTimeout(120_000);
    const { a, b } = await seedDuplicatePersons();
    await signInAsAdmin(page);

    await page.goto("/admin/data-quality");
    await dismissConsentNotice(page);
    const finding = findingCard(page, /Possible duplicate people: E2E Duperson/);
    await expect(finding).toBeVisible();
    await expect(finding.getByText(/same name and phone/)).toBeVisible();
    await expect(finding.getByText(/same email/)).not.toBeVisible();

    await finding.getByRole("link", { name: /Compare & merge/ }).click();
    await expect(page).toHaveURL(/\/admin\/data-quality\/merge-person\?a=/);
    await expect(
      page.getByRole("heading", { name: "Review duplicate people" }),
    ).toBeVisible();
    // Neither side carries a login — the auth state is explicit, not absent.
    await expect(page.getByText("No sign-in account").first()).toBeVisible();

    await page.getByRole("radio", { name: "Keep this record" }).first().check();
    await page.getByRole("button", { name: "Preview merge" }).click();

    // Conflicting emails must be put to a human — no silent choice.
    await page.getByLabel("Email value").click();
    await page.getByRole("option").first().click();

    const retireButton = page.getByRole("button", {
      name: /Merge — retire E2E Duperson/,
    });
    await expect(retireButton).toBeVisible();
    await retireButton.click();
    const confirmDialog = page.getByRole("dialog");
    const confirmMerge = confirmDialog.getByRole("button", {
      name: "Merge",
    });
    await expect(confirmMerge).toBeEnabled();
    await waitForDialogSettled(confirmDialog);
    await confirmMerge.click();
    await expect(confirmDialog).toBeHidden();

    // Lands back on the directory; the retired row is annotated lineage.
    // exact: the toast's aria-live announce node repeats the text with a
    // "Notification Merged" prefix — a plain getByText resolves to both
    // and trips strict mode whenever it mounts before this assertion.
    await expect(page).toHaveURL("/admin/persons");
    await expect(
      page.getByText("Records merged into E2E Duperson.", { exact: true }),
    ).toBeVisible();
    await expect(page.getByText(/Merged into E2E Duperson/)).toBeVisible();

    // Lineage exists and the retired record still exists in the database.
    const lineage = await dbQuery<{ count: string }>(
      `select count(*)::text as count from person_merges
       where survivor_person_id in ($1, $2)`,
      [a, b],
    );
    expect(Number(lineage[0].count)).toBe(1);
    const persons = await dbQuery<{ count: string }>(
      `select count(*)::text as count from persons where id in ($1, $2)`,
      [a, b],
    );
    expect(Number(persons[0].count)).toBe(2);

    // The actionable finding is gone.
    await page.goto("/admin/data-quality");
    await dismissConsentNotice(page);
    await expect(
      page.getByText(/Possible duplicate people: E2E Duperson/),
    ).not.toBeVisible();
  });

  test("two independently signed-in records cannot be merged — blocked with an explanation", async ({
    page,
  }) => {
    test.setTimeout(120_000);
    const { a, b } = await seedDuplicatePersons({ withAuth: true });
    await signInAsAdmin(page);

    await page.goto("/admin/data-quality");
    await dismissConsentNotice(page);
    const finding = findingCard(page, /Possible duplicate people: E2E Duperson/);
    await finding.getByRole("link", { name: /Compare & merge/ }).click();

    // Both sides show a sign-in account before any merge plan exists.
    await expect(
      page.getByText("Sign-in account linked").first(),
    ).toBeVisible();
    await page.getByRole("radio", { name: "Keep this record" }).first().check();
    await page.getByRole("button", { name: "Preview merge" }).click();

    // The blocker is explained; the destructive control never appears.
    await expect(
      page.getByText(/Both records are linked to sign-in accounts/),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: /Merge — retire/ }),
    ).not.toBeVisible();

    // Nothing mutated: both persons and both identities are intact.
    const persons = await dbQuery<{ count: string }>(
      `select count(*)::text as count from persons where id in ($1, $2)`,
      [a, b],
    );
    expect(Number(persons[0].count)).toBe(2);
    const identities = await dbQuery<{ count: string }>(
      `select count(*)::text as count from auth_identities
       where person_id in ($1, $2)`,
      [a, b],
    );
    expect(Number(identities[0].count)).toBe(2);
    const lineage = await dbQuery<{ count: string }>(
      `select count(*)::text as count from person_merges
       where retired_person_id in ($1, $2) or survivor_person_id in ($1, $2)`,
      [a, b],
    );
    expect(Number(lineage[0].count)).toBe(0);
  });
});

test.describe("household merge", () => {
  test("duplicate households: finding → compare → confirm; member dedupes to the survivor", async ({
    page,
  }) => {
    test.setTimeout(120_000);
    const { a, b, member } = await seedDuplicateHouseholds();
    await signInAsAdmin(page);

    await page.goto("/admin/data-quality");
    await dismissConsentNotice(page);
    const finding = findingCard(
      page,
      /Possible duplicate households: E2E Duphousehold/,
    );
    await expect(finding).toBeVisible();
    await expect(finding.getByText(/same address/)).toBeVisible();

    await finding.getByRole("link", { name: /Compare & merge/ }).click();
    await expect(page).toHaveURL(/\/admin\/data-quality\/merge-household\?a=/);
    await expect(
      page.getByRole("heading", { name: "Review duplicate households" }),
    ).toBeVisible();

    await page.getByRole("radio", { name: "Keep this record" }).first().check();
    await page.getByRole("button", { name: "Preview merge" }).click();

    const retireButton = page.getByRole("button", {
      name: /Merge — retire E2E Duphousehold/,
    });
    await expect(retireButton).toBeVisible();
    await retireButton.click();
    const confirmDialog = page.getByRole("dialog");
    const confirmMerge = confirmDialog.getByRole("button", {
      name: "Merge",
    });
    await expect(confirmMerge).toBeEnabled();
    await waitForDialogSettled(confirmDialog);
    await confirmMerge.click();
    await expect(confirmDialog).toBeHidden();

    await expect(page).toHaveURL("/admin/persons");
    await expect(
      page.getByText(/merged into E2E Duphousehold/i).first(),
    ).toBeVisible();

    // Both household rows still exist; lineage points retired → survivor,
    // and the member sits on exactly one household.
    const households = await dbQuery<{ count: string }>(
      `select count(*)::text as count from households where id in ($1, $2)`,
      [a, b],
    );
    expect(Number(households[0].count)).toBe(2);
    const lineage = await dbQuery<{ count: string }>(
      `select count(*)::text as count from household_merges
       where survivor_household_id in ($1, $2)`,
      [a, b],
    );
    expect(Number(lineage[0].count)).toBe(1);
    const memberships = await dbQuery<{ count: string }>(
      `select count(*)::text as count from household_members
       where person_id = $1`,
      [member],
    );
    expect(Number(memberships[0].count)).toBe(1);

    await page.goto("/admin/data-quality");
    await dismissConsentNotice(page);
    await expect(
      page.getByText(/Possible duplicate households: E2E Duphousehold/),
    ).not.toBeVisible();
  });
});
