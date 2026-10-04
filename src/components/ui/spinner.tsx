import { LoaderCircle } from "lucide-react";
import { cn } from "@/lib/utils";

// Shared loading indicator (#280). Decorative — callers own the
// accessible loading semantics (Button renders it inside an
// aria-busy control; standalone uses should pair it with a text
// label or sr-only copy describing what is loading).
export function Spinner({ className }: { className?: string }) {
  return (
    <LoaderCircle
      className={cn("size-4 animate-spin", className)}
      aria-hidden="true"
    />
  );
}
