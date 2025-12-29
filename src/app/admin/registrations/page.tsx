"use client";

import { useState, useEffect } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { useToast } from "@/hooks/use-toast";

interface AnimalRegistration {
  id: string;
  ownerName: string;
  ownerAddress: string;
  ownerPhone: string;
  ownerEmail: string;
  animalName: string;
  animalType: string;
  animalSex: string;
  isFixed: boolean;
  fee: number;
  paymentReceiptUrl: string;
  isVerified: boolean;
  submittedAt: string;
}

export default function RegistrationsPage() {
  const [registrations, setRegistrations] = useState<AnimalRegistration[]>([]);
  const [loading, setLoading] = useState(true);
  const { toast } = useToast();

  useEffect(() => {
    loadRegistrations();
  }, []);

  const loadRegistrations = async () => {
    // Mock data for now - replace with Firebase fetch
    const mockData: AnimalRegistration[] = [
      {
        id: "1",
        ownerName: "John Doe",
        ownerAddress: "123 Main St, Saba",
        ownerPhone: "555-1234",
        ownerEmail: "john@example.com",
        animalName: "Buddy",
        animalType: "Dog",
        animalSex: "Male",
        isFixed: true,
        fee: 10,
        paymentReceiptUrl: "/receipts/buddy.pdf",
        isVerified: false,
        submittedAt: "2024-12-28",
      },
      {
        id: "2",
        ownerName: "Jane Smith",
        ownerAddress: "456 Oak Ave, Saba",
        ownerPhone: "555-5678",
        ownerEmail: "jane@example.com",
        animalName: "Whiskers",
        animalType: "Cat",
        animalSex: "Female",
        isFixed: false,
        fee: 100,
        paymentReceiptUrl: "/receipts/whiskers.pdf",
        isVerified: true,
        submittedAt: "2024-12-27",
      },
    ];
    
    setRegistrations(mockData);
    setLoading(false);
  };

  const handleVerify = async (id: string) => {
    try {
      // Update in Firebase
      setRegistrations(registrations.map(reg => 
        reg.id === id ? { ...reg, isVerified: true } : reg
      ));
      
      toast({
        title: "Registration Verified",
        description: "The animal registration has been verified successfully.",
      });
    } catch (error) {
      toast({
        title: "Error",
        description: "Failed to verify registration.",
        variant: "destructive",
      });
    }
  };

  const handleViewReceipt = (url: string) => {
    window.open(url, "_blank");
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
                {registrations.filter(r => !r.isVerified).length}
              </div>
            </CardContent>
          </Card>
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-sm font-medium">Total Revenue</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold">
                ${registrations.reduce((sum, r) => sum + r.fee, 0)}
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
                  <TableHead>Animal</TableHead>
                  <TableHead>Type</TableHead>
                  <TableHead>Fee</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {registrations.map((registration) => (
                  <TableRow key={registration.id}>
                    <TableCell>{registration.submittedAt}</TableCell>
                    <TableCell>
                      <div>
                        <div className="font-medium">{registration.ownerName}</div>
                        <div className="text-sm text-muted-foreground">{registration.ownerPhone}</div>
                      </div>
                    </TableCell>
                    <TableCell>{registration.animalName}</TableCell>
                    <TableCell>
                      <div>
                        <div>{registration.animalType}</div>
                        <div className="text-sm text-muted-foreground">
                          {registration.animalSex} • {registration.isFixed ? "Fixed" : "Not Fixed"}
                        </div>
                      </div>
                    </TableCell>
                    <TableCell>${registration.fee}</TableCell>
                    <TableCell>
                      <Badge variant={registration.isVerified ? "default" : "secondary"}>
                        {registration.isVerified ? "Verified" : "Pending"}
                      </Badge>
                    </TableCell>
                    <TableCell>
                      <div className="flex gap-2">
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => handleViewReceipt(registration.paymentReceiptUrl)}
                        >
                          View Receipt
                        </Button>
                        {!registration.isVerified && (
                          <Button
                            size="sm"
                            onClick={() => handleVerify(registration.id)}
                          >
                            Verify
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
