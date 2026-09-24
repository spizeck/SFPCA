import {
  getAnimalAdoptionLabel,
  getAnimalLifecycleLabel,
  isAnimalAdoptionStatus,
  isAnimalLifecycleStatus,
} from "@/lib/animal-lifecycle";

// Color supports the text but never carries meaning alone: every badge
// also spells out what it says. Two deliberately separate badges —
// registry lifecycle (the animal's real state) and adoption listing
// (public catalog state) — so staff never confuse "deceased" with
// "not listed".

const LIFECYCLE_CLASSES: Record<string, string> = {
  active: "bg-green-100 text-green-800",
  unknown: "bg-yellow-100 text-yellow-800",
  "moved-off-saba": "bg-blue-100 text-blue-800",
  deceased: "bg-gray-100 text-gray-800",
};

export function AnimalLifecycleBadge({ status }: { status: string }) {
  const known = isAnimalLifecycleStatus(status);
  const classes = known
    ? LIFECYCLE_CLASSES[status]
    : "bg-red-100 text-red-800";
  return (
    <span
      className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium ${classes}`}
    >
      {getAnimalLifecycleLabel(status)}
    </span>
  );
}

const ADOPTION_CLASSES: Record<string, string> = {
  available: "bg-green-100 text-green-800",
  pending: "bg-yellow-100 text-yellow-800",
  adopted: "bg-gray-100 text-gray-800",
  "not-listed": "bg-gray-100 text-gray-600",
};

// The listing badge also states the public consequence — "Available"
// only reaches the public site while the animal is lifecycle 'active'.
export function AnimalAdoptionBadge({
  status,
  lifecycleStatus,
}: {
  status: string;
  lifecycleStatus?: string;
}) {
  const known = isAnimalAdoptionStatus(status);
  const classes = known
    ? ADOPTION_CLASSES[status]
    : "bg-red-100 text-red-800";
  const publiclyVisible =
    status === "available" && (lifecycleStatus ?? "active") === "active";
  return (
    <span
      className={`inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-xs font-medium ${classes}`}
    >
      <span>{getAnimalAdoptionLabel(status)}</span>
      <span aria-hidden="true">·</span>
      <span>{publiclyVisible ? "Public" : "Not public"}</span>
    </span>
  );
}
