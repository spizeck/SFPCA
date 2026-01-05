"use client";

import { useState, useEffect } from "react";
import { doc, getDoc, setDoc } from "firebase/firestore";
import { db } from "@/lib/firebase";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { useToast } from "@/hooks/use-toast";

interface AnimalRegistrationData {
  heroTitle: string;
  heroDescription: string;
  fixedFee: string;
  notFixedFee: string;
  formTitle: string;
  formDescription: string;
  howToPayTitle: string;
  howToPayItems: string[];
  whatHappensNextTitle: string;
  whatHappensNextItems: string[];
}

export default function AnimalRegistrationAdminPage() {
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const { toast } = useToast();
  
  const [data, setData] = useState<AnimalRegistrationData>({
    heroTitle: "Animal Registration",
    heroDescription: "Register your pet with SABA. Annual registration required for all animals.",
    fixedFee: "10",
    notFixedFee: "100",
    formTitle: "Animal Registration Form",
    formDescription: "Please fill out all required fields. Registration must be renewed annually.",
    howToPayTitle: "How to Pay",
    howToPayItems: [
      "In person at our office",
      "Via bank transfer",
      "Through our online portal",
      "At participating vet clinics",
    ],
    whatHappensNextTitle: "What Happens Next",
    whatHappensNextItems: [
      "Submit this form with payment receipt",
      "We verify your payment within 24-48 hours",
      "You'll receive a registration certificate",
      "Annual renewal required",
    ],
  });

  useEffect(() => {
    loadData();
  }, []);

  const loadData = async () => {
    try {
      const docRef = doc(db, "animalRegistration", "main");
      const docSnap = await getDoc(docRef);
      
      if (docSnap.exists()) {
        setData(docSnap.data() as AnimalRegistrationData);
      }
    } catch (error) {
      console.error("Error loading animal registration data:", error);
      toast({
        title: "Error",
        description: "Failed to load data",
        variant: "destructive",
      });
    } finally {
      setLoading(false);
    }
  };

  const handleSave = async () => {
    setSaving(true);
    try {
      const docRef = doc(db, "animalRegistration", "main");
      await setDoc(docRef, data);
      
      toast({
        title: "Success",
        description: "Animal registration page updated successfully",
      });
    } catch (error) {
      console.error("Error saving data:", error);
      toast({
        title: "Error",
        description: "Failed to save data",
        variant: "destructive",
      });
    } finally {
      setSaving(false);
    }
  };

  const updateHowToPayItem = (index: number, value: string) => {
    const newItems = [...data.howToPayItems];
    newItems[index] = value;
    setData({ ...data, howToPayItems: newItems });
  };

  const updateWhatHappensNextItem = (index: number, value: string) => {
    const newItems = [...data.whatHappensNextItems];
    newItems[index] = value;
    setData({ ...data, whatHappensNextItems: newItems });
  };

  if (loading) {
    return <div>Loading...</div>;
  }

  return (
    <div className="max-w-4xl mx-auto space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-3xl font-bold">Edit Animal Registration Page</h1>
        <Button onClick={handleSave} disabled={saving}>
          {saving ? "Saving..." : "Save Changes"}
        </Button>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Hero Section</CardTitle>
          <CardDescription>Main banner at the top of the page</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div>
            <Label htmlFor="hero-title">Title</Label>
            <Input
              id="hero-title"
              value={data.heroTitle}
              onChange={(e) => setData({ ...data, heroTitle: e.target.value })}
            />
          </div>
          <div>
            <Label htmlFor="hero-description">Description</Label>
            <Textarea
              id="hero-description"
              value={data.heroDescription}
              onChange={(e) => setData({ ...data, heroDescription: e.target.value })}
            />
          </div>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div>
              <Label htmlFor="fixed-fee">Spayed/Neutered Fee ($)</Label>
              <Input
                id="fixed-fee"
                type="number"
                value={data.fixedFee}
                onChange={(e) => setData({ ...data, fixedFee: e.target.value })}
              />
            </div>
            <div>
              <Label htmlFor="not-fixed-fee">Not Fixed Fee ($)</Label>
              <Input
                id="not-fixed-fee"
                type="number"
                value={data.notFixedFee}
                onChange={(e) => setData({ ...data, notFixedFee: e.target.value })}
              />
            </div>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Registration Form</CardTitle>
          <CardDescription>Form section title and description</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div>
            <Label htmlFor="form-title">Form Title</Label>
            <Input
              id="form-title"
              value={data.formTitle}
              onChange={(e) => setData({ ...data, formTitle: e.target.value })}
            />
          </div>
          <div>
            <Label htmlFor="form-description">Form Description</Label>
            <Textarea
              id="form-description"
              value={data.formDescription}
              onChange={(e) => setData({ ...data, formDescription: e.target.value })}
            />
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Payment Information</CardTitle>
          <CardDescription>How to pay section</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div>
            <Label htmlFor="how-to-pay-title">Section Title</Label>
            <Input
              id="how-to-pay-title"
              value={data.howToPayTitle}
              onChange={(e) => setData({ ...data, howToPayTitle: e.target.value })}
            />
          </div>
          {data.howToPayItems.map((item, index) => (
            <div key={index}>
              <Label htmlFor={`how-to-pay-${index}`}>Payment Method {index + 1}</Label>
              <Input
                id={`how-to-pay-${index}`}
                value={item}
                onChange={(e) => updateHowToPayItem(index, e.target.value)}
                placeholder="e.g., In person at our office"
              />
            </div>
          ))}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Process Information</CardTitle>
          <CardDescription>What happens next section</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div>
            <Label htmlFor="what-happens-next-title">Section Title</Label>
            <Input
              id="what-happens-next-title"
              value={data.whatHappensNextTitle}
              onChange={(e) => setData({ ...data, whatHappensNextTitle: e.target.value })}
            />
          </div>
          {data.whatHappensNextItems.map((item, index) => (
            <div key={index}>
              <Label htmlFor={`what-happens-${index}`}>Step {index + 1}</Label>
              <Input
                id={`what-happens-${index}`}
                value={item}
                onChange={(e) => updateWhatHappensNextItem(index, e.target.value)}
                placeholder="e.g., Submit this form with payment receipt"
              />
            </div>
          ))}
        </CardContent>
      </Card>

      <div className="flex justify-end">
        <Button onClick={handleSave} disabled={saving} size="lg">
          {saving ? "Saving..." : "Save All Changes"}
        </Button>
      </div>
    </div>
  );
}
