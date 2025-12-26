"use client";

import { useState, useEffect } from "react";
import { Homepage } from "@/lib/types";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { useToast } from "@/hooks/use-toast";
import { saveHomepageData, loadHomepageData } from "./actions";

export default function HomepageEditor() {
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const { toast } = useToast();
  
  const [data, setData] = useState<Homepage>({
    hero: {
      title: "",
      subtitle: "",
      ctaPrimary: "",
      ctaSecondary: "",
    },
    about: {
      title: "",
      content: "",
    },
    services: {
      title: "",
      items: [
        { title: "", description: "" },
        { title: "", description: "" },
        { title: "", description: "" },
      ],
    },
    donation: {
      title: "",
      content: "",
      paymentMethods: "",
    },
  });

  useEffect(() => {
    loadData();
  }, []);

  const loadData = async () => {
    try {
      const result = await loadHomepageData();
      if (result) {
        setData(result);
      }
    } catch (error) {
      console.error("Error loading homepage data:", error);
      toast({
        title: "Error",
        description: "Failed to load homepage data",
        variant: "destructive",
      });
    } finally {
      setLoading(false);
    }
  };

  const handleSave = async () => {
    setSaving(true);
    try {
      await saveHomepageData(data);
      
      toast({
        title: "Success",
        description: "Homepage content saved successfully",
      });
    } catch (error) {
      console.error("Error saving homepage data:", error);
      toast({
        title: "Error",
        description: "Failed to save homepage data",
        variant: "destructive",
      });
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return <div>Loading...</div>;
  }

  return (
    <div className="max-w-4xl mx-auto space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-3xl font-bold">Edit Homepage</h1>
        <Button onClick={handleSave} disabled={saving}>
          {saving ? "Saving..." : "Save Changes"}
        </Button>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Hero Section</CardTitle>
          <CardDescription>Main banner at the top of the homepage</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div>
            <Label htmlFor="hero-title">Title</Label>
            <Input
              id="hero-title"
              value={data.hero.title}
              onChange={(e) => setData({ ...data, hero: { ...data.hero, title: e.target.value } })}
            />
          </div>
          <div>
            <Label htmlFor="hero-subtitle">Subtitle</Label>
            <Textarea
              id="hero-subtitle"
              value={data.hero.subtitle}
              onChange={(e) => setData({ ...data, hero: { ...data.hero, subtitle: e.target.value } })}
            />
          </div>
          <div className="grid md:grid-cols-2 gap-4">
            <div>
              <Label htmlFor="hero-cta1">Primary Button Text</Label>
              <Input
                id="hero-cta1"
                value={data.hero.ctaPrimary}
                onChange={(e) => setData({ ...data, hero: { ...data.hero, ctaPrimary: e.target.value } })}
              />
            </div>
            <div>
              <Label htmlFor="hero-cta2">Secondary Button Text</Label>
              <Input
                id="hero-cta2"
                value={data.hero.ctaSecondary}
                onChange={(e) => setData({ ...data, hero: { ...data.hero, ctaSecondary: e.target.value } })}
              />
            </div>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>About Section</CardTitle>
          <CardDescription>Information about your organization</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div>
            <Label htmlFor="about-title">Title</Label>
            <Input
              id="about-title"
              value={data.about.title}
              onChange={(e) => setData({ ...data, about: { ...data.about, title: e.target.value } })}
            />
          </div>
          <div>
            <Label htmlFor="about-content">Content</Label>
            <Textarea
              id="about-content"
              rows={6}
              value={data.about.content}
              onChange={(e) => setData({ ...data, about: { ...data.about, content: e.target.value } })}
            />
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Services Section</CardTitle>
          <CardDescription>Your main services (3 items)</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div>
            <Label htmlFor="services-title">Section Title</Label>
            <Input
              id="services-title"
              value={data.services.title}
              onChange={(e) => setData({ ...data, services: { ...data.services, title: e.target.value } })}
            />
          </div>
          {data.services.items.map((item, index) => (
            <div key={index} className="border p-4 rounded-lg space-y-3">
              <h4 className="font-semibold">Service {index + 1}</h4>
              <div>
                <Label htmlFor={`service-${index}-title`}>Title</Label>
                <Input
                  id={`service-${index}-title`}
                  value={item.title}
                  onChange={(e) => {
                    const newItems = [...data.services.items];
                    newItems[index].title = e.target.value;
                    setData({ ...data, services: { ...data.services, items: newItems } });
                  }}
                />
              </div>
              <div>
                <Label htmlFor={`service-${index}-desc`}>Description</Label>
                <Textarea
                  id={`service-${index}-desc`}
                  value={item.description}
                  onChange={(e) => {
                    const newItems = [...data.services.items];
                    newItems[index].description = e.target.value;
                    setData({ ...data, services: { ...data.services, items: newItems } });
                  }}
                />
              </div>
            </div>
          ))}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Donation Section</CardTitle>
          <CardDescription>Information about donations</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div>
            <Label htmlFor="donation-title">Title</Label>
            <Input
              id="donation-title"
              value={data.donation.title}
              onChange={(e) => setData({ ...data, donation: { ...data.donation, title: e.target.value } })}
            />
          </div>
          <div>
            <Label htmlFor="donation-content">Content</Label>
            <Textarea
              id="donation-content"
              rows={3}
              value={data.donation.content}
              onChange={(e) => setData({ ...data, donation: { ...data.donation, content: e.target.value } })}
            />
          </div>
          <div>
            <Label htmlFor="donation-methods">Payment Methods</Label>
            <Textarea
              id="donation-methods"
              rows={4}
              value={data.donation.paymentMethods}
              onChange={(e) => setData({ ...data, donation: { ...data.donation, paymentMethods: e.target.value } })}
              placeholder="Bank transfer details, PayPal, etc."
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
