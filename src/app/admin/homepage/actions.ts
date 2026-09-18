"use server";

import { adminDb } from "@/lib/firebase-admin";
import { requireAdmin } from "@/lib/auth";
import { Homepage } from "@/lib/types";

export async function saveHomepageData(data: Homepage) {
  const { authorized } = await requireAdmin();
  
  if (!authorized) {
    throw new Error("Unauthorized");
  }

  try {
    await adminDb().collection("homepage").doc("main").set(data);
    return { success: true };
  } catch (error) {
    console.error("Error saving homepage data:", error);
    throw new Error("Failed to save homepage data");
  }
}

export async function loadHomepageData() {
  // The data is publicly readable, but every server action under /admin
  // self-authorizes so the boundary stays uniform and can't be weakened
  // by a future action copied from this one.
  const { authorized } = await requireAdmin();

  if (!authorized) {
    throw new Error("Unauthorized");
  }

  try {
    const docSnap = await adminDb().collection("homepage").doc("main").get();
    
    if (docSnap.exists) {
      return docSnap.data() as Homepage;
    }
    
    return null;
  } catch (error) {
    console.error("Error loading homepage data:", error);
    throw new Error("Failed to load homepage data");
  }
}
