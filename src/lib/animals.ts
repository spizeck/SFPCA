import { collection, query, where, getDocs } from "firebase/firestore";
import { db } from "./firebase";
import { Animal } from "./types";
import { isPublicAnimalStatus, PUBLIC_ANIMAL_STATUS } from "./animal-lifecycle";
import { logError } from "./logger";

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
