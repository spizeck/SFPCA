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

interface VetService {
  title: string;
  description: string;
  price: string;
  icon: string;
}

interface VetServicesData {
  heroTitle: string;
  heroDescription: string;
  ctaTitle: string;
  ctaDescription: string;
  services: VetService[];
}

export default function VetServicesAdminPage() {
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const { toast } = useToast();
  
  const [data, setData] = useState<VetServicesData>({
    heroTitle: "Veterinary Services",
    heroDescription: "Professional and affordable veterinary care for your beloved pets",
    ctaTitle: "Ready to Book an Appointment?",
    ctaDescription: "Contact us today to schedule a visit for your pet. Our caring team is ready to help!",
    services: [
      { title: "", description: "", price: "", icon: "" },
      { title: "", description: "", price: "", icon: "" },
      { title: "", description: "", price: "", icon: "" },
      { title: "", description: "", price: "", icon: "" },
      { title: "", description: "", price: "", icon: "" },
      { title: "", description: "", price: "", icon: "" },
    ],
  });

  useEffect(() => {
    loadData();
  }, []);

  const loadData = async () => {
    try {
      const docRef = doc(db, "vetServices", "main");
      const docSnap = await getDoc(docRef);
      
      if (docSnap.exists()) {
        setData(docSnap.data() as VetServicesData);
      }
    } catch (error) {
      console.error("Error loading vet services data:", error);
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
      const docRef = doc(db, "vetServices", "main");
      await setDoc(docRef, data);
      
      toast({
        title: "Success",
        description: "Veterinary services page updated successfully",
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

  const updateService = (index: number, field: keyof VetService, value: string) => {
    const newServices = [...data.services];
    newServices[index] = { ...newServices[index], [field]: value };
    setData({ ...data, services: newServices });
  };

  if (loading) {
    return <div>Loading...</div>;
  }

  return (
    <div className="max-w-4xl mx-auto space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-3xl font-bold">Edit Veterinary Services Page</h1>
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
          <CardTitle>Services</CardTitle>
          <CardDescription>Edit the 6 service cards displayed on the page</CardDescription>
        </CardHeader>
        <CardContent className="space-y-6">
          {data.services.map((service, index) => (
            <div key={index} className="border p-4 rounded-lg space-y-3">
              <h4 className="font-semibold">Service {index + 1}</h4>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div>
                  <Label htmlFor={`service-${index}-title`}>Title</Label>
                  <Input
                    id={`service-${index}-title`}
                    value={service.title}
                    onChange={(e) => updateService(index, "title", e.target.value)}
                  />
                </div>
                <div>
                  <Label htmlFor={`service-${index}-price`}>Price</Label>
                  <Input
                    id={`service-${index}-price`}
                    value={service.price}
                    onChange={(e) => updateService(index, "price", e.target.value)}
                    placeholder="e.g., $50 or Starting at $50"
                  />
                </div>
              </div>
              <div>
                <Label htmlFor={`service-${index}-description`}>Description</Label>
                <Textarea
                  id={`service-${index}-description`}
                  value={service.description}
                  onChange={(e) => updateService(index, "description", e.target.value)}
                />
              </div>
              <div>
                <Label htmlFor={`service-${index}-icon`}>Icon (Emoji)</Label>
                <Input
                  id={`service-${index}-icon`}
                  value={service.icon}
                  onChange={(e) => updateService(index, "icon", e.target.value)}
                  placeholder="e.g., 🏥, 💉, 📍"
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
