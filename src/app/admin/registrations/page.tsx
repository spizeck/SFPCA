"use client";

import { useState, useEffect } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { useToast } from "@/hooks/use-toast";
import { AnimalRegistration } from "@/lib/types";
import { Eye, CheckCircle, Download } from "lucide-react";
import { collection, getDocs, doc, updateDoc, query, orderBy } from "firebase/firestore";
import { db } from "@/lib/firebase";

export default function RegistrationsPage() {
  const [registrations, setRegistrations] = useState<AnimalRegistration[]>([]);
  const [loading, setLoading] = useState(true);
  const { toast } = useToast();

  useEffect(() => {
    loadRegistrations();
  }, []);

  const loadRegistrations = async () => {
    try {
      const registrationsQuery = query(
        collection(db, "animalRegistrations"),
        orderBy("createdAt", "desc")
      );
      
      const querySnapshot = await getDocs(registrationsQuery);
      const registrationsData: AnimalRegistration[] = [];
      
      querySnapshot.forEach((doc) => {
        const data = doc.data();
        registrationsData.push({
          id: doc.id,
          ownerInfo: data.ownerInfo,
          animals: data.animals,
          paymentReceipt: data.paymentReceipt,
          totalFee: data.totalFee,
          status: data.status,
          createdAt: data.createdAt,
          updatedAt: data.updatedAt,
        });
      });
      
      setRegistrations(registrationsData);
    } catch (error) {
      console.error("Error loading registrations:", error);
      toast({
        title: "Error",
        description: "Failed to load registrations from database.",
        variant: "destructive",
      });
    } finally {
      setLoading(false);
    }
  };

  const handleVerify = async (id: string) => {
    try {
      // Update in Firebase
      const registrationRef = doc(db, "animalRegistrations", id);
      await updateDoc(registrationRef, {
        status: "approved",
        updatedAt: new Date().toISOString(),
      });
      
      // Update local state
      setRegistrations(registrations.map(reg => 
        reg.id === id ? { ...reg, status: "approved" as const } : reg
      ));
      
      toast({
        title: "Registration Verified",
        description: "The animal registration has been verified successfully.",
      });
    } catch (error) {
      console.error("Error verifying registration:", error);
      toast({
        title: "Error",
        description: "Failed to verify registration.",
        variant: "destructive",
      });
    }
  };

  const handleViewReceipt = (url?: string) => {
    if (url) {
      window.open(url, "_blank");
    } else {
      toast({
        title: "No Receipt",
        description: "No payment receipt was uploaded for this registration.",
        variant: "destructive",
      });
    }
  };

  const handleViewDetails = (registration: AnimalRegistration) => {
    // Detail view not yet implemented
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
              <CardTitle className="text-sm font-medium">Total Revenue</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold">
                ${registrations.reduce((sum, r) => sum + r.totalFee, 0)}
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
                {registrations.map((registration) => (
                  <TableRow key={registration.id}>
                    <TableCell>{registration.createdAt}</TableCell>
                    <TableCell>
                      <div>
                        <div className="font-medium">{registration.ownerInfo.name}</div>
                        <div className="text-sm text-muted-foreground">{registration.ownerInfo.phone}</div>
                      </div>
                    </TableCell>
                    <TableCell>
                      <div className="space-y-1">
                        {registration.animals.map((animal, index) => (
                          <div key={index} className="text-sm">
                            <div className="font-medium">{animal.name}</div>
                            <div className="text-muted-foreground">
                              {animal.type} • {animal.sex} • {animal.isFixed === "yes" ? "Fixed" : "Not Fixed"}
                            </div>
                          </div>
                        ))}
                      </div>
                    </TableCell>
                    <TableCell>${registration.totalFee}</TableCell>
                    <TableCell>
                      <Badge variant={registration.status === "approved" ? "default" : "secondary"}>
                        {registration.status === "approved" ? "Verified" : "Pending"}
                      </Badge>
                    </TableCell>
                    <TableCell>
                      <div className="flex gap-2">
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => handleViewDetails(registration)}
                        >
                          <Eye className="h-4 w-4" />
                        </Button>
                        {registration.paymentReceipt && (
                          <Button
                            variant="outline"
                            size="sm"
                            onClick={() => handleViewReceipt(registration.paymentReceipt)}
                          >
                            <Download className="h-4 w-4" />
                          </Button>
                        )}
                        {registration.status === "pending" && (
                          <Button
                            size="sm"
                            onClick={() => handleVerify(registration.id)}
                          >
                            <CheckCircle className="h-4 w-4" />
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
      </div>
    </div>
  );
}
