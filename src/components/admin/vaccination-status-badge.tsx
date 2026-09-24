import {
  VACCINATION_DUE_STATE_LABELS,
  type VaccinationDueState,
} from "@/lib/vaccinations";

// Color supports the text but never carries meaning alone — the label
// always spells out the state.
const STATE_CLASSES: Record<VaccinationDueState, string> = {
  overdue: "bg-red-100 text-red-800",
  "due-soon": "bg-amber-100 text-amber-800",
  current: "bg-green-100 text-green-800",
  unscheduled: "bg-gray-100 text-gray-800",
};

export function VaccinationStatusBadge({
  state,
}: {
  state: VaccinationDueState;
}) {
  return (
    <span
      className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium ${STATE_CLASSES[state]}`}
    >
      {VACCINATION_DUE_STATE_LABELS[state]}
    </span>
  );
}
