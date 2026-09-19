import {
  getRegistrationStatusLabel,
  isRegistrationStatus,
} from "@/lib/animal-registration";

// Color supports the text but never carries meaning alone. Unknown or
// malformed statuses are surfaced as needing attention rather than
// silently coerced to "Pending".
const STATUS_CLASSES: Record<string, string> = {
  pending: "bg-yellow-100 text-yellow-800",
  approved: "bg-green-100 text-green-800",
  rejected: "bg-red-100 text-red-800",
};

export function RegistrationStatusBadge({ status }: { status: string }) {
  const known = isRegistrationStatus(status);
  const classes = known ? STATUS_CLASSES[status] : "bg-red-100 text-red-800";

  return (
    <span
      className={`inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-xs font-medium ${classes}`}
    >
      <span>{getRegistrationStatusLabel(status)}</span>
      {!known && <span>· Needs review</span>}
    </span>
  );
}
