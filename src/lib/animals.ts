import { collection, doc, getDoc, query, where, getDocs } from "firebase/firestore";
import { db } from "./firebase";
import { Animal } from "./types";
import { isPublicAnimalStatus, PUBLIC_ANIMAL_STATUS } from "./animal-lifecycle";
import { logError, logWarn } from "./logger";

// Public adoptions listing. The Firestore query enforces the same
// visibility boundary as the security rules, so a public visitor only
// ever receives publicly listable animals — no client-side filtering of
// private records. The post-map predicate is a second, defensive layer:
// even if the query ever drifted, a non-public document would still be
// dropped before reaching the UI.
export async function getAvailableAnimals(): Promise<Animal[]> {
  try {
    const q = query(
      collection(db, "animals"),
      where("status", "==", PUBLIC_ANIMAL_STATUS)
    );
    const querySnapshot = await getDocs(q);

    return querySnapshot.docs
      .map((doc) => {
        const data = doc.data();
        return {
          id: doc.id,
          ...data,
          createdAt: data.createdAt?.toDate().toISOString(),
          updatedAt: data.updatedAt?.toDate().toISOString(),
        } as Animal;
      })
      .filter((animal) => isPublicAnimalStatus(animal.status));
  } catch (error) {
    logError("animals", "fetch", error);
    return [];
  }
}

// Single-animal read for the public detail page. Returns null for a
// document that is missing, unreadable, or not in the public status —
// the caller renders a plain 404 so a private animal is
// indistinguishable from a nonexistent one. The Firestore rules already
// deny `get` on non-public documents, so this predicate is the second,
// defensive layer of the same boundary the listing query enforces.
export async function getPublicAnimal(id: string): Promise<Animal | null> {
  try {
    const docSnap = await getDoc(doc(db, "animals", id));
    if (!docSnap.exists()) return null;

    const data = docSnap.data();
    if (!isPublicAnimalStatus(data.status)) return null;

    return {
      id: docSnap.id,
      ...data,
      createdAt: data.createdAt?.toDate().toISOString(),
      updatedAt: data.updatedAt?.toDate().toISOString(),
    } as Animal;
  } catch (error) {
    // Both fail closed to "not found". A rules denial is the boundary
    // working as designed — a guessed or stale ID on a private animal —
    // so it logs at warn rather than error; anything else is a real
    // fetch failure.
    if ((error as { code?: string }).code === "permission-denied") {
      logWarn("animals", "fetch-detail", "non-public animal read denied");
    } else {
      logError("animals", "fetch-detail", error);
    }
    return null;
  }
}
