import { collection, query, where, limit, getDocs } from "firebase/firestore";
import { db } from "./firebase";
import { Animal } from "./types";

export async function getAvailableAnimals(): Promise<Animal[]> {
  try {
    const q = query(
      collection(db, "animals"),
      where("status", "==", "available"),
      limit(6)
    );
    const querySnapshot = await getDocs(q);
    
    return querySnapshot.docs.map((doc) => {
      const data = doc.data();
      return {
        id: doc.id,
        ...data,
        createdAt: data.createdAt?.toDate().toISOString(),
        updatedAt: data.updatedAt?.toDate().toISOString(),
      } as Animal;
    });
  } catch (error) {
    console.error("Error fetching animals:", error);
    return [];
  }
}
