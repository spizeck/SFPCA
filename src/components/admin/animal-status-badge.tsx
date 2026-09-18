import {
  getAnimalStatusLabel,
  isAnimalStatus,
  isPublicAnimalStatus,
} from "@/lib/animal-lifecycle";

// Color supports the text but never carries meaning alone: every badge
// also spells out whether the animal is publicly listed.
const STATUS_CLASSES: Record<string, string> = {
  available: "bg-green-100 text-green-800",
  pending: "bg-yellow-100 text-yellow-800",
  adopted: "bg-gray-100 text-gray-800",
};

export function AnimalStatusBadge({ status }: { status: string }) {
  const known = isAnimalStatus(status);
  const classes = known ? STATUS_CLASSES[status] : "bg-red-100 text-red-800";
  const visibility = known && isPublicAnimalStatus(status)
    ? "Public"
    : "Not public";

  return (
    <span
      className={`inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-xs font-medium ${classes}`}
    >
      <span>{getAnimalStatusLabel(status)}</span>
      <span aria-hidden="true">·</span>
      <span>{visibility}</span>
    </span>
  );
}
