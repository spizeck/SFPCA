import Link from "next/link";
import { Card, CardContent, CardDescription, CardHeader } from "@/components/ui/card";
import { PortalSignOut } from "./portal-sign-out";

// The state an unlinked identity sees. Two cases collapse to the same
// honest message on purpose — the portal never hints at whether a
// matching owner record exists:
//   - a claim was filed at login (email matched an unclaimed person) and
//     staff haven't resolved it;
//   - provisioning failed, so no person row exists at all.
export function PortalPending({ email }: { email: string | null }) {
  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Owner Portal</h1>
          {email && (
            <p className="text-sm text-muted-foreground">{email}</p>
          )}
        </div>
        <PortalSignOut />
      </div>
      <Card>
        <CardHeader>
          <h2 className="text-lg font-medium">Account under review</h2>
          <CardDescription>
            Your sign-in is working, but your account is not linked to an
            owner record yet.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3 text-sm text-muted-foreground">
          <p>
            If you recently created this account, our team needs to verify
            and link it to your registration — this usually happens shortly
            after signup. Please check back soon.
          </p>
          <p>
            If this takes longer than expected, contact us through the{" "}
            <Link href="/contact" className="text-primary underline">
              contact page
            </Link>{" "}
            and mention the email address you signed in with.
          </p>
        </CardContent>
      </Card>
    </div>
  );
}
