import { LoaderCircle } from "lucide-react";
import { cn } from "@/lib/utils";

// Shared loading indicator (#280). Decorative by default — Button
// renders it inside an aria-busy control. Standalone uses can pass
// `label` to get role="status" + sr-only text announcing what loads.
export function Spinner({
  className,
  label,
}: {
  className?: string;
  label?: string;
}) {
  const icon = (
    <LoaderCircle
      className={cn("size-4 animate-spin", className)}
      aria-hidden="true"
    />
  );
  if (!label) return icon;
  return (
    <span role="status" className="inline-flex">
      {icon}
      <span className="sr-only">{label}</span>
    </span>
  );
}
