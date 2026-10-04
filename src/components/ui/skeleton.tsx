import { cn } from "@/lib/utils";

// Loading placeholder (#280). Sized to the layout it replaces so
// content doesn't jump when real data lands. The pulse is
// motion-safe-only: under prefers-reduced-motion the block stays
// static rather than shimmering.
function Skeleton({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      aria-hidden="true"
      className={cn("rounded-md bg-muted motion-safe:animate-pulse", className)}
      {...props}
    />
  );
}

export { Skeleton };
