import type { AnimalAdoptionStatus } from "./animal-lifecycle";

// The PUBLIC animal shape — what a visitor may see. status is the
// adoption-catalog state (always 'available' for rows that reach the
// public surface); the registry lifecycle is never part of this shape.
export interface Animal {
  id: string;
  name: string;
  species: "dog" | "cat" | "other";
  sex: "male" | "female" | "unknown";
  approxAge: string;
  description: string;
  status: AnimalAdoptionStatus;
  photos: string[];
  createdAt: string;
  updatedAt: string;
}

export interface HomepageSection {
  id: string;
  title: string;
  content: string;
  order: number;
}

export interface Homepage {
  hero: {
    title: string;
    subtitle: string;
  };
  about: {
    title: string;
    content: string;
  };
  whoWeAre?: {
    title: string;
    subtitle: string;
    team: Array<{
      name: string;
      role: string;
      bio: string;
      photo?: string;
    }>;
  };
  services: {
    title: string;
    items: Array<{
      title: string;
      description: string;
    }>;
  };
  whereWeAre?: {
    title: string;
    subtitle: string;
    address: string;
    mapEmbedUrl: string;
    hours: string;
  };
  donation: {
    title: string;
    content: string;
    paymentMethods: string;
  };
}

export interface SiteSettings {
  contact: {
    phone: string;
    email: string;
    whatsapp: string;
    address: string;
    hours: string;
  };
  social: {
    facebook?: string;
    instagram?: string;
    twitter?: string;
  };
  mapEmbedUrl?: string;
  locationCode?: string;
}

export interface AdminUser {
  email: string;
  role: "admin" | "editor";
  createdAt: Date;
}

export interface AnimalRegistrationData {
  name: string;
  type: string;
  sex: "male" | "female" | "";
  isFixed: "yes" | "no" | "";
}

export interface AnimalRegistration {
  id: string;
  ownerInfo: {
    name: string;
    address: string;
    phone: string;
    email: string;
  };
  animals: AnimalRegistrationData[];
  // Storage path of the uploaded receipt (e.g. "receipts/<id>"), or null
  // when no receipt was provided. Resolved to a download URL only in the
  // admin view via the Storage SDK.
  paymentReceipt?: string | null;
  // Receipt lifecycle (#130): receiptVerifiedAt is the server-side
  // stamp the 90-day retention clock runs from; receiptPurgedAt means
  // the binary was intentionally deleted under the retention policy —
  // render "removed", never a download button.
  receiptVerifiedAt?: string | null;
  receiptPurgedAt?: string | null;
  // Active retention hold, when staff exempted this submission from
  // automated purge/anonymization (#130).
  retentionHold?: {
    reason: string;
    createdByLabel: string;
    createdAt: string;
  } | null;
  totalFee: number;
  status: "pending" | "approved" | "rejected";
  // Portal-originated request provenance (#297): 'portal' rows carry
  // the canonical animal/person linkage the owner already had, so staff
  // never re-match. Public intake rows leave every one of these unset.
  source?: "public" | "portal";
  linkedAnimalId?: string | null;
  linkedAnimalName?: string | null;
  linkedAnimalRegistryRef?: string | null;
  requestedYear?: number | null;
  // Owner-supplied "something changed" claim — staff review it, it is
  // never auto-applied to canonical records.
  ownerNote?: string | null;
  createdAt: string;
  updatedAt: string;
}
