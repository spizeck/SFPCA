"use client";

import { useState, useEffect, useRef } from "react";
import { Homepage } from "@/lib/types";
import { TeamManager } from "@/components/admin/team-manager";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { useToast } from "@/hooks/use-toast";
import { useMutation } from "@/hooks/use-mutation";
import { useUnsavedChangesGuard } from "@/hooks/use-unsaved-changes";
import { LoadError } from "@/components/admin/load-error";
import { saveHomepageData, loadHomepageData } from "./actions";
import { logError } from "@/lib/logger";

export default function HomepageEditor() {
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const saveMutation = useMutation();
  const { toast } = useToast();

  const [data, setData] = useState<Homepage>({
    hero: {
      title: "",
      subtitle: "",
    },
    about: {
      title: "",
      content: "",
    },
    whoWeAre: {
      title: "",
      subtitle: "",
      team: [],
    },
    services: {
      title: "",
      items: [
        { title: "", description: "" },
        { title: "", description: "" },
        { title: "", description: "" },
      ],
    },
    whereWeAre: {
      title: "",
      subtitle: "",
      address: "",
      mapEmbedUrl: "",
      hours: "",
    },
    donation: {
      title: "",
      content: "",
      paymentMethods: "",
    },
  });

  // Snapshot of the last loaded/saved content; any drift from it means
  // there are unsaved edits worth guarding against accidental navigation.
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
      const result = await loadHomepageData();
      if (result) {
        setData(result);
        snapshotRef.current = JSON.stringify(result);
      } else {
        snapshotRef.current = JSON.stringify(data);
      }
    } catch (error) {
      logError("admin", "homepage-load", error);
      setLoadError(true);
    } finally {
      setLoading(false);
    }
  };

  const handleSave = () => {
    saveMutation.run(async () => {
      try {
        await saveHomepageData(data);
        snapshotRef.current = JSON.stringify(data);
        toast({
          title: "Success",
          description: "Homepage content saved successfully. Changes will appear on the live site within 1-2 minutes.",
          duration: 5000,
        });
      } catch (error) {
        logError("admin", "homepage-save", error);
        toast({
          title: "Error",
          description:
            "Failed to save homepage data. Your changes are still here — try again.",
          variant: "destructive",
        });
      }
    });
  };

  if (loading) {
    return <div>Loading...</div>;
  }

  if (loadError) {
    return <LoadError label="homepage content" onRetry={loadData} />;
  }

  return (
    <div className="max-w-4xl mx-auto space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-3xl font-bold">Edit Homepage</h1>
        <Button onClick={handleSave} disabled={saveMutation.pending}>
          {saveMutation.pending ? "Saving..." : "Save Changes"}
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
          <CardTitle>Who We Are Section</CardTitle>
          <CardDescription>Manage your team members</CardDescription>
        </CardHeader>
        <CardContent className="space-y-6">
          <div>
            <Label htmlFor="who-title">Section Title</Label>
            <Input
              id="who-title"
              value={data.whoWeAre?.title || ""}
              onChange={(e) => setData({ ...data, whoWeAre: { ...data.whoWeAre, title: e.target.value, subtitle: data.whoWeAre?.subtitle || "", team: data.whoWeAre?.team || [] } })}
            />
          </div>
          <div>
            <Label htmlFor="who-subtitle">Section Subtitle</Label>
            <Textarea
              id="who-subtitle"
              value={data.whoWeAre?.subtitle || ""}
              onChange={(e) => setData({ ...data, whoWeAre: { ...data.whoWeAre, title: data.whoWeAre?.title || "", subtitle: e.target.value, team: data.whoWeAre?.team || [] } })}
            />
          </div>
          
          <TeamManager
            team={data.whoWeAre?.team || []}
            onChange={(team) => setData({ ...data, whoWeAre: { ...data.whoWeAre, title: data.whoWeAre?.title || "", subtitle: data.whoWeAre?.subtitle || "", team } })}
          />
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
          <CardTitle>Where We Are Section</CardTitle>
          <CardDescription>Your location and contact information</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div>
            <Label htmlFor="where-title">Section Title</Label>
            <Input
              id="where-title"
              value={data.whereWeAre?.title || ""}
              onChange={(e) => setData({ ...data, whereWeAre: { title: e.target.value, subtitle: data.whereWeAre?.subtitle || "", address: data.whereWeAre?.address || "", mapEmbedUrl: data.whereWeAre?.mapEmbedUrl || "", hours: data.whereWeAre?.hours || "" } })}
            />
          </div>
          <div>
            <Label htmlFor="where-subtitle">Section Subtitle</Label>
            <Textarea
              id="where-subtitle"
              value={data.whereWeAre?.subtitle || ""}
              onChange={(e) => setData({ ...data, whereWeAre: { title: data.whereWeAre?.title || "", subtitle: e.target.value, address: data.whereWeAre?.address || "", mapEmbedUrl: data.whereWeAre?.mapEmbedUrl || "", hours: data.whereWeAre?.hours || "" } })}
            />
          </div>
          <div>
            <Label htmlFor="where-address">Address</Label>
            <Textarea
              id="where-address"
              rows={3}
              value={data.whereWeAre?.address || ""}
              onChange={(e) => setData({ ...data, whereWeAre: { title: data.whereWeAre?.title || "", subtitle: data.whereWeAre?.subtitle || "", address: e.target.value, mapEmbedUrl: data.whereWeAre?.mapEmbedUrl || "", hours: data.whereWeAre?.hours || "" } })}
              placeholder="Enter your full address"
            />
          </div>
          <div>
            <Label htmlFor="where-map">Google Maps Embed URL</Label>
            <Input
              id="where-map"
              value={data.whereWeAre?.mapEmbedUrl || ""}
              onChange={(e) => setData({ ...data, whereWeAre: { title: data.whereWeAre?.title || "", subtitle: data.whereWeAre?.subtitle || "", address: data.whereWeAre?.address || "", mapEmbedUrl: e.target.value, hours: data.whereWeAre?.hours || "" } })}
              placeholder="https://www.google.com/maps/embed?..."
            />
            <p className="text-sm text-muted-foreground mt-1">
              Get this from Google Maps: Share → Embed a map → Copy HTML
            </p>
          </div>
          <div>
            <Label htmlFor="where-hours">Opening Hours</Label>
            <Textarea
              id="where-hours"
              rows={4}
              value={data.whereWeAre?.hours || ""}
              onChange={(e) => setData({ ...data, whereWeAre: { title: data.whereWeAre?.title || "", subtitle: data.whereWeAre?.subtitle || "", address: data.whereWeAre?.address || "", mapEmbedUrl: data.whereWeAre?.mapEmbedUrl || "", hours: e.target.value } })}
              placeholder="Monday - Friday: 9:00 AM - 6:00 PM&#10;Saturday: 10:00 AM - 4:00 PM&#10;Sunday: Closed"
            />
          </div>
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
        <Button onClick={handleSave} disabled={saveMutation.pending} size="lg">
          {saveMutation.pending ? "Saving..." : "Save All Changes"}
        </Button>
      </div>
    </div>
  );
}
