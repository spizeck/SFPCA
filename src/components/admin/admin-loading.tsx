import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";

// Shared admin loading state (#280). Replaces bare `Loading...`
// divs — which announced nothing to screen readers and yanked the
// layout when content arrived — with a status-announced skeleton that
// roughly matches a page: title line, a wide card, then row lines.
// The pulse is motion-safe only (see Skeleton).
export function AdminLoading({
  label,
  rows = 3,
  className,
}: {
  // What is loading — announced to assistive tech as
  // "Loading <label>…". Defaults to a generic announcement.
  label?: string;
  rows?: number;
  className?: string;
}) {
  return (
    <div role="status" className={cn("max-w-4xl space-y-4", className)}>
      <span className="sr-only">Loading{label ? ` ${label}` : ""}…</span>
      <Skeleton className="h-8 w-48" />
      <Skeleton className="h-32 w-full" />
      {rows > 0 &&
        Array.from({ length: rows }).map((_, i) => (
          <Skeleton key={i} className="h-12 w-full" />
        ))}
    </div>
  );
}
