"use client";

// Staff people & households surface (#166). Persons are durable
// registry identities — they are never deleted here, and they outlive
// portal access, email changes, transfers, and departure from Saba.
// An auth_identities row is the login-side link; portal access exists
// exactly when an identity is linked to a person, and this page is the
// staff-side control for that link.

import { useEffect, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useToast } from "@/hooks/use-toast";
import {
  getPersonDetailAction,
  getPersonsDataAction,
  linkIdentityAction,
  removeHouseholdMemberAction,
  saveHouseholdAction,
  savePersonAction,
  setHouseholdMemberAction,
  unlinkIdentityAction,
} from "./actions";
import type {
  HouseholdRecord,
  PersonDetail,
  PersonRecord,
} from "@/lib/registry/persons";
import { logError } from "@/lib/logger";
import { LoadError } from "@/components/admin/load-error";
import { Plus } from "lucide-react";

function PersonForm({
  initial,
  onSave,
  onCancel,
  busy,
}: {
  initial: Partial<PersonRecord>;
  onSave: (input: {
    fullName: string;
    email: string | null;
    phone: string | null;
    address: string | null;
    preferredChannel: string | null;
    notes: string | null;
  }) => void;
  onCancel: () => void;
  busy: boolean;
}) {
  const [fullName, setFullName] = useState(initial.fullName ?? "");
  const [email, setEmail] = useState(initial.email ?? "");
  const [phone, setPhone] = useState(initial.phone ?? "");
  const [address, setAddress] = useState(initial.address ?? "");
  const [channel, setChannel] = useState(initial.preferredChannel ?? "");
  const [notes, setNotes] = useState(initial.notes ?? "");

  return (
    <div className="space-y-3">
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="space-y-1">
          <Label>Full name</Label>
          <Input value={fullName} onChange={(e) => setFullName(e.target.value)} />
        </div>
        <div className="space-y-1">
          <Label>Email</Label>
          <Input value={email} onChange={(e) => setEmail(e.target.value)} />
        </div>
        <div className="space-y-1">
          <Label>Phone</Label>
          <Input value={phone} onChange={(e) => setPhone(e.target.value)} />
        </div>
        <div className="space-y-1">
          <Label>Preferred contact</Label>
          <Select value={channel} onValueChange={setChannel}>
            <SelectTrigger>
              <SelectValue placeholder="Any" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="email">Email</SelectItem>
              <SelectItem value="phone">Phone</SelectItem>
              <SelectItem value="whatsapp">WhatsApp</SelectItem>
              <SelectItem value="sms">SMS</SelectItem>
            </SelectContent>
          </Select>
        </div>
      </div>
      <div className="space-y-1">
        <Label>Address</Label>
        <Input value={address} onChange={(e) => setAddress(e.target.value)} />
      </div>
      <div className="space-y-1">
        <Label>Staff notes</Label>
        <Input value={notes} onChange={(e) => setNotes(e.target.value)} />
      </div>
      <div className="flex gap-2">
        <Button
          size="sm"
          disabled={busy}
          onClick={() =>
            onSave({
              fullName,
              email: email || null,
              phone: phone || null,
              address: address || null,
              preferredChannel: channel || null,
              notes: notes || null,
            })
          }
        >
          Save
        </Button>
        <Button size="sm" variant="ghost" onClick={onCancel} disabled={busy}>
          Cancel
        </Button>
      </div>
    </div>
  );
}

