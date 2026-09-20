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
import { AnimalRegistration } from "@/lib/types";
import { Eye, CheckCircle, Download, XCircle, RotateCcw } from "lucide-react";
import { collection, getDocs, doc, updateDoc, serverTimestamp } from "firebase/firestore";
import { ref, getDownloadURL } from "firebase/storage";
import { db, storage } from "@/lib/firebase";
import {
  formatRegistrationTimestamp,
  registrationTimestampMillis,
  RegistrationStatus,
} from "@/lib/animal-registration";
import { RegistrationStatusBadge } from "@/components/admin/registration-status-badge";
import { logError } from "@/lib/logger";

export default function RegistrationsPage() {
  const [registrations, setRegistrations] = useState<AnimalRegistration[]>([]);
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState<AnimalRegistration | null>(null);
  const { toast } = useToast();

  useEffect(() => {
    loadRegistrations();
  }, []);

  const loadRegistrations = async () => {
    try {
      // No server-side orderBy: a query ordered on createdAt silently
      // drops documents that lack the field, which would hide malformed
      // records from staff. Sort client-side instead so everything
      // surfaces, newest first, undated records last.
      const querySnapshot = await getDocs(collection(db, "animalRegistrations"));
      const registrationsData: AnimalRegistration[] = [];

      querySnapshot.forEach((doc) => {
        registrationsData.push({ id: doc.id, ...doc.data() } as AnimalRegistration);
      });

      registrationsData.sort(
        (a, b) =>
          registrationTimestampMillis(b.createdAt) -
          registrationTimestampMillis(a.createdAt),
      );

      setRegistrations(registrationsData);
    } catch (error) {
      logError("admin", "registrations-load", error);
      toast({
        title: "Error",
        description: "Failed to load registrations from database.",
        variant: "destructive",
      });
    } finally {
      setLoading(false);
    }
  };

  const setStatus = async (id: string, status: RegistrationStatus) => {
    try {
      const registrationRef = doc(db, "animalRegistrations", id);
      await updateDoc(registrationRef, {
        status,
        updatedAt: serverTimestamp(),
      });

      setRegistrations(registrations.map(reg =>
        reg.id === id ? { ...reg, status } : reg
      ));

      toast({
        title: "Registration Updated",
        description: `Status changed to ${status}.`,
      });
    } catch (error) {
      logError("admin", "registration-update", error);
      toast({
        title: "Error",
        description: "Failed to update registration status.",
        variant: "destructive",
      });
    }
  };

  const handleViewReceipt = async (registration: AnimalRegistration) => {
    const receipt = registration.paymentReceipt;
    if (!receipt) {
      toast({
        title: "No Receipt",
        description: "No payment receipt was uploaded for this registration.",
        variant: "destructive",
      });
      return;
    }

    try {
      // New submissions store a storage path ("receipts/<id>"); older
      // documents may hold a full download URL.
      const url = receipt.startsWith("http")
        ? receipt
        : await getDownloadURL(ref(storage, receipt));
      window.open(url, "_blank");
    } catch (error) {
      logError("admin", "receipt-view", error);
      toast({
        title: "Error",
        description: "Could not load the payment receipt.",
        variant: "destructive",
      });
    }
  };

  if (loading) {
    return <div className="p-8">Loading...</div>;
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
                              onClick={() => setStatus(registration.id, "approved")}
                            >
                              <CheckCircle className="h-4 w-4" />
                            </Button>
                            <Button
                              variant="destructive"
                              size="sm"
                              aria-label="Reject registration"
                              onClick={() => setStatus(registration.id, "rejected")}
                            >
                              <XCircle className="h-4 w-4" />
                            </Button>
                          </>
                        )}
                        {(registration.status === "approved" || registration.status === "rejected") && (
                          <Button
                            variant="outline"
                            size="sm"
                            aria-label="Reopen registration as pending"
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
                      onClick={() => handleViewReceipt(selected)}
                    >
                      <Download className="h-4 w-4 mr-2" />
                      View Receipt
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
