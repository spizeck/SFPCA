"use client";

// Per-animal medical record (#173). This is the staff-facing
// longitudinal view: today it shows vaccination history; #174 grows it
// into the full clinical timeline. Volunteer-first UX — a flat
// chronological table with derived status badges, not an EMR.

import { useEffect, useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import {
  getAnimalMedicalAction,
  saveVaccinationAction,
  type AnimalMedicalRecord,
} from "./actions";
import type { AdminVaccination } from "@/lib/registry/vaccinations";
import {
  effectiveVaccinationDate,
  isIsoDateString,
  todayIsoDate,
  vaccinationDueState,
} from "@/lib/vaccinations";
import { VaccinationStatusBadge } from "@/components/admin/vaccination-status-badge";
import { AnimalStatusBadge } from "@/components/admin/animal-status-badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { useToast } from "@/hooks/use-toast";
import { useMutation } from "@/hooks/use-mutation";
import { ArrowLeft, Plus, Pencil } from "lucide-react";
import { logError } from "@/lib/logger";
import { LoadError } from "@/components/admin/load-error";

const EMPTY_FORM = {
  vaccineName: "",
  administeredOn: "",
  dueOn: "",
  validUntil: "",
  administeredBy: "",
  productName: "",
  manufacturer: "",
  lotNumber: "",
  notes: "",
};

// Field-level messages — the server reports the offending field name
// and the UI translates it for volunteers.
const FIELD_MESSAGES: Record<string, string> = {
  vaccineName: "Enter the vaccine name (e.g. Rabies, DHPP).",
  administeredOn:
    "Enter the date the dose was given — it can't be in the future.",
  dueOn: "Next-due date can't be before the administered date.",
  validUntil: "Expiry date can't be before the administered date.",
};

export default function AnimalMedicalPage() {
  const params = useParams<{ id: string }>();
  const registryId = params.id;

  const [record, setRecord] = useState<AnimalMedicalRecord | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const [notFound, setNotFound] = useState(false);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editing, setEditing] = useState<AdminVaccination | null>(null);
  const [formData, setFormData] = useState({ ...EMPTY_FORM });
  const [initialFormJson, setInitialFormJson] = useState(() =>
    JSON.stringify(EMPTY_FORM),
  );
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  // Derived status is date-relative; fix "today" when the page loads so
  // rows don't shift mid-session.
  const [today] = useState(() => todayIsoDate());
  const mutation = useMutation();
  const { toast } = useToast();

  useEffect(() => {
    loadRecord();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [registryId]);

  const loadRecord = async () => {
    setLoading(true);
    setLoadError(false);
    try {
      const result = await getAnimalMedicalAction(registryId);
      if (!result) {
        setNotFound(true);
        setRecord(null);
      } else {
        setNotFound(false);
        setRecord(result);
      }
    } catch (error) {
      logError("vaccinations", "admin-load", error);
      setLoadError(true);
    } finally {
      setLoading(false);
    }
  };

  const validateForm = (): boolean => {
    const errors: Record<string, string> = {};
    if (!formData.vaccineName.trim()) {
      errors.vaccineName = FIELD_MESSAGES.vaccineName;
    }
    if (!isIsoDateString(formData.administeredOn)) {
      errors.administeredOn = "Enter the date the dose was given.";
    } else if (formData.administeredOn > today) {
      errors.administeredOn = FIELD_MESSAGES.administeredOn;
    }
    if (
      formData.dueOn &&
      (!isIsoDateString(formData.dueOn) ||
        formData.dueOn < formData.administeredOn)
    ) {
      errors.dueOn = FIELD_MESSAGES.dueOn;
    }
    if (
      formData.validUntil &&
      (!isIsoDateString(formData.validUntil) ||
        formData.validUntil < formData.administeredOn)
    ) {
      errors.validUntil = FIELD_MESSAGES.validUntil;
    }
    setFieldErrors(errors);
    return Object.keys(errors).length === 0;
  };

  const handleSubmit = () => {
    if (!validateForm()) return;

    mutation.run(async () => {
      try {
        const result = await saveVaccinationAction(
          {
            animalId: registryId,
            vaccineName: formData.vaccineName,
            administeredOn: formData.administeredOn,
            dueOn: formData.dueOn || null,
            validUntil: formData.validUntil || null,
            administeredBy: formData.administeredBy || null,
            productName: formData.productName || null,
            manufacturer: formData.manufacturer || null,
            lotNumber: formData.lotNumber || null,
            notes: formData.notes || null,
          },
          editing?.id ?? null,
          editing?.updatedAt,
        );
        if (!result.ok) {
          if (result.reason === "invalid" && result.field) {
            setFieldErrors({
              [result.field]:
                FIELD_MESSAGES[result.field] ??
                "Check this field and try again.",
            });
            return;
          }
          toast({
            title: "Error",
            description:
              result.reason === "conflict"
                ? "This record was changed by someone else. Reopen it to see the latest version."
                : "Failed to save vaccination. Your entries are kept — try again.",
            variant: "destructive",
          });
          return;
        }
        toast({
          title: "Success",
          description: editing
            ? "Vaccination updated"
            : "Vaccination added",
        });
        setDialogOpen(false);
        resetForm();
        loadRecord();
      } catch (error) {
        logError("vaccinations", "admin-save", error);
        toast({
          title: "Error",
          description:
            "Failed to save vaccination. Your entries are kept — try again.",
          variant: "destructive",
        });
      }
    });
  };

  const handleEdit = (vax: AdminVaccination) => {
    setEditing(vax);
    const editForm = {
      vaccineName: vax.vaccineName,
      administeredOn: vax.administeredOn,
      dueOn: vax.dueOn ?? "",
      validUntil: vax.validUntil ?? "",
      administeredBy: vax.administeredBy ?? "",
      productName: vax.productName ?? "",
      manufacturer: vax.manufacturer ?? "",
      lotNumber: vax.lotNumber ?? "",
      notes: vax.notes ?? "",
    };
    setFormData(editForm);
    setInitialFormJson(JSON.stringify(editForm));
    setFieldErrors({});
    setDialogOpen(true);
  };

  const formDirty = JSON.stringify(formData) !== initialFormJson;

  const resetForm = () => {
    setEditing(null);
    setFieldErrors({});
    setFormData({ ...EMPTY_FORM });
    setInitialFormJson(JSON.stringify(EMPTY_FORM));
  };

  const closeDialog = (open: boolean) => {
    if (open) {
      setDialogOpen(true);
      return;
    }
    if (
      formDirty &&
      !window.confirm("Discard unsaved changes to this vaccination?")
    ) {
      return;
    }
    setDialogOpen(false);
    resetForm();
  };

  if (loading) {
    return <div>Loading...</div>;
  }

  if (loadError) {
    return <LoadError label="medical record" onRetry={loadRecord} />;
  }

  if (notFound || !record) {
    return (
      <div className="max-w-4xl mx-auto">
        <Card>
          <CardHeader>
            <CardTitle>Animal not found</CardTitle>
            <CardDescription>
              This animal record doesn&apos;t exist or was removed.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Button asChild variant="outline">
              <Link href="/admin/animals">Back to animals</Link>
            </Button>
          </CardContent>
        </Card>
      </div>
    );
  }

  const { animal, vaccinations } = record;

  return (
    <div className="max-w-5xl mx-auto">
      <div className="mb-6">
        <Button variant="ghost" size="sm" asChild className="mb-2 -ml-2">
          <Link href="/admin/animals">
            <ArrowLeft className="h-4 w-4 mr-1" />
            Back to animals
          </Link>
        </Button>
        <div className="flex items-center gap-3 flex-wrap">
          <h1 className="text-3xl font-bold">{animal.name}</h1>
          <AnimalStatusBadge status={animal.lifecycleStatus} />
        </div>
        <p className="text-muted-foreground mt-1 capitalize">
          {animal.species} · {animal.sex}
          {animal.approxAge ? ` · ${animal.approxAge}` : ""}
        </p>
      </div>

      <Card>
        <CardHeader className="flex flex-row items-center justify-between space-y-0">
          <div>
            <CardTitle>Vaccinations</CardTitle>
            <CardDescription>
              Vaccination history, most recent first. &quot;Next
              date&quot; is the soonest of the next-due and expiry dates.
            </CardDescription>
          </div>
          <Dialog open={dialogOpen} onOpenChange={closeDialog}>
            <DialogTrigger asChild>
              <Button size="sm">
                <Plus className="h-4 w-4 mr-1" />
                Add vaccination
              </Button>
            </DialogTrigger>
            <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
              <DialogHeader>
                <DialogTitle>
                  {editing ? "Edit vaccination" : "Add vaccination"}
                </DialogTitle>
                <DialogDescription>
                  {editing
                    ? "Correct this vaccination record"
                    : `Record a dose given to ${animal.name}`}
                </DialogDescription>
              </DialogHeader>
              <div className="space-y-4 py-4">
                <div>
                  <Label htmlFor="vaccineName">Vaccine</Label>
                  <Input
                    id="vaccineName"
                    value={formData.vaccineName}
                    onChange={(e) =>
                      setFormData({ ...formData, vaccineName: e.target.value })
                    }
                    placeholder="e.g., Rabies, DHPP, FVRCP"
                    aria-invalid={!!fieldErrors.vaccineName}
                    aria-describedby={
                      fieldErrors.vaccineName ? "vaccineName-error" : undefined
                    }
                  />
                  {fieldErrors.vaccineName && (
                    <p
                      id="vaccineName-error"
                      role="alert"
                      className="text-xs text-red-600 mt-1"
                    >
                      {fieldErrors.vaccineName}
                    </p>
                  )}
                </div>
                <div className="grid grid-cols-3 gap-4">
                  <div>
                    <Label htmlFor="administeredOn">Date given</Label>
                    <Input
                      id="administeredOn"
                      type="date"
                      value={formData.administeredOn}
                      onChange={(e) =>
                        setFormData({
                          ...formData,
                          administeredOn: e.target.value,
                        })
                      }
                      aria-invalid={!!fieldErrors.administeredOn}
                      aria-describedby={
                        fieldErrors.administeredOn
                          ? "administeredOn-error"
                          : undefined
                      }
                    />
                    {fieldErrors.administeredOn && (
                      <p
                        id="administeredOn-error"
                        role="alert"
                        className="text-xs text-red-600 mt-1"
                      >
                        {fieldErrors.administeredOn}
                      </p>
                    )}
                  </div>
                  <div>
                    <Label htmlFor="dueOn">Next due</Label>
                    <Input
                      id="dueOn"
                      type="date"
                      value={formData.dueOn}
                      onChange={(e) =>
                        setFormData({ ...formData, dueOn: e.target.value })
                      }
                      aria-invalid={!!fieldErrors.dueOn}
                      aria-describedby={
                        fieldErrors.dueOn ? "dueOn-error" : undefined
                      }
                    />
                    {fieldErrors.dueOn && (
                      <p
                        id="dueOn-error"
                        role="alert"
                        className="text-xs text-red-600 mt-1"
                      >
                        {fieldErrors.dueOn}
                      </p>
                    )}
                  </div>
                  <div>
                    <Label htmlFor="validUntil">Valid until</Label>
                    <Input
                      id="validUntil"
                      type="date"
                      value={formData.validUntil}
                      onChange={(e) =>
                        setFormData({ ...formData, validUntil: e.target.value })
                      }
                      aria-invalid={!!fieldErrors.validUntil}
                      aria-describedby={
                        fieldErrors.validUntil ? "validUntil-error" : undefined
                      }
                    />
                    {fieldErrors.validUntil && (
                      <p
                        id="validUntil-error"
                        role="alert"
                        className="text-xs text-red-600 mt-1"
                      >
                        {fieldErrors.validUntil}
                      </p>
                    )}
                  </div>
                </div>
                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <Label htmlFor="administeredBy">Given by (optional)</Label>
                    <Input
                      id="administeredBy"
                      value={formData.administeredBy}
                      onChange={(e) =>
                        setFormData({
                          ...formData,
                          administeredBy: e.target.value,
                        })
                      }
                      placeholder="e.g., Dr. Smith"
                    />
                  </div>
                  <div>
                    <Label htmlFor="lotNumber">Lot/batch no. (optional)</Label>
                    <Input
                      id="lotNumber"
                      value={formData.lotNumber}
                      onChange={(e) =>
                        setFormData({ ...formData, lotNumber: e.target.value })
                      }
                    />
                  </div>
                </div>
                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <Label htmlFor="productName">Product (optional)</Label>
                    <Input
                      id="productName"
                      value={formData.productName}
                      onChange={(e) =>
                        setFormData({ ...formData, productName: e.target.value })
                      }
                      placeholder="e.g., Nobivac Rabies"
                    />
                  </div>
                  <div>
                    <Label htmlFor="manufacturer">
                      Manufacturer (optional)
                    </Label>
                    <Input
                      id="manufacturer"
                      value={formData.manufacturer}
                      onChange={(e) =>
                        setFormData({
                          ...formData,
                          manufacturer: e.target.value,
                        })
                      }
                    />
                  </div>
                </div>
                <div>
                  <Label htmlFor="vaxNotes">Notes (optional)</Label>
                  <Textarea
                    id="vaxNotes"
                    rows={3}
                    value={formData.notes}
                    onChange={(e) =>
                      setFormData({ ...formData, notes: e.target.value })
                    }
                  />
                </div>
                <Button
                  onClick={handleSubmit}
                  className="w-full"
                  disabled={mutation.pending}
                >
                  {mutation.pending
                    ? "Saving…"
                    : editing
                      ? "Update vaccination"
                      : "Add vaccination"}
                </Button>
              </div>
            </DialogContent>
          </Dialog>
        </CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Vaccine</TableHead>
                <TableHead>Given</TableHead>
                <TableHead>Next date</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Given by</TableHead>
                <TableHead className="text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {vaccinations.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={6} className="text-center text-gray-500">
                    No vaccinations recorded yet.
                  </TableCell>
                </TableRow>
              ) : (
                vaccinations.map((vax) => {
                  const effective = effectiveVaccinationDate(
                    vax.dueOn,
                    vax.validUntil,
                  );
                  const details = [vax.productName, vax.lotNumber]
                    .filter(Boolean)
                    .join(" · ");
                  return (
                    <TableRow key={vax.id}>
                      <TableCell>
                        <div className="font-medium">{vax.vaccineName}</div>
                        {details && (
                          <div className="text-xs text-muted-foreground">
                            {details}
                          </div>
                        )}
                      </TableCell>
                      <TableCell>{vax.administeredOn}</TableCell>
                      <TableCell>{effective ?? "—"}</TableCell>
                      <TableCell>
                        <VaccinationStatusBadge
                          state={vaccinationDueState(effective, today)}
                        />
                      </TableCell>
                      <TableCell>{vax.administeredBy ?? "—"}</TableCell>
                      <TableCell className="text-right">
                        <Button
                          variant="ghost"
                          size="sm"
                          aria-label={`Edit ${vax.vaccineName} vaccination`}
                          onClick={() => handleEdit(vax)}
                        >
                          <Pencil className="h-4 w-4" />
                        </Button>
                      </TableCell>
                    </TableRow>
                  );
                })
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </div>
  );
}