function PersonDetailView({
  personId,
  onChanged,
}: {
  personId: string;
  onChanged: () => void;
}) {
  const { toast } = useToast();
  const [detail, setDetail] = useState<PersonDetail | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    getPersonDetailAction(personId)
      .then(setDetail)
      .catch((e) => logError("owners", "person-detail", e));
  }, [personId]);

  if (!detail) return <p className="text-sm text-muted-foreground">Loading…</p>;

  const act = async (run: () => Promise<{ ok: boolean; reason?: string }>) => {
    setBusy(true);
    try {
      const result = await run();
      if (!result.ok) {
        toast({ title: `Failed (${result.reason ?? "error"})`, variant: "destructive" });
      } else {
        const fresh = await getPersonDetailAction(personId);
        setDetail(fresh);
        onChanged();
      }
    } catch (error) {
      logError("owners", "person-action", error);
      toast({ title: "Failed", variant: "destructive" });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="border-t pt-3 mt-3 space-y-3 text-sm">
      <div>
        <p className="font-medium mb-1">Linked accounts</p>
        {detail.identities.length === 0 ? (
          <p className="text-muted-foreground">
            No portal account linked — this person cannot sign in.
          </p>
        ) : (
          <ul className="space-y-1">
            {detail.identities.map((i) => (
              <li key={i.id} className="flex items-center gap-2">
                <span>
                  {i.provider}:{i.providerUid.slice(0, 8)}…
                  {i.email ? ` (${i.email})` : ""}
                </span>
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={busy}
                  onClick={() => act(() => unlinkIdentityAction(i.id))}
                >
                  Unlink
                </Button>
              </li>
            ))}
          </ul>
        )}
      </div>
      <div>
        <p className="font-medium mb-1">Ownership history</p>
        {detail.ownerships.length === 0 ? (
          <p className="text-muted-foreground">No ownership records.</p>
        ) : (
          <ul className="space-y-1">
            {detail.ownerships.map((o) => (
              <li key={o.id}>
                {o.animalName} — {o.validFrom} → {o.validTo ?? "current"}
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

export default function PersonsPage() {
  const { toast } = useToast();
  const [data, setData] = useState<{
    persons: PersonRecord[];
    households: HouseholdRecord[];
  } | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const [query, setQuery] = useState("");
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [editing, setEditing] = useState<{
    person: Partial<PersonRecord>;
    id: string | null;
  } | null>(null);
  const [newHousehold, setNewHousehold] = useState(false);
  const [householdName, setHouseholdName] = useState("");
  const [householdAddress, setHouseholdAddress] = useState("");
  const [addMember, setAddMember] = useState<{
    householdId: string;
    personId: string;
  } | null>(null);
  const [busy, setBusy] = useState(false);

  const load = async () => {
    setLoading(true);
    setLoadError(false);
    try {
      setData(await getPersonsDataAction());
    } catch (error) {
      logError("owners", "load-persons", error);
      setLoadError(true);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
  }, []);

  if (loading) return <div>Loading...</div>;
  if (loadError || !data) return <LoadError label="people" onRetry={load} />;

  const q = query.trim().toLowerCase();
  const filtered = q
    ? data.persons.filter(
        (p) =>
          p.fullName.toLowerCase().includes(q) ||
          (p.email ?? "").toLowerCase().includes(q),
      )
    : data.persons;

  const savePerson = async (input: Parameters<typeof savePersonAction>[0]) => {
    setBusy(true);
    try {
      const result = await savePersonAction(
        input,
        editing?.id ?? null,
        editing?.person.updatedAt ?? undefined,
      );
      if (result.ok) {
        setEditing(null);
        await load();
      } else {
        toast({
          title: "Couldn't save",
          description:
            result.reason === "conflict"
              ? "Someone else edited this record — reload and try again."
              : `Invalid ${result.field ?? "input"}.`,
          variant: "destructive",
        });
      }
    } catch (error) {
      logError("owners", "save-person-ui", error);
      toast({ title: "Couldn't save", variant: "destructive" });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="max-w-4xl mx-auto space-y-6">
      <div className="flex items-center justify-between gap-4 flex-wrap">
        <div>
          <h1 className="text-3xl font-bold">People</h1>
          <p className="text-muted-foreground">
            Registry people and households — durable identities, not login
            accounts.
          </p>
        </div>
        <Button size="sm" onClick={() => setEditing({ person: {}, id: null })}>
          <Plus className="h-4 w-4 mr-1" /> Add person
        </Button>
      </div>

      <Input
        placeholder="Search name or email…"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        className="max-w-sm"
      />

      <Card>
        <CardHeader>
          <CardTitle>People ({filtered.length})</CardTitle>
        </CardHeader>
        <CardContent>
          {filtered.length === 0 ? (
            <p className="text-sm text-muted-foreground">No people found.</p>
          ) : (
            <ul className="divide-y">
              {filtered.map((p) => (
                <li key={p.id} className="py-3">
                  <div className="flex items-center justify-between gap-3">
                    <div className="text-sm">
                      <p className="font-medium">{p.fullName}</p>
                      <p className="text-muted-foreground">
                        {[p.email, p.phone].filter(Boolean).join(" · ") ||
                          "No contact details"}
                      </p>
                    </div>
                    <div className="flex gap-2">
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() =>
                          setExpandedId(expandedId === p.id ? null : p.id)
                        }
                      >
                        {expandedId === p.id ? "Hide" : "Details"}
                      </Button>
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => setEditing({ person: p, id: p.id })}
                      >
                        Edit
                      </Button>
                    </div>
                  </div>
                  {expandedId === p.id && (
                    <PersonDetailView personId={p.id} onChanged={load} />
                  )}
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="flex-row items-center justify-between space-y-0">
          <div>
            <CardTitle>Households</CardTitle>
            <CardDescription>
              A household is a shared contact group — not a login. Members
              can act on household-owned animals in the portal.
            </CardDescription>
          </div>
          <Button size="sm" variant="outline" onClick={() => setNewHousehold(true)}>
            <Plus className="h-4 w-4 mr-1" /> New household
          </Button>
        </CardHeader>
        <CardContent>
          {data.households.length === 0 ? (
            <p className="text-sm text-muted-foreground">No households.</p>
          ) : (
            <ul className="divide-y">
              {data.households.map((h) => (
                <li key={h.id} className="py-3 space-y-2">
                  <div className="flex items-center justify-between">
                    <p className="font-medium text-sm">
                      {h.name}
                      {h.address && (
                        <span className="text-muted-foreground font-normal">
                          {" "}
                          · {h.address}
                        </span>
                      )}
                    </p>
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() =>
                        setAddMember({ householdId: h.id, personId: "" })
                      }
                    >
                      Add member
                    </Button>
                  </div>
                  <ul className="text-sm space-y-1">
                    {h.members.map((m) => (
                      <li key={m.personId} className="flex items-center gap-2">
                        <span>
                          {m.fullName}
                          {m.role === "primary" && (
                            <Badge variant="secondary" className="ml-1">
                              primary
                            </Badge>
                          )}
                        </span>
                        <Button
                          size="sm"
                          variant="ghost"
                          disabled={busy}
                          onClick={async () => {
                            setBusy(true);
                            try {
                              await removeHouseholdMemberAction(h.id, m.personId);
                              await load();
                            } finally {
                              setBusy(false);
                            }
                          }}
                        >
                          Remove
                        </Button>
                      </li>
                    ))}
                    {h.members.length === 0 && (
                      <li className="text-muted-foreground">No members.</li>
                    )}
                  </ul>
                  {addMember?.householdId === h.id && (
                    <div className="flex items-center gap-2">
                      <Select
                        value={addMember.personId}
                        onValueChange={(v) =>
                          setAddMember({ householdId: h.id, personId: v })
                        }
                      >
                        <SelectTrigger className="w-64">
                          <SelectValue placeholder="Person…" />
                        </SelectTrigger>
                        <SelectContent>
                          {data.persons.map((p) => (
                            <SelectItem key={p.id} value={p.id}>
                              {p.fullName}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                      <Button
                        size="sm"
                        disabled={busy || !addMember.personId}
                        onClick={async () => {
                          setBusy(true);
                          try {
                            const result = await setHouseholdMemberAction(
                              h.id,
                              addMember.personId,
                              "member",
                            );
                            if (!result.ok) {
                              toast({ title: "Failed", variant: "destructive" });
                            } else {
                              setAddMember(null);
                              await load();
                            }
                          } finally {
                            setBusy(false);
                          }
                        }}
                      >
                        Add
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => setAddMember(null)}
                      >
                        Cancel
                      </Button>
                    </div>
                  )}
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      <Dialog open={editing !== null} onOpenChange={(o) => !o && setEditing(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{editing?.id ? "Edit person" : "Add person"}</DialogTitle>
            <DialogDescription>
              A person is a durable registry identity — not a login account.
            </DialogDescription>
          </DialogHeader>
          {editing && (
            <PersonForm
              initial={editing.person}
              onSave={savePerson}
              onCancel={() => setEditing(null)}
              busy={busy}
            />
          )}
        </DialogContent>
      </Dialog>

      <Dialog open={newHousehold} onOpenChange={setNewHousehold}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>New household</DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <div className="space-y-1">
              <Label>Name</Label>
              <Input
                value={householdName}
                onChange={(e) => setHouseholdName(e.target.value)}
                placeholder="e.g. Smith family"
              />
            </div>
            <div className="space-y-1">
              <Label>Address (optional)</Label>
              <Input
                value={householdAddress}
                onChange={(e) => setHouseholdAddress(e.target.value)}
              />
            </div>
            <Button
              size="sm"
              disabled={busy || !householdName.trim()}
              onClick={async () => {
                setBusy(true);
                try {
                  const result = await saveHouseholdAction(
                    { name: householdName, address: householdAddress || null },
                    null,
                  );
                  if (result.ok) {
                    setNewHousehold(false);
                    setHouseholdName("");
                    setHouseholdAddress("");
                    await load();
                  } else {
                    toast({ title: "Failed", variant: "destructive" });
                  }
                } finally {
                  setBusy(false);
                }
              }}
            >
              Create
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
