"use client";

// The staff animal registry (#167): fast search across name, registry
// ref, microchip, owner/household, and identifying notes, with lifecycle
// and listing filters. Each row links to the canonical animal profile.
// The add/edit dialog manages CORE identity + listing fields only —
// registry lifecycle changes go through the profile's transition
// control so history is always preserved.

import Link from "next/link";
import { useState, useEffect } from "react";
import {
  deleteAnimalAction,
  saveAnimalAction,
  searchAnimalsAction,
  type AdminAnimalRow,
} from "./actions";
import {
  ANIMAL_ADOPTION_LABELS,
  ANIMAL_ADOPTION_STATUSES,
  ANIMAL_LIFECYCLE_LABELS,
  ANIMAL_LIFECYCLE_STATUSES,
  ANIMAL_STERILIZATION_STATUSES,
  formatAnimalAge,
  getAdoptionVisibilityHint,
  isAnimalAdoptionStatus,
  type AnimalAdoptionStatus,
  type AnimalLifecycleStatus,
} from "@/lib/animal-lifecycle";
import {
  AnimalAdoptionBadge,
  AnimalLifecycleBadge,
} from "@/components/admin/animal-status-badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useToast } from "@/hooks/use-toast";
import { useMutation } from "@/hooks/use-mutation";
import { Plus, Pencil, Trash, Search } from "lucide-react";
import { logError } from "@/lib/logger";
import { ConfirmDialog } from "@/components/admin/confirm-dialog";
import { LoadError } from "@/components/admin/load-error";

const STERILIZATION_LABELS: Record<string, string> = {
  unknown: "Unknown",
  sterilized: "Sterilized",
  intact: "Not sterilized",
};

const EMPTY_FORM = {
  name: "",
  species: "dog" as "dog" | "cat" | "other",
  sex: "unknown" as "male" | "female" | "unknown",
  birthDate: "",
  birthDateEstimated: false,
  description: "",
  identifyingNotes: "",
  lifecycleStatus: "active" as AnimalLifecycleStatus,
  // Empty string means "no valid listing state chosen" — used when
  // editing an animal whose stored value is unrecognized.
  adoptionStatus: "not-listed" as AnimalAdoptionStatus | "",
  sterilizationStatus: "unknown",
  sterilizedOn: "",
  sterilizedBy: "",
  photos: [] as string[],
};

