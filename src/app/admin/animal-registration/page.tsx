"use client";

import { useState, useEffect, useRef } from "react";
import { doc, getDoc, setDoc } from "firebase/firestore";
import { db } from "@/lib/firebase";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { useToast } from "@/hooks/use-toast";
import { useMutation } from "@/hooks/use-mutation";
import { useUnsavedChangesGuard } from "@/hooks/use-unsaved-changes";
import { LoadError } from "@/components/admin/load-error";
import { logError } from "@/lib/logger";
import {
  AnimalRegistrationContent,
  DEFAULT_REGISTRATION_CONTENT,
} from "@/lib/page-content";

type AnimalRegistrationData = AnimalRegistrationContent;

export default function AnimalRegistrationAdminPage() {
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const saveMutation = useMutation();
  const { toast } = useToast();
  const [data, setData] = useState<AnimalRegistrationData>(
    DEFAULT_REGISTRATION_CONTENT,
  );

  // Snapshot of the last loaded/saved content; drift means unsaved edits.
  const snapshotRef = useRef("");
  const dirty = snapshotRef.current !== "" &&
    JSON.stringify(data) !== snapshotRef.current;
  useUnsavedChangesGuard(dirty);

  useEffect(() => {
    loadData();
  }, []);

  const loadData = async () => {
    setLoading(true);
    setLoadError(false);
    try {
      const docRef = doc(db, "animalRegistration", "main");
      const docSnap = await getDoc(docRef);

      if (docSnap.exists()) {
        setData(docSnap.data() as AnimalRegistrationData);
        snapshotRef.current = JSON.stringify(docSnap.data());
      } else {
        snapshotRef.current = JSON.stringify(data);
      }
    } catch (error) {
      logError("admin", "registration-content-load", error);
      setLoadError(true);
    } finally {
      setLoading(false);
    }
  };

  const handleSave = () => {
    saveMutation.run(async () => {
      try {
        const docRef = doc(db, "animalRegistration", "main");
        await setDoc(docRef, data);
        snapshotRef.current = JSON.stringify(data);
        toast({
          title: "Success",
          description: "Animal registration page updated successfully",
        });
      } catch (error) {
        logError("admin", "registration-content-save", error);
        toast({
          title: "Error",
          description:
            "Failed to save. Your changes are still here — try again.",
          variant: "destructive",
        });
      }
    });
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

  if (loadError) {
    return <LoadError label="registration page content" onRetry={loadData} />;
  }

  return (
    <div className="max-w-4xl mx-auto space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold">Edit Animal Registration Page</h1>
          <p className="text-sm text-muted-foreground mt-1">
            This page edits descriptive copy only. Registration fees are
            defined in code and verified by staff — they cannot be changed
            here.
          </p>
        </div>
        <Button onClick={handleSave} disabled={saveMutation.pending}>
          {saveMutation.pending ? "Saving..." : "Save Changes"}
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
        <Button onClick={handleSave} disabled={saveMutation.pending} size="lg">
          {saveMutation.pending ? "Saving..." : "Save All Changes"}
        </Button>
      </div>
    </div>
  );
}
