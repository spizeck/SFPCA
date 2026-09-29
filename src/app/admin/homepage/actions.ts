"use server";

import { adminDb } from "@/lib/firebase-admin";
import { requireAdmin } from "@/lib/auth";
import { Homepage } from "@/lib/types";
import { logError } from "@/lib/logger";

export async function saveHomepageData(data: Homepage) {
  const { authorized } = await requireAdmin();

  if (!authorized) {
    throw new Error("Unauthorized");
  }

  try {
    await adminDb().collection("homepage").doc("main").set(data);
    return { ok: true };
  } catch (error) {
    // Failure is reported here once — rethrowing would let
    // onRequestError capture a second, information-free event.
    logError("admin", "homepage-save", error);
    return { ok: false };
  }
}

export async function loadHomepageData(): Promise<
  { ok: true; data: Homepage | null } | { ok: false }
> {
  // The data is publicly readable, but every server action under /admin
  // self-authorizes so the boundary stays uniform and can't be weakened
  // by a future action copied from this one.
  const { authorized } = await requireAdmin();

  if (!authorized) {
    throw new Error("Unauthorized");
  }

  try {
    const docSnap = await adminDb().collection("homepage").doc("main").get();
    return { ok: true, data: docSnap.exists ? (docSnap.data() as Homepage) : null };
  } catch (error) {
    logError("admin", "homepage-load", error);
    return { ok: false };
  }
}
