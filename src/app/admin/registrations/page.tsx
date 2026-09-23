"use client";

import { useState, useEffect } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useToast } from "@/hooks/use-toast";
import { useMutation } from "@/hooks/use-mutation";
import { LoadError } from "@/components/admin/load-error";
import { AnimalRegistration } from "@/lib/types";
import { Eye, CircleCheckBig, Download, CircleX, RotateCcw } from "lucide-react";
import {
  getReceiptUrlAction,
  listRegistrationsAction,
  setRegistrationStatusAction,
} from "./actions";
import {
  formatRegistrationTimestamp,
  RegistrationStatus,
} from "@/lib/animal-registration";
import { RegistrationStatusBadge } from "@/components/admin/registration-status-badge";
import { logError } from "@/lib/logger";

export default function RegistrationsPage() {
  const [registrations, setRegistrations] = useState<AnimalRegistration[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const [selected, setSelected] = useState<AnimalRegistration | null>(null);
  // One mutation at a time: status changes and receipt lookups are
  // serialized so a double-click can never fire the same write twice.
  const mutation = useMutation();
  const { toast } = useToast();

  useEffect(() => {
    loadRegistrations();
  }, []);

  const loadRegistrations = async () => {
    setLoading(true);
    setLoadError(false);
    try {
      // Postgres returns submissions newest-first (submitted_at DESC);
      // every stored row has a timestamp, so nothing is silently hidden.
      setRegistrations(await listRegistrationsAction());
    } catch (error) {
      logError("admin", "registrations-load", error);
      setLoadError(true);
    } finally {
      setLoading(false);
    }
  };

  const setStatus = (id: string, status: RegistrationStatus) => {
    mutation.run(async () => {
      try {
        const result = await setRegistrationStatusAction(id, status);
        if (!result.ok) {
          toast({
            title: "Error",
            description: "Failed to update registration status. Try again.",
            variant: "destructive",
          });
          return;
        }

        setRegistrations((prev) =>
          prev.map((reg) => (reg.id === id ? { ...reg, status } : reg)),
        );

        toast({
          title: "Registration Updated",
          description: `Status changed to ${status}.`,
        });
      } catch (error) {
        logError("admin", "registration-update", error);
        toast({
          title: "Error",
          description: "Failed to update registration status. Try again.",
          variant: "destructive",
        });
      }
    }, `status-${id}`);
  };

  const handleViewReceipt = (registration: AnimalRegistration) => {
    const receipt = registration.paymentReceipt;
    if (!receipt) {
      toast({
        title: "No Receipt",
        description: "No payment receipt was uploaded for this registration.",
        variant: "destructive",
      });
      return;
    }

    mutation.run(async () => {
      try {
        // Postgres stores the object path ("receipts/<submissionId>");
        // the server action mints a short-lived signed URL so the
        // object itself stays private.
        const result = receipt.startsWith("http")
          ? { ok: true, url: receipt }
          : await getReceiptUrlAction(receipt);
        if (!result.ok || !result.url) throw new Error("no signed url");
        window.open(result.url, "_blank");
      } catch (error) {
        logError("admin", "receipt-view", error);
        toast({
          title: "Error",
          description: "Could not load the payment receipt. Try again.",
          variant: "destructive",
        });
      }
    }, `receipt-${registration.id}`);
  };

  if (loading) {
    return <div className="p-8">Loading...</div>;
  }

  if (loadError) {
    return (
      <div className="p-8">
        <LoadError label="registrations" onRetry={loadRegistrations} />
      </div>
    );
  }

  return (
    <div className="p-8">
      <div className="max-w-6xl mx-auto">
        <h1 className="text-3xl font-bold mb-8">Animal Registrations</h1>

        {/* Summary Cards */}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-6 mb-8">
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-sm font-medium">Total Registrations</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold">{registrations.length}</div>
            </CardContent>
          </Card>
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-sm font-medium">Pending Verification</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold">
                {registrations.filter(r => r.status === "pending").length}
              </div>
            </CardContent>
          </Card>
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-sm font-medium">Total Quoted Fees</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold">
                ${registrations.reduce((sum, r) => sum + (r.totalFee || 0), 0)}
              </div>
            </CardContent>
          </Card>
        </div>

        {/* Registrations Table */}
        <Card>
          <CardHeader>
            <CardTitle>All Registrations</CardTitle>
          </CardHeader>
          <CardContent>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Date</TableHead>
                  <TableHead>Owner</TableHead>
                  <TableHead>Animals</TableHead>
                  <TableHead>Total Fee</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {registrations.length === 0 && (
                  <TableRow>
                    <TableCell colSpan={6} className="text-center text-muted-foreground">
                      No registrations yet.
                    </TableCell>
                  </TableRow>
                )}
                {registrations.map((registration) => (
                  <TableRow key={registration.id}>
                    <TableCell>
                      {formatRegistrationTimestamp(registration.createdAt)}
                    </TableCell>
                    <TableCell>
                      <div>
                        <div className="font-medium">{registration.ownerInfo?.name ?? "—"}</div>
                        <div className="text-sm text-muted-foreground">{registration.ownerInfo?.phone ?? ""}</div>
                      </div>
                    </TableCell>
                    <TableCell>
                      <div className="space-y-1">
                        {(registration.animals ?? []).map((animal, index) => (
                          <div key={index} className="text-sm">
                            <div className="font-medium">{animal.name}</div>
                            <div className="text-muted-foreground">
                              {animal.type} • {animal.sex} • {animal.isFixed === "yes" ? "Fixed" : "Not Fixed"}
                            </div>
                          </div>
                        ))}
                      </div>
                    </TableCell>
                    <TableCell>${registration.totalFee ?? "—"}</TableCell>
                    <TableCell>
                      <RegistrationStatusBadge status={registration.status} />
                    </TableCell>
                    <TableCell>
                      <div className="flex gap-2">
                        <Button
                          variant="outline"
                          size="sm"
                          aria-label="View registration details"
                          onClick={() => setSelected(registration)}
                        >
                          <Eye className="h-4 w-4" />
                        </Button>
                        {registration.paymentReceipt && (
                          <Button
                            variant="outline"
                            size="sm"
                            aria-label="View payment receipt"
                            disabled={mutation.pending}
                            onClick={() => handleViewReceipt(registration)}
                          >
                            <Download className="h-4 w-4" />
                          </Button>
                        )}
                        {registration.status === "pending" && (
                          <>
                            <Button
                              size="sm"
                              aria-label="Verify registration"
                              disabled={mutation.pending}
                              onClick={() => setStatus(registration.id, "approved")}
                            >
                              <CircleCheckBig className="h-4 w-4" />
                            </Button>
                            <Button
                              variant="destructive"
                              size="sm"
                              aria-label="Reject registration"
                              disabled={mutation.pending}
                              onClick={() => setStatus(registration.id, "rejected")}
                            >
                              <CircleX className="h-4 w-4" />
                            </Button>
                          </>
                        )}
                        {(registration.status === "approved" || registration.status === "rejected") && (
                          <Button
                            variant="outline"
                            size="sm"
                            aria-label="Reopen registration as pending"
                            disabled={mutation.pending}
                            onClick={() => setStatus(registration.id, "pending")}
                          >
                            <RotateCcw className="h-4 w-4" />
                          </Button>
                        )}
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>

        {/* Registration detail */}
        <Dialog open={selected !== null} onOpenChange={(open) => !open && setSelected(null)}>
          <DialogContent className="max-w-lg">
            <DialogHeader>
              <DialogTitle>Registration Details</DialogTitle>
              <DialogDescription>
                Submitted {formatRegistrationTimestamp(selected?.createdAt)}
                {" · "}Last updated {formatRegistrationTimestamp(selected?.updatedAt)}
              </DialogDescription>
            </DialogHeader>
            {selected && (
              <div className="space-y-4 text-sm">
                <div className="flex items-center gap-2">
                  <span className="font-medium">Status:</span>
                  <RegistrationStatusBadge status={selected.status} />
                </div>
                <div>
                  <h4 className="font-medium mb-1">Owner</h4>
                  <p>{selected.ownerInfo?.name ?? "—"}</p>
                  <p className="text-muted-foreground">{selected.ownerInfo?.address ?? ""}</p>
                  <p className="text-muted-foreground">
                    {selected.ownerInfo?.phone ?? ""}
                    {selected.ownerInfo?.phone && selected.ownerInfo?.email ? " · " : ""}
                    {selected.ownerInfo?.email ?? ""}
                  </p>
                </div>
                <div>
                  <h4 className="font-medium mb-1">Animals ({(selected.animals ?? []).length})</h4>
                  <ul className="list-disc pl-5 space-y-1">
                    {(selected.animals ?? []).map((animal, index) => (
                      <li key={index}>
                        {animal.name} — {animal.type}, {animal.sex},{" "}
                        {animal.isFixed === "yes" ? "spayed/neutered" : "not fixed"}
                      </li>
                    ))}
                  </ul>
                </div>
                <div className="flex items-center justify-between border-t pt-3">
                  <span className="font-medium">Quoted fee: ${selected.totalFee ?? "—"}</span>
                  {selected.paymentReceipt && (
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={mutation.pending}
                      onClick={() => handleViewReceipt(selected)}
                    >
                      <Download className="h-4 w-4 mr-2" />
                      {mutation.pendingKey === `receipt-${selected.id}`
                        ? "Loading…"
                        : "View Receipt"}
                    </Button>
                  )}
                </div>
              </div>
            )}
          </DialogContent>
        </Dialog>
      </div>
    </div>
  );
}
