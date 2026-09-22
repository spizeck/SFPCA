"use client";

import { useState, useEffect, useCallback, useRef } from "react";
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
  AnimalAdoptionsContent,
  DEFAULT_ADOPTIONS_CONTENT,
  Partner,
  SuccessStory,
} from "@/lib/page-content";

type AnimalAdoptionsData = AnimalAdoptionsContent;

const INITIAL_DATA: AnimalAdoptionsData = {
  ...DEFAULT_ADOPTIONS_CONTENT,
  // Start new installs with empty story/partner slots to fill in; the
  // defaults exist so a missing document still renders good copy.
  successStories: [
    { name: "", story: "", image: "" },
    { name: "", story: "", image: "" },
    { name: "", story: "", image: "" },
  ],
  partners: [
    { name: "", logo: "" },
    { name: "", logo: "" },
    { name: "", logo: "" },
    { name: "", logo: "" },
  ],
};

export default function AnimalAdoptionsAdminPage() {
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const saveMutation = useMutation();
  const { toast } = useToast();

  const [data, setData] = useState<AnimalAdoptionsData>(INITIAL_DATA);

  // Snapshot of the last loaded/saved content; drift means unsaved edits.
  const snapshotRef = useRef("");
  const dirty = snapshotRef.current !== "" &&
    JSON.stringify(data) !== snapshotRef.current;
  useUnsavedChangesGuard(dirty);

  const loadData = useCallback(async () => {
    setLoading(true);
    setLoadError(false);
    try {
      const docRef = doc(db, "animalAdoptions", "main");
      const docSnap = await getDoc(docRef);

      if (docSnap.exists()) {
        setData(docSnap.data() as AnimalAdoptionsData);
        snapshotRef.current = JSON.stringify(docSnap.data());
      } else {
        // The editor only renders after a successful load, so `data`
        // still equals INITIAL_DATA here — snapshot that constant rather
        // than closing over state, which would make this callback
        // unstable and re-run the load effect on every edit.
        snapshotRef.current = JSON.stringify(INITIAL_DATA);
      }
    } catch (error) {
      logError("admin", "adoptions-content-load", error);
      setLoadError(true);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadData();
  }, [loadData]);

  const handleSave = () => {
    saveMutation.run(async () => {
      try {
        const docRef = doc(db, "animalAdoptions", "main");
        await setDoc(docRef, data);
        snapshotRef.current = JSON.stringify(data);
        toast({
          title: "Success",
          description: "Animal adoptions page updated successfully",
        });
      } catch (error) {
        logError("admin", "adoptions-content-save", error);
        toast({
          title: "Error",
          description:
            "Failed to save. Your changes are still here — try again.",
          variant: "destructive",
        });
      }
    });
  };

  const updateSuccessStory = (index: number, field: keyof SuccessStory, value: string) => {
    const newStories = [...data.successStories];
    newStories[index] = { ...newStories[index], [field]: value };
    setData({ ...data, successStories: newStories });
  };

  const updatePartner = (index: number, field: keyof Partner, value: string) => {
    const newPartners = [...data.partners];
    newPartners[index] = { ...newPartners[index], [field]: value };
    setData({ ...data, partners: newPartners });
  };

  if (loading) {
    return <div>Loading...</div>;
  }

  if (loadError) {
    return <LoadError label="adoptions page content" onRetry={loadData} />;
  }

  return (
    <div className="max-w-4xl mx-auto space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-3xl font-bold">Edit Animal Adoptions Page</h1>
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
          <CardTitle>Success Stories Section</CardTitle>
          <CardDescription>Section showcasing successful adoptions</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div>
            <Label htmlFor="success-title">Section Title</Label>
            <Input
              id="success-title"
              value={data.successTitle}
              onChange={(e) => setData({ ...data, successTitle: e.target.value })}
            />
          </div>
          <div>
            <Label htmlFor="success-description">Section Description</Label>
            <Textarea
              id="success-description"
              value={data.successDescription}
              onChange={(e) => setData({ ...data, successDescription: e.target.value })}
            />
          </div>
          
          {data.successStories.map((story, index) => (
            <div key={index} className="border p-4 rounded-lg space-y-3">
              <h4 className="font-semibold">Success Story {index + 1}</h4>
              <div>
                <Label htmlFor={`story-${index}-name`}>Animal Name</Label>
                <Input
                  id={`story-${index}-name`}
                  value={story.name}
                  onChange={(e) => updateSuccessStory(index, "name", e.target.value)}
                />
              </div>
              <div>
                <Label htmlFor={`story-${index}-story`}>Story</Label>
                <Textarea
                  id={`story-${index}-story`}
                  value={story.story}
                  onChange={(e) => updateSuccessStory(index, "story", e.target.value)}
                />
              </div>
              <div>
                <Label htmlFor={`story-${index}-image`}>Image (Emoji)</Label>
                <Input
                  id={`story-${index}-image`}
                  value={story.image}
                  onChange={(e) => updateSuccessStory(index, "image", e.target.value)}
                  placeholder="e.g., 🐕, 🐈"
                />
              </div>
            </div>
          ))}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Available Animals Section</CardTitle>
          <CardDescription>Section title and description</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div>
            <Label htmlFor="available-title">Section Title</Label>
            <Input
              id="available-title"
              value={data.availableTitle}
              onChange={(e) => setData({ ...data, availableTitle: e.target.value })}
            />
          </div>
          <div>
            <Label htmlFor="available-description">Section Description</Label>
            <Textarea
              id="available-description"
              value={data.availableDescription}
              onChange={(e) => setData({ ...data, availableDescription: e.target.value })}
            />
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Partner Organizations</CardTitle>
          <CardDescription>Section and partner information</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div>
            <Label htmlFor="partner-title">Section Title</Label>
            <Input
              id="partner-title"
              value={data.partnerTitle}
              onChange={(e) => setData({ ...data, partnerTitle: e.target.value })}
            />
          </div>
          <div>
            <Label htmlFor="partner-description">Section Description</Label>
            <Textarea
              id="partner-description"
              value={data.partnerDescription}
              onChange={(e) => setData({ ...data, partnerDescription: e.target.value })}
            />
          </div>
          
          {data.partners.map((partner, index) => (
            <div key={index} className="border p-4 rounded-lg space-y-3">
              <h4 className="font-semibold">Partner {index + 1}</h4>
              <div>
                <Label htmlFor={`partner-${index}-name`}>Organization Name</Label>
                <Input
                  id={`partner-${index}-name`}
                  value={partner.name}
                  onChange={(e) => updatePartner(index, "name", e.target.value)}
                />
              </div>
              <div>
                <Label htmlFor={`partner-${index}-logo`}>Logo (Emoji)</Label>
                <Input
                  id={`partner-${index}-logo`}
                  value={partner.logo}
                  onChange={(e) => updatePartner(index, "logo", e.target.value)}
                  placeholder="e.g., 🏥, 🐾"
                />
              </div>
            </div>
          ))}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Call-to-Action Section</CardTitle>
          <CardDescription>Bottom section with contact buttons</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div>
            <Label htmlFor="cta-title">Title</Label>
            <Input
              id="cta-title"
              value={data.ctaTitle}
              onChange={(e) => setData({ ...data, ctaTitle: e.target.value })}
            />
          </div>
          <div>
            <Label htmlFor="cta-description">Description</Label>
            <Textarea
              id="cta-description"
              value={data.ctaDescription}
              onChange={(e) => setData({ ...data, ctaDescription: e.target.value })}
            />
          </div>
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
