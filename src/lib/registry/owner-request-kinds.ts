// Shared vocabulary for owner-originated requests (#166). Lives in its
// own dependency-free module because client components (the portal, the
// staff request queue) render these labels — importing them from
// owner-requests.ts would pull `server-only` into the client bundle.

export const OWNER_REQUEST_KINDS = [
  "account-claim",
  "no-longer-mine",
  "transfer",
  "lifecycle-deceased",
  "lifecycle-moved-off-saba",
] as const;
export type OwnerRequestKind = (typeof OWNER_REQUEST_KINDS)[number];

export const OWNER_REQUEST_KIND_LABELS: Record<OwnerRequestKind, string> = {
  "account-claim": "Account claim",
  "no-longer-mine": "No longer mine",
  transfer: "Transfer to new owner",
  "lifecycle-deceased": "Report deceased",
  "lifecycle-moved-off-saba": "Moved off Saba",
};

// Kinds an owner may file through the portal; 'account-claim' is
// created only by session provisioning, never by owner action.
export const OWNER_SUBMITTABLE_KINDS: readonly OwnerRequestKind[] = [
  "no-longer-mine",
  "transfer",
  "lifecycle-deceased",
  "lifecycle-moved-off-saba",
];
