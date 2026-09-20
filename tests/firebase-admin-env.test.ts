// The Admin SDK init must fail fast with a diagnosable message naming
// missing env vars — never a cryptic cert() failure, and never the
// values themselves.
import { describe, expect, test } from "vitest";
import { missingAdminEnvVars } from "@/lib/firebase-admin";

describe("missingAdminEnvVars", () => {
  test("names every missing required variable", () => {
    expect(missingAdminEnvVars({})).toEqual([
      "FIREBASE_ADMIN_PROJECT_ID",
      "FIREBASE_ADMIN_CLIENT_EMAIL",
      "FIREBASE_ADMIN_PRIVATE_KEY",
    ]);
  });

  test("returns empty when fully configured", () => {
    expect(
      missingAdminEnvVars({
        FIREBASE_ADMIN_PROJECT_ID: "p",
        FIREBASE_ADMIN_CLIENT_EMAIL: "e",
        FIREBASE_ADMIN_PRIVATE_KEY: "k",
      }),
    ).toEqual([]);
  });

  test("empty strings count as missing", () => {
    expect(
      missingAdminEnvVars({
        FIREBASE_ADMIN_PROJECT_ID: "",
        FIREBASE_ADMIN_CLIENT_EMAIL: "e",
        FIREBASE_ADMIN_PRIVATE_KEY: "k",
      }),
    ).toEqual(["FIREBASE_ADMIN_PROJECT_ID"]);
  });
});
