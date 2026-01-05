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

interface SuccessStory {
  name: string;
  story: string;
  image: string;
}

interface Partner {
  name: string;
  logo: string;
}

interface AnimalAdoptionsData {
  heroTitle: string;
  heroDescription: string;
  successTitle: string;
  successDescription: string;
  successStories: SuccessStory[];
  availableTitle: string;
  availableDescription: string;
  partnerTitle: string;
  partnerDescription: string;
  partners: Partner[];
  ctaTitle: string;
  ctaDescription: string;
}

export default function AnimalAdoptionsAdminPage() {
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const { toast } = useToast();
  
  const [data, setData] = useState<AnimalAdoptionsData>({
    heroTitle: "Animal Adoptions",
    heroDescription: "Find your perfect companion. Give a loving animal their forever home.",
    successTitle: "Success Stories",
    successDescription: "Heartwarming stories of animals who found their forever homes",
    successStories: [
      { name: "", story: "", image: "" },
      { name: "", story: "", image: "" },
      { name: "", story: "", image: "" },
    ],
    availableTitle: "Available for Adoption",
    availableDescription: "These loving animals are waiting for their forever homes",
    partnerTitle: "Partner Organizations",
    partnerDescription: "We work with these amazing organizations to help more animals",
    partners: [
      { name: "", logo: "" },
      { name: "", logo: "" },
      { name: "", logo: "" },
      { name: "", logo: "" },
    ],
    ctaTitle: "Ready to Adopt?",
    ctaDescription: "Take the first step in giving an animal a loving home. Contact us to start the adoption process.",
  });

  useEffect(() => {
    loadData();
  }, []);

  const loadData = async () => {
    try {
      const docRef = doc(db, "animalAdoptions", "main");
      const docSnap = await getDoc(docRef);
      
      if (docSnap.exists()) {
        setData(docSnap.data() as AnimalAdoptionsData);
      }
    } catch (error) {
      console.error("Error loading animal adoptions data:", error);
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
      const docRef = doc(db, "animalAdoptions", "main");
      await setDoc(docRef, data);
      
      toast({
        title: "Success",
        description: "Animal adoptions page updated successfully",
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

  return (
    <div className="max-w-4xl mx-auto space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-3xl font-bold">Edit Animal Adoptions Page</h1>
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
        <Button onClick={handleSave} disabled={saving} size="lg">
          {saving ? "Saving..." : "Save All Changes"}
        </Button>
      </div>
    </div>
  );
}
