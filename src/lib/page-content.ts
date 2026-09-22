// Editable page-content documents for the public animal-adoptions and
// animal-registration pages. Admin editors write `animalAdoptions/main`
// and `animalRegistration/main`; the public pages read them server-side
// at build time (content writes trigger a rebuild via the deploy-hook
// function's REBUILD_COLLECTIONS).
//
// These documents are copy only — titles, descriptions, and
// informational lists. They must never carry business logic: the
// registration fee schedule lives in src/lib/animal-registration.ts and
// is deliberately NOT editable here.
//
// A missing, empty, or malformed document must never break a public
// page: readers always run stored data through the normalize helpers,
// which merge valid fields over these defaults and fall back per field.

export interface SuccessStory {
  name: string;
  story: string;
  image: string;
}

export interface Partner {
  name: string;
  logo: string;
}

export interface AnimalAdoptionsContent {
  heroTitle: string;
  heroDescription: string;
  successTitle: string;
  successDescription: string;
  successStories: SuccessStory[];
  availableTitle: string;
  availableDescription: string;
  partnerTitle: string;
  partnerDescription: string;
  partners: Partner[];
  ctaTitle: string;
  ctaDescription: string;
}

export const DEFAULT_ADOPTIONS_CONTENT: AnimalAdoptionsContent = {
  heroTitle: "Animal Adoptions",
  heroDescription:
    "Find your perfect companion. Give a loving animal their forever home.",
  successTitle: "Success Stories",
  successDescription:
    "Heartwarming stories of animals who found their forever homes",
  successStories: [
    {
      name: "Bella",
      story:
        "Bella was found abandoned but now lives with a loving family who adores her.",
      image: "🐕",
    },
    {
      name: "Max",
      story:
        "Max spent 6 months in our shelter before finding his perfect match.",
      image: "🐈",
    },
    {
      name: "Luna",
      story:
        "Luna was rescued from the streets and is now living her best life.",
      image: "🐕",
    },
  ],
  availableTitle: "Available for Adoption",
  availableDescription:
    "These loving animals are waiting for their forever homes",
  partnerTitle: "Partner Organizations",
  partnerDescription:
    "We work with these amazing organizations to help more animals",
  partners: [
    { name: "Local Pet Rescue", logo: "🏥" },
    { name: "Animal Welfare Society", logo: "🐾" },
    { name: "Community Pet Network", logo: "🐕" },
    { name: "SABA Animal Control", logo: "🚐" },
  ],
  ctaTitle: "Ready to Adopt?",
  ctaDescription:
    "Take the first step in giving an animal a loving home. Contact us to start the adoption process.",
};

export interface AnimalRegistrationContent {
  heroTitle: string;
  heroDescription: string;
  formTitle: string;
  formDescription: string;
  howToPayTitle: string;
  howToPayItems: string[];
  whatHappensNextTitle: string;
  whatHappensNextItems: string[];
}

export const DEFAULT_REGISTRATION_CONTENT: AnimalRegistrationContent = {
  heroTitle: "Animal Registration",
  heroDescription:
    "Register your pet with SABA. Annual registration required for all animals.",
  formTitle: "Animal Registration Form",
  formDescription:
    "Please fill out all required fields. Registration must be renewed annually.",
  howToPayTitle: "How to Pay",
  howToPayItems: [
    "In person at our office",
    "Via bank transfer",
    "Through our online portal",
    "At participating vet clinics",
  ],
  whatHappensNextTitle: "What Happens Next",
  whatHappensNextItems: [
    "Submit this form with payment receipt",
    "We verify your payment within 24-48 hours",
    "You'll receive a registration certificate",
    "Annual renewal required",
  ],
};

// Stored documents are admin-written but unvalidated, so every field is
// checked defensively. Bad individual values fall back to the default
// for that field rather than failing the whole document.

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function pickString(
  source: Record<string, unknown>,
  key: string,
  fallback: string,
): string {
  const value = source[key];
  return typeof value === "string" ? value : fallback;
}

function pickStringList(
  source: Record<string, unknown>,
  key: string,
  fallback: string[],
): string[] {
  const value = source[key];
  if (!Array.isArray(value)) return fallback;
  const items = value.filter((item): item is string => typeof item === "string");
  return items.length > 0 ? items : fallback;
}

function pickStories(
  source: Record<string, unknown>,
  key: string,
  fallback: SuccessStory[],
): SuccessStory[] {
  const value = source[key];
  if (!Array.isArray(value)) return fallback;
  const stories = value.filter(
    (item): item is SuccessStory =>
      isRecord(item) &&
      typeof item.name === "string" &&
      typeof item.story === "string" &&
      typeof item.image === "string",
  );
  return stories.length > 0 ? stories : fallback;
}

function pickPartners(
  source: Record<string, unknown>,
  key: string,
  fallback: Partner[],
): Partner[] {
  const value = source[key];
  if (!Array.isArray(value)) return fallback;
  const partners = value.filter(
    (item): item is Partner =>
      isRecord(item) &&
      typeof item.name === "string" &&
      typeof item.logo === "string",
  );
  return partners.length > 0 ? partners : fallback;
}

export function normalizeAdoptionsContent(
  raw: unknown,
): AnimalAdoptionsContent {
  if (!isRecord(raw)) return DEFAULT_ADOPTIONS_CONTENT;
  const defaults = DEFAULT_ADOPTIONS_CONTENT;
  return {
    heroTitle: pickString(raw, "heroTitle", defaults.heroTitle),
    heroDescription: pickString(
      raw,
      "heroDescription",
      defaults.heroDescription,
    ),
    successTitle: pickString(raw, "successTitle", defaults.successTitle),
    successDescription: pickString(
      raw,
      "successDescription",
      defaults.successDescription,
    ),
    successStories: pickStories(
      raw,
      "successStories",
      defaults.successStories,
    ),
    availableTitle: pickString(
      raw,
      "availableTitle",
      defaults.availableTitle,
    ),
    availableDescription: pickString(
      raw,
      "availableDescription",
      defaults.availableDescription,
    ),
    partnerTitle: pickString(raw, "partnerTitle", defaults.partnerTitle),
    partnerDescription: pickString(
      raw,
      "partnerDescription",
      defaults.partnerDescription,
    ),
    partners: pickPartners(raw, "partners", defaults.partners),
    ctaTitle: pickString(raw, "ctaTitle", defaults.ctaTitle),
    ctaDescription: pickString(raw, "ctaDescription", defaults.ctaDescription),
  };
}

export function normalizeRegistrationContent(
  raw: unknown,
): AnimalRegistrationContent {
  if (!isRecord(raw)) return DEFAULT_REGISTRATION_CONTENT;
  const defaults = DEFAULT_REGISTRATION_CONTENT;
  return {
    heroTitle: pickString(raw, "heroTitle", defaults.heroTitle),
    heroDescription: pickString(
      raw,
      "heroDescription",
      defaults.heroDescription,
    ),
    formTitle: pickString(raw, "formTitle", defaults.formTitle),
    formDescription: pickString(
      raw,
      "formDescription",
      defaults.formDescription,
    ),
    howToPayTitle: pickString(raw, "howToPayTitle", defaults.howToPayTitle),
    howToPayItems: pickStringList(
      raw,
      "howToPayItems",
      defaults.howToPayItems,
    ),
    whatHappensNextTitle: pickString(
      raw,
      "whatHappensNextTitle",
      defaults.whatHappensNextTitle,
    ),
    whatHappensNextItems: pickStringList(
      raw,
      "whatHappensNextItems",
      defaults.whatHappensNextItems,
    ),
  };
}
