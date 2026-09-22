"use client";

import { useState, useEffect } from "react";
import { collection, getDocs, addDoc, updateDoc, deleteDoc, doc } from "firebase/firestore";
import { db } from "@/lib/firebase";
import { Animal } from "@/lib/types";
import {
  ANIMAL_STATUSES,
  ANIMAL_STATUS_LABELS,
  AnimalStatus,
  getAnimalStatusVisibilityHint,
  isAnimalStatus,
} from "@/lib/animal-lifecycle";
import { AnimalStatusBadge } from "@/components/admin/animal-status-badge";
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
import { Plus, Pencil, Trash2 } from "lucide-react";
import { logError } from "@/lib/logger";
import { ConfirmDialog } from "@/components/admin/confirm-dialog";
import { LoadError } from "@/components/admin/load-error";

const EMPTY_FORM = {
  name: "",
  species: "dog" as "dog" | "cat" | "other",
  sex: "unknown" as "male" | "female" | "unknown",
  approxAge: "",
  description: "",
  // Empty string means "no valid status chosen" — used when editing an
  // animal whose stored status is unrecognized so staff must pick one.
  status: "available" as AnimalStatus | "",
  photos: [] as string[],
};

export default function AnimalsManager() {
  const [animals, setAnimals] = useState<Animal[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editingAnimal, setEditingAnimal] = useState<Animal | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<Animal | null>(null);
  const [statusError, setStatusError] = useState("");
  const [initialFormJson, setInitialFormJson] = useState(() =>
    JSON.stringify(EMPTY_FORM),
  );
  const mutation = useMutation();
  const { toast } = useToast();

  const [formData, setFormData] = useState({ ...EMPTY_FORM });

  useEffect(() => {
    loadAnimals();
  }, []);

  const loadAnimals = async () => {
    setLoading(true);
    setLoadError(false);
    try {
      const querySnapshot = await getDocs(collection(db, "animals"));
      const animalsData = querySnapshot.docs.map((doc) => {
        const data = doc.data();
        return {
          id: doc.id,
          ...data,
          createdAt: data.createdAt?.toDate().toISOString(),
          updatedAt: data.updatedAt?.toDate().toISOString(),
        } as Animal;
      });
      setAnimals(animalsData);
    } catch (error) {
      logError("animals", "admin-load", error);
      setLoadError(true);
    } finally {
      setLoading(false);
    }
  };

  const handleSubmit = () => {
    // Never write an unrecognized status: unknown values fail closed
    // publicly but would corrupt the admin lifecycle view.
    if (!isAnimalStatus(formData.status)) {
      setStatusError("Select a valid animal status before saving.");
      return;
    }

    mutation.run(async () => {
      try {
        if (editingAnimal) {
          const docRef = doc(db, "animals", editingAnimal.id);
          await updateDoc(docRef, {
            ...formData,
            updatedAt: new Date(),
          });
          toast({ title: "Success", description: "Animal updated successfully" });
        } else {
          await addDoc(collection(db, "animals"), {
            ...formData,
            createdAt: new Date(),
            updatedAt: new Date(),
          });
          toast({ title: "Success", description: "Animal added successfully" });
        }

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

  const handleEdit = (animal: Animal) => {
    setEditingAnimal(animal);
    const editForm = {
      name: animal.name,
      species: animal.species,
      sex: animal.sex,
      approxAge: animal.approxAge,
      description: animal.description,
      status: isAnimalStatus(animal.status) ? animal.status : ("" as const),
      photos: animal.photos || [],
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
        await deleteDoc(doc(db, "animals", target.id));
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

  if (loading) {
    return <div>Loading...</div>;
  }

  if (loadError) {
    return <LoadError label="animals" onRetry={loadAnimals} />;
  }

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
        <h1 className="text-3xl font-bold">Manage Animals</h1>
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
                {editingAnimal ? "Update animal information" : "Add a new animal to the adoption list"}
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
              <div>
                <Label htmlFor="age">Approximate Age</Label>
                <Input
                  id="age"
                  value={formData.approxAge}
                  onChange={(e) => setFormData({ ...formData, approxAge: e.target.value })}
                  placeholder="e.g., 2 years, 6 months"
                />
              </div>
              <div>
                <Label htmlFor="description">Description</Label>
                <Textarea
                  id="description"
                  rows={4}
                  value={formData.description}
                  onChange={(e) => setFormData({ ...formData, description: e.target.value })}
                />
              </div>
              <div>
                <Label htmlFor="status">Status</Label>
                <Select
                  value={formData.status}
                  onValueChange={(value: any) => {
                    setFormData({ ...formData, status: value });
                    setStatusError("");
                  }}
                >
                  <SelectTrigger id="status" aria-invalid={!!statusError} aria-describedby={statusError ? "status-error" : undefined}>
                    <SelectValue placeholder="Choose a status" />
                  </SelectTrigger>
                  <SelectContent>
                    {ANIMAL_STATUSES.map((status) => (
                      <SelectItem key={status} value={status}>
                        {ANIMAL_STATUS_LABELS[status]}
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
                    {getAnimalStatusVisibilityHint(formData.status)}
                  </p>
                )}
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

      <Card>
        <CardHeader>
          <CardTitle>Animals List</CardTitle>
          <CardDescription>Manage all animals in the system</CardDescription>
        </CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Name</TableHead>
                <TableHead>Species</TableHead>
                <TableHead>Sex</TableHead>
                <TableHead>Age</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {animals.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={6} className="text-center text-gray-500">
                    No animals found. Add your first animal!
                  </TableCell>
                </TableRow>
              ) : (
                animals.map((animal) => (
                  <TableRow key={animal.id}>
                    <TableCell className="font-medium">{animal.name}</TableCell>
                    <TableCell className="capitalize">{animal.species}</TableCell>
                    <TableCell className="capitalize">{animal.sex}</TableCell>
                    <TableCell>{animal.approxAge}</TableCell>
                    <TableCell>
                      <AnimalStatusBadge status={animal.status} />
                    </TableCell>
                    <TableCell className="text-right space-x-2">
                      <Button
                        variant="ghost"
                        size="sm"
                        aria-label={`Edit ${animal.name}`}
                        onClick={() => handleEdit(animal)}
                      >
                        <Pencil className="h-4 w-4" />
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        aria-label={`Delete ${animal.name}`}
                        onClick={() => setDeleteTarget(animal)}
                      >
                        <Trash2 className="h-4 w-4 text-red-500" />
                      </Button>
                    </TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      <ConfirmDialog
        open={deleteTarget !== null}
        title="Delete animal"
        description={
          deleteTarget ? (
            <>
              Permanently delete the record for{" "}
              <strong>{deleteTarget.name || "this unnamed animal"}</strong>?
              This cannot be undone. If the animal was adopted or is
              temporarily unavailable, set a different status instead — that
              hides it from the public site while keeping the record.
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
