// #182 cutover-switch tests: the PUBLIC_ANIMALS_SOURCE resolution matrix,
// delegation to the Firestore implementation, fail-closed Postgres error
// behavior, and DTO → Animal mapping. The Firestore read module and the
// Postgres client factory are mocked at their module boundaries.
import { afterEach, describe, expect, test, vi } from "vitest";

const { mockFsList, mockFsGet, mockGetRegistryDb, mockLogError } = vi.hoisted(
  () => ({
    mockFsList: vi.fn(),
    mockFsGet: vi.fn(),
    mockGetRegistryDb: vi.fn(),
    mockLogError: vi.fn(),
  }),
);

vi.mock("@/lib/animals", () => ({
  getAvailableAnimals: mockFsList,
  getPublicAnimal: mockFsGet,
}));
vi.mock("@/lib/db/client", () => ({
  getRegistryDb: mockGetRegistryDb,
}));
vi.mock("@/lib/logger", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/logger")>()),
  logError: mockLogError,
}));

import {
  getAvailableAnimals,
  getPublicAnimal,
  publicAnimalsSource,
  toAnimal,
} from "@/lib/registry/public-animals";

afterEach(() => {
  vi.unstubAllEnvs();
  mockFsList.mockReset();
  mockFsGet.mockReset();
  mockGetRegistryDb.mockReset();
  mockLogError.mockReset();
});

describe("publicAnimalsSource", () => {
  test("explicit flag wins over environment defaults", () => {
    expect(
      publicAnimalsSource({
        PUBLIC_ANIMALS_SOURCE: "postgres",
        VERCEL_ENV: "production",
      }),
    ).toBe("postgres");
    expect(
      publicAnimalsSource({
        PUBLIC_ANIMALS_SOURCE: "firestore",
        VERCEL_ENV: "preview",
      }),
    ).toBe("firestore");
  });

  test("unset flag defaults to postgres on preview, firestore elsewhere", () => {
    expect(publicAnimalsSource({ VERCEL_ENV: "preview" })).toBe("postgres");
    expect(publicAnimalsSource({ VERCEL_ENV: "production" })).toBe("firestore");
    expect(publicAnimalsSource({})).toBe("firestore");
  });

  test("unrecognized flag values fall back to the safe default", () => {
    expect(
      publicAnimalsSource({
        PUBLIC_ANIMALS_SOURCE: "yes",
        VERCEL_ENV: "production",
      }),
    ).toBe("firestore");
  });
});

describe("getAvailableAnimals source dispatch", () => {
  test("firestore mode delegates to the Firestore implementation", async () => {
    vi.stubEnv("PUBLIC_ANIMALS_SOURCE", "firestore");
    mockFsList.mockResolvedValue([{ id: "a1" }]);

    const result = await getAvailableAnimals();
    expect(mockFsList).toHaveBeenCalledOnce();
    expect(mockGetRegistryDb).not.toHaveBeenCalled();
    expect(result).toEqual([{ id: "a1" }]);
  });

  test("postgres mode never touches Firestore", async () => {
    vi.stubEnv("PUBLIC_ANIMALS_SOURCE", "postgres");
    mockGetRegistryDb.mockImplementation(() => {
      throw new Error("Postgres registry is not configured");
    });

    const result = await getAvailableAnimals();
    expect(result).toEqual([]);
    expect(mockFsList).not.toHaveBeenCalled();
    expect(mockLogError).toHaveBeenCalledOnce();
  });
});

describe("getPublicAnimal source dispatch", () => {
  test("firestore mode delegates with the requested id", async () => {
    vi.stubEnv("PUBLIC_ANIMALS_SOURCE", "firestore");
    mockFsGet.mockResolvedValue({ id: "a1" });

    expect(await getPublicAnimal("a1")).toEqual({ id: "a1" });
    expect(mockFsGet).toHaveBeenCalledWith("a1");
    expect(mockGetRegistryDb).not.toHaveBeenCalled();
  });

  test("postgres failure fails closed to null without Firestore fallback", async () => {
    vi.stubEnv("PUBLIC_ANIMALS_SOURCE", "postgres");
    mockGetRegistryDb.mockImplementation(() => {
      throw new Error("Postgres registry is not configured");
    });

    expect(await getPublicAnimal("a1")).toBeNull();
    expect(mockFsGet).not.toHaveBeenCalled();
    expect(mockLogError).toHaveBeenCalledOnce();
  });
});

describe("toAnimal", () => {
  test("maps the registry DTO onto the public Animal shape", () => {
    const animal = toAnimal({
      id: "legacy-1",
      name: "Rex",
      species: "dog",
      sex: "male",
      approxAge: "3 years",
      description: "Good dog",
      photoUrls: ["https://img/1.jpg"],
      createdAt: "2025-06-01T12:00:00.000Z",
      updatedAt: "2025-06-02T12:00:00.000Z",
    });

    expect(animal).toEqual({
      id: "legacy-1",
      name: "Rex",
      species: "dog",
      sex: "male",
      approxAge: "3 years",
      description: "Good dog",
      status: "available",
      photos: ["https://img/1.jpg"],
      createdAt: "2025-06-01T12:00:00.000Z",
      updatedAt: "2025-06-02T12:00:00.000Z",
    });
  });

  test("null optional fields become empty strings/arrays", () => {
    const animal = toAnimal({
      id: "x",
      name: "N",
      species: "cat",
      sex: "female",
      approxAge: null,
      description: null,
      photoUrls: [],
      createdAt: "2025-06-01T12:00:00.000Z",
      updatedAt: "2025-06-01T12:00:00.000Z",
    });
    expect(animal.approxAge).toBe("");
    expect(animal.description).toBe("");
    expect(animal.photos).toEqual([]);
  });
});