export default function AnimalsManager() {
  const [animals, setAnimals] = useState<AdminAnimalRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editingAnimal, setEditingAnimal] = useState<AdminAnimalRow | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<AdminAnimalRow | null>(null);
  const [statusError, setStatusError] = useState("");
  const [initialFormJson, setInitialFormJson] = useState(() =>
    JSON.stringify(EMPTY_FORM),
  );
  const [query, setQuery] = useState("");
  const [lifecycleFilter, setLifecycleFilter] = useState("");
  const [adoptionFilter, setAdoptionFilter] = useState("");
  const mutation = useMutation();
  const { toast } = useToast();

  const [formData, setFormData] = useState({ ...EMPTY_FORM });

  useEffect(() => {
    const t = setTimeout(() => loadAnimals(), query ? 250 : 0);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query, lifecycleFilter, adoptionFilter]);

  const loadAnimals = async () => {
    setLoading(true);
    setLoadError(false);
    try {
      setAnimals(
        await searchAnimalsAction(query, {
          lifecycleStatus: lifecycleFilter || undefined,
          adoptionStatus: adoptionFilter || undefined,
        }),
      );
    } catch (error) {
      logError("animals", "admin-load", error);
      setLoadError(true);
    } finally {
      setLoading(false);
    }
  };

  const handleSubmit = () => {
    // Never write an unrecognized listing state: unknown values fail
    // closed publicly but would corrupt the admin view.
    if (!isAnimalAdoptionStatus(formData.adoptionStatus)) {
      setStatusError("Select a valid listing state before saving.");
      return;
    }

    mutation.run(async () => {
      try {
        const result = await saveAnimalAction(
          {
            name: formData.name,
            species: formData.species,
            sex: formData.sex,
            birthDate: formData.birthDate || null,
            birthDateEstimated: formData.birthDateEstimated,
            description: formData.description,
            identifyingNotes: formData.identifyingNotes,
            adoptionStatus: formData.adoptionStatus,
            sterilizationStatus: formData.sterilizationStatus,
            sterilizedOn: formData.sterilizedOn || null,
            sterilizedBy: formData.sterilizedBy,
            photoUrls: formData.photos,
            lifecycleStatus: formData.lifecycleStatus,
          },
          editingAnimal?.animal.id ?? null,
          editingAnimal?.animal.updatedAt,
        );
        if (!result.ok) {
          toast({
            title: "Error",
            description:
              result.reason === "conflict"
                ? "This animal was changed by someone else. Reopen it to see the latest version."
                : "Failed to save animal. Your entries are kept — try again.",
            variant: "destructive",
          });
          return;
        }
        toast({
          title: "Success",
          description: editingAnimal
            ? "Animal updated successfully"
            : "Animal added successfully",
        });

        setDialogOpen(false);
        resetForm();
        loadAnimals();
      } catch (error) {
        logError("animals", "admin-save", error);
        toast({
          title: "Error",
          description:
            "Failed to save animal. Your entries are kept — try again.",
          variant: "destructive",
        });
      }
    });
  };

  const handleEdit = (row: AdminAnimalRow) => {
    setEditingAnimal(row);
    const a = row.animal;
    const editForm = {
      name: a.name,
      species: a.species as "dog" | "cat" | "other",
      sex: a.sex as "male" | "female" | "unknown",
      birthDate: a.birthDate ?? "",
      birthDateEstimated: a.birthDateEstimated,
      description: a.description ?? "",
      identifyingNotes: a.identifyingNotes ?? "",
      lifecycleStatus: a.lifecycleStatus as AnimalLifecycleStatus,
      adoptionStatus: isAnimalAdoptionStatus(a.adoptionStatus)
        ? a.adoptionStatus
        : ("" as const),
      sterilizationStatus: a.sterilizationStatus,
      sterilizedOn: a.sterilizedOn ?? "",
      sterilizedBy: a.sterilizedBy ?? "",
      photos: a.photoUrls || [],
    };
    setFormData(editForm);
    setInitialFormJson(JSON.stringify(editForm));
    setStatusError("");
    setDialogOpen(true);
  };

  const handleDelete = () => {
    const target = deleteTarget;
    if (!target) return;
    mutation.run(async () => {
      try {
        const result = await deleteAnimalAction(target.animal.id);
        if (!result.ok) {
          toast({
            title: "Error",
            description: "Failed to delete animal. Try again.",
            variant: "destructive",
          });
          return;
        }
        setDeleteTarget(null);
        toast({ title: "Success", description: "Animal deleted successfully" });
        loadAnimals();
      } catch (error) {
        logError("animals", "admin-delete", error);
        toast({
          title: "Error",
          description: "Failed to delete animal. Try again.",
          variant: "destructive",
        });
      }
    });
  };

  // Dirty check compares against the form state as it was when the
  // dialog opened, so closing with edits can warn before discarding.
  const formDirty = JSON.stringify(formData) !== initialFormJson;

  const resetForm = () => {
    setEditingAnimal(null);
    setStatusError("");
    setFormData({ ...EMPTY_FORM });
    setInitialFormJson(JSON.stringify(EMPTY_FORM));
  };

  const closeDialog = (open: boolean) => {
    if (open) {
      setDialogOpen(true);
      return;
    }
    // Closing the dialog discards the form — warn when edits exist.
    if (formDirty && !window.confirm("Discard unsaved changes to this animal?")) {
      return;
    }
    setDialogOpen(false);
    resetForm();
  };

  return (
    <div className="max-w-6xl mx-auto">
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-3xl font-bold">Animal Registry</h1>
        <Dialog open={dialogOpen} onOpenChange={closeDialog}>
          <DialogTrigger asChild>
            <Button>
              <Plus className="h-4 w-4 mr-2" />
              Add Animal
            </Button>
          </DialogTrigger>
          <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
            <DialogHeader>
              <DialogTitle>{editingAnimal ? "Edit Animal" : "Add New Animal"}</DialogTitle>
              <DialogDescription>
                {editingAnimal
                  ? "Update animal information"
                  : "Add a new animal to the permanent registry"}
              </DialogDescription>
            </DialogHeader>
            <div className="space-y-4 py-4">
              <div>
                <Label htmlFor="name">Name</Label>
                <Input
                  id="name"
                  value={formData.name}
                  onChange={(e) => setFormData({ ...formData, name: e.target.value })}
                />
              </div>
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <Label htmlFor="species">Species</Label>
                  <Select value={formData.species} onValueChange={(value: any) => setFormData({ ...formData, species: value })}>
                    <SelectTrigger id="species">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="dog">Dog</SelectItem>
                      <SelectItem value="cat">Cat</SelectItem>
                      <SelectItem value="other">Other</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div>
                  <Label htmlFor="sex">Sex</Label>
                  <Select value={formData.sex} onValueChange={(value: any) => setFormData({ ...formData, sex: value })}>
                    <SelectTrigger id="sex">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="male">Male</SelectItem>
                      <SelectItem value="female">Female</SelectItem>
                      <SelectItem value="unknown">Unknown</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              </div>
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <Label htmlFor="birthDate">Birth date</Label>
                  <Input
                    id="birthDate"
                    type="date"
                    value={formData.birthDate}
                    onChange={(e) => setFormData({ ...formData, birthDate: e.target.value })}
                  />
                  <p className="text-xs text-muted-foreground mt-1">
                    Leave blank when unknown — never guess to fill the field.
                  </p>
                </div>
                <div className="flex items-end pb-2">
                  <label className="flex items-center gap-2 text-sm">
                    <input
                      type="checkbox"
                      checked={formData.birthDateEstimated}
                      disabled={!formData.birthDate}
                      onChange={(e) =>
                        setFormData({ ...formData, birthDateEstimated: e.target.checked })
                      }
                    />
                    Birth date is an estimate
                  </label>
                </div>
              </div>
              <div>
                <Label htmlFor="description">Description (public listing copy)</Label>
                <Textarea
                  id="description"
                  rows={3}
                  value={formData.description}
                  onChange={(e) => setFormData({ ...formData, description: e.target.value })}
                />
              </div>
              <div>
                <Label htmlFor="identifyingNotes">Identifying notes (staff only)</Label>
                <Textarea
                  id="identifyingNotes"
                  rows={2}
                  value={formData.identifyingNotes}
                  placeholder="Markings, scars, distinguishing features — never shown publicly"
                  onChange={(e) => setFormData({ ...formData, identifyingNotes: e.target.value })}
                />
              </div>
              {!editingAnimal && (
                <div>
                  <Label htmlFor="lifecycle">Initial registry status</Label>
                  <Select
                    value={formData.lifecycleStatus}
                    onValueChange={(value: any) => setFormData({ ...formData, lifecycleStatus: value })}
                  >
                    <SelectTrigger id="lifecycle">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {ANIMAL_LIFECYCLE_STATUSES.map((status) => (
                        <SelectItem key={status} value={status}>
                          {ANIMAL_LIFECYCLE_LABELS[status]}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <p className="text-xs text-muted-foreground mt-1">
                    Almost always &quot;Active on Saba&quot;. Use another
                    state only when recording an animal already known to be
                    deceased or off-island.
                  </p>
                </div>
              )}
              <div>
                <Label htmlFor="adoptionStatus">Adoption listing</Label>
                <Select
                  value={formData.adoptionStatus}
                  onValueChange={(value: any) => {
                    setFormData({ ...formData, adoptionStatus: value });
                    setStatusError("");
                  }}
                >
                  <SelectTrigger id="adoptionStatus" aria-invalid={!!statusError} aria-describedby={statusError ? "status-error" : undefined}>
                    <SelectValue placeholder="Choose a listing state" />
                  </SelectTrigger>
                  <SelectContent>
                    {ANIMAL_ADOPTION_STATUSES.map((status) => (
                      <SelectItem key={status} value={status}>
                        {ANIMAL_ADOPTION_LABELS[status]}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                {statusError ? (
                  <p id="status-error" role="alert" className="text-xs text-red-600 mt-1">
                    {statusError}
                  </p>
                ) : (
                  <p className="text-xs text-muted-foreground mt-1">
                    {getAdoptionVisibilityHint(
                      editingAnimal?.animal.lifecycleStatus ?? formData.lifecycleStatus,
                      formData.adoptionStatus,
                    )}
                  </p>
                )}
              </div>
              <div className="grid grid-cols-3 gap-4">
                <div>
                  <Label htmlFor="sterilizationStatus">Sterilization</Label>
                  <Select
                    value={formData.sterilizationStatus}
                    onValueChange={(value: any) => setFormData({ ...formData, sterilizationStatus: value })}
                  >
                    <SelectTrigger id="sterilizationStatus">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {ANIMAL_STERILIZATION_STATUSES.map((s) => (
                        <SelectItem key={s} value={s}>
                          {STERILIZATION_LABELS[s]}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div>
                  <Label htmlFor="sterilizedOn">Sterilized on</Label>
                  <Input
                    id="sterilizedOn"
                    type="date"
                    value={formData.sterilizedOn}
                    disabled={formData.sterilizationStatus !== "sterilized"}
                    onChange={(e) => setFormData({ ...formData, sterilizedOn: e.target.value })}
                  />
                </div>
                <div>
                  <Label htmlFor="sterilizedBy">Sterilized by</Label>
                  <Input
                    id="sterilizedBy"
                    value={formData.sterilizedBy}
                    disabled={formData.sterilizationStatus !== "sterilized"}
                    placeholder="Clinic or vet"
                    onChange={(e) => setFormData({ ...formData, sterilizedBy: e.target.value })}
                  />
                </div>
              </div>
              <div>
                <Label htmlFor="photos">Photo URL (optional)</Label>
                <Input
                  id="photos"
                  value={formData.photos[0] || ""}
                  onChange={(e) => setFormData({ ...formData, photos: e.target.value ? [e.target.value] : [] })}
                  placeholder="https://example.com/photo.jpg"
                />
                <p className="text-xs text-muted-foreground mt-1">
                  Enter a direct URL to the animal photo
                </p>
              </div>
              <Button onClick={handleSubmit} className="w-full" disabled={mutation.pending}>
                {mutation.pending
                  ? "Saving…"
                  : editingAnimal
                    ? "Update Animal"
                    : "Add Animal"}
              </Button>
            </div>
          </DialogContent>
        </Dialog>
      </div>

      <Card className="mb-6">
        <CardContent className="pt-6">
          <div className="flex flex-wrap gap-3">
            <div className="relative flex-1 min-w-64">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
              <Input
                className="pl-9"
                placeholder="Search name, registry ref, microchip, owner, identifying notes…"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                aria-label="Search animals"
              />
            </div>
            <Select value={lifecycleFilter} onValueChange={(v) => setLifecycleFilter(v === "all" ? "" : v)}>
              <SelectTrigger className="w-48" aria-label="Lifecycle filter">
                <SelectValue placeholder="All lifecycle states" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All lifecycle states</SelectItem>
                {ANIMAL_LIFECYCLE_STATUSES.map((s) => (
                  <SelectItem key={s} value={s}>
                    {ANIMAL_LIFECYCLE_LABELS[s]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Select value={adoptionFilter} onValueChange={(v) => setAdoptionFilter(v === "all" ? "" : v)}>
              <SelectTrigger className="w-44" aria-label="Listing filter">
                <SelectValue placeholder="All listing states" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All listing states</SelectItem>
                {ANIMAL_ADOPTION_STATUSES.map((s) => (
                  <SelectItem key={s} value={s}>
                    {ANIMAL_ADOPTION_LABELS[s]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Animals</CardTitle>
          <CardDescription>
            Every animal known to SFPCA — search or filter to find one.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {loading ? (
            <div>Loading...</div>
          ) : loadError ? (
            <LoadError label="animals" onRetry={loadAnimals} />
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Ref</TableHead>
                  <TableHead>Name</TableHead>
                  <TableHead>Species</TableHead>
                  <TableHead>Sex</TableHead>
                  <TableHead>Age</TableHead>
                  <TableHead>Registry status</TableHead>
                  <TableHead>Listing</TableHead>
                  <TableHead>Owner</TableHead>
                  <TableHead className="text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {animals.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={9} className="text-center text-gray-500">
                      No animals found.
                    </TableCell>
                  </TableRow>
                ) : (
                  animals.map((row) => {
                    const animal = row.animal;
                    return (
                      <TableRow key={animal.id}>
                        <TableCell className="font-mono text-xs">
                          {animal.registryRef}
                        </TableCell>
                        <TableCell className="font-medium">
                          <Link
                            href={`/admin/animals/${animal.id}`}
                            className="hover:underline"
                          >
                            {animal.name}
                          </Link>
                        </TableCell>
                        <TableCell className="capitalize">{animal.species}</TableCell>
                        <TableCell className="capitalize">{animal.sex}</TableCell>
                        <TableCell>
                          {formatAnimalAge(animal.birthDate, animal.birthDateEstimated) ?? "—"}
                        </TableCell>
                        <TableCell>
                          <AnimalLifecycleBadge status={animal.lifecycleStatus} />
                        </TableCell>
                        <TableCell>
                          <AnimalAdoptionBadge
                            status={animal.adoptionStatus}
                            lifecycleStatus={animal.lifecycleStatus}
                          />
                        </TableCell>
                        <TableCell className="text-sm">
                          {row.owners.join(", ") || "—"}
                        </TableCell>
                        <TableCell className="text-right space-x-2">
                          <Button
                            variant="ghost"
                            size="sm"
                            aria-label={`Edit ${animal.name}`}
                            onClick={() => handleEdit(row)}
                          >
                            <Pencil className="h-4 w-4" />
                          </Button>
                          <Button
                            variant="ghost"
                            size="sm"
                            aria-label={`Delete ${animal.name}`}
                            onClick={() => setDeleteTarget(row)}
                          >
                            <Trash className="h-4 w-4 text-red-500" />
                          </Button>
                        </TableCell>
                      </TableRow>
                    );
                  })
                )}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      <ConfirmDialog
        open={deleteTarget !== null}
        title="Delete animal"
        description={
          deleteTarget ? (
            <>
              Permanently delete the record for{" "}
              <strong>{deleteTarget.animal.name || "this unnamed animal"}</strong>?
              This cannot be undone and only works for records with no
              registry history. For an animal that has died, left Saba, or
              been adopted, update its registry status or listing on the
              profile instead — the record stays in the registry.
            </>
          ) : null
        }
        pending={mutation.pending}
        onConfirm={handleDelete}
        onCancel={() => setDeleteTarget(null)}
      />
    </div>
  );
}
