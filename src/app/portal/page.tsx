import { requireOwner } from "@/lib/auth";
import { redirect } from "next/navigation";
import {
  listPortalAnimals,
  listPortalPastAnimals,
} from "@/lib/registry/ownership";
import { householdsForPerson } from "@/lib/registry/persons";
import { listOwnerRequestsForPerson } from "@/lib/registry/owner-requests";
import { PortalClient } from "./portal-client";
import { PortalPending } from "./portal-pending";

export const dynamic = "force-dynamic";

export default async function PortalPage() {
  const ctx = await requireOwner();
  if (!ctx.authorized || !ctx.identity) {
    redirect("/login");
  }

  // No linked person: either the account-claim is waiting on staff, or
  // provisioning failed outright. Either way the portal shows nothing
  // but the pending state — never a guess at which person this account
  // might belong to.
  if (!ctx.person) {
    return <PortalPending email={ctx.identity.email} />;
  }

  const [animals, pastAnimals, households, requests] = await Promise.all([
    listPortalAnimals(ctx.person.id),
    listPortalPastAnimals(ctx.person.id),
    householdsForPerson(ctx.person.id),
    listOwnerRequestsForPerson(ctx.person.id),
  ]);

  return (
    <PortalClient
      person={ctx.person}
      animals={animals}
      pastAnimals={pastAnimals}
      households={households}
      requests={requests}
    />
  );
}
