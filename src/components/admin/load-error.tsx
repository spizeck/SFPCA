import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";

// Load-failure state for admin pages (#91). Previously a failed query
// was indistinguishable from "no records" — worse, single-doc editors
// rendered blank fields that could overwrite live content with empty
// defaults on save. This component makes the failure explicit and gives
// staff a way to retry.
export function LoadError({
  label,
  onRetry,
}: {
  label: string;
  onRetry: () => void;
}) {
  return (
    <div className="max-w-4xl mx-auto">
      <Card>
        <CardContent className="pt-6 text-center space-y-3" role="alert">
          <p className="font-medium">Couldn&rsquo;t load {label}.</p>
          <p className="text-sm text-muted-foreground">
            Check your connection and try again. Nothing has been changed.
          </p>
          <Button variant="outline" onClick={onRetry}>
            Retry
          </Button>
        </CardContent>
      </Card>
    </div>
  );
}
