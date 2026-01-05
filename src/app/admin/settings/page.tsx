"use client";

import { useState, useEffect } from "react";
import { doc, getDoc, setDoc } from "firebase/firestore";
import { db } from "@/lib/firebase";
import { SiteSettings } from "@/lib/types";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { useToast } from "@/hooks/use-toast";

export default function SettingsPage() {
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const { toast } = useToast();
  
  const [data, setData] = useState<SiteSettings>({
    contact: {
      phone: "",
      email: "",
      whatsapp: "",
      address: "",
      hours: "",
    },
    social: {
      facebook: "",
      instagram: "",
      twitter: "",
    },
    mapEmbedUrl: "",
    locationCode: "",
  });

  useEffect(() => {
    loadData();
  }, []);

  const loadData = async () => {
    try {
      const docRef = doc(db, "siteSettings", "global");
      const docSnap = await getDoc(docRef);
      
      if (docSnap.exists()) {
        setData(docSnap.data() as SiteSettings);
      }
    } catch (error) {
      console.error("Error loading settings:", error);
      toast({
        title: "Error",
        description: "Failed to load settings",
        variant: "destructive",
      });
    } finally {
      setLoading(false);
    }
  };

  const handleSave = async () => {
    setSaving(true);
    try {
      const docRef = doc(db, "siteSettings", "global");
      await setDoc(docRef, data);
      
      toast({
        title: "Success",
        description: "Settings saved successfully",
      });
    } catch (error) {
      console.error("Error saving settings:", error);
      toast({
        title: "Error",
        description: "Failed to save settings",
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
        <h1 className="text-3xl font-bold">Site Settings</h1>
        <Button onClick={handleSave} disabled={saving}>
          {saving ? "Saving..." : "Save Changes"}
        </Button>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Contact Information</CardTitle>
          <CardDescription>Information displayed in the contact section</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid md:grid-cols-2 gap-4">
            <div>
              <Label htmlFor="phone">Phone</Label>
              <Input
                id="phone"
                value={data.contact.phone}
                onChange={(e) => setData({ ...data, contact: { ...data.contact, phone: e.target.value } })}
                placeholder="+1 234 567 8900"
              />
            </div>
            <div>
              <Label htmlFor="email">Email</Label>
              <Input
                id="email"
                type="email"
                value={data.contact.email}
                onChange={(e) => setData({ ...data, contact: { ...data.contact, email: e.target.value } })}
                placeholder="info@sfpca.org"
              />
            </div>
          </div>
          <div>
            <Label htmlFor="whatsapp">WhatsApp</Label>
            <Input
              id="whatsapp"
              value={data.contact.whatsapp}
              onChange={(e) => setData({ ...data, contact: { ...data.contact, whatsapp: e.target.value } })}
              placeholder="+1 234 567 8900"
            />
          </div>
          <div>
            <Label htmlFor="address">Address</Label>
            <Textarea
              id="address"
              rows={2}
              value={data.contact.address}
              onChange={(e) => setData({ ...data, contact: { ...data.contact, address: e.target.value } })}
              placeholder="123 Main Street, Saba"
            />
          </div>
          <div>
            <Label htmlFor="hours">Hours</Label>
            <Textarea
              id="hours"
              rows={3}
              value={data.contact.hours}
              onChange={(e) => setData({ ...data, contact: { ...data.contact, hours: e.target.value } })}
              placeholder="Monday - Friday: 9:00 AM - 5:00 PM&#10;Saturday: 10:00 AM - 2:00 PM&#10;Sunday: Closed"
            />
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Location Settings</CardTitle>
          <CardDescription>Configure your location using Google Plus Code or embed URL</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div>
            <Label htmlFor="locationCode">Google Plus Code</Label>
            <Input
              id="locationCode"
              value={data.locationCode || ""}
              onChange={(e) => {
                const code = e.target.value;
                if (code) {
                  // Create a proper Google Maps embed URL for Plus Code
                  const embedUrl = `https://www.google.com/maps/embed?pb=!1m18!1m12!1m3!1d3651.877!2d-63.244!3d17.628!2m3!1f0!2f0!3f0!3m2!1i1024!2i768!4f13.1!3m3!1m2!1s${encodeURIComponent(code)}!2sSaba!5e0!3m2!1sen!2sus!4v1`;
                  setData({ ...data, locationCode: code, mapEmbedUrl: embedUrl });
                } else {
                  setData({ ...data, locationCode: code, mapEmbedUrl: "" });
                }
              }}
              placeholder="e.g., 7QG8+3M Saba"
            />
            <p className="text-sm text-muted-foreground mt-1">
              Enter a Google Plus Code (e.g., "7QG8+3M Saba") to auto-generate the map embed URL
            </p>
          </div>
          <div>
            <Label htmlFor="mapEmbedUrl">Map Embed URL (Optional)</Label>
            <Textarea
              id="mapEmbedUrl"
              rows={3}
              value={data.mapEmbedUrl || ""}
              onChange={(e) => setData({ ...data, mapEmbedUrl: e.target.value })}
              placeholder="https://www.google.com/maps/embed?..."
            />
            <p className="text-sm text-muted-foreground mt-1">
              Or paste a custom Google Maps embed URL. Leave empty to use the Plus Code.
            </p>
          </div>
          {data.mapEmbedUrl && (
            <div className="mt-4">
              <Label>Map Preview</Label>
              <div className="mt-2 rounded-lg overflow-hidden border">
                <iframe
                  src={data.mapEmbedUrl}
                  width="100%"
                  height="300"
                  style={{ border: 0 }}
                  allowFullScreen
                  loading="lazy"
                  referrerPolicy="no-referrer-when-downgrade"
                />
              </div>
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Social Media</CardTitle>
          <CardDescription>Links to your social media profiles</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div>
            <Label htmlFor="facebook">Facebook URL</Label>
            <Input
              id="facebook"
              value={data.social.facebook || ""}
              onChange={(e) => setData({ ...data, social: { ...data.social, facebook: e.target.value } })}
              placeholder="https://facebook.com/sfpca"
            />
          </div>
          <div>
            <Label htmlFor="instagram">Instagram URL</Label>
            <Input
              id="instagram"
              value={data.social.instagram || ""}
              onChange={(e) => setData({ ...data, social: { ...data.social, instagram: e.target.value } })}
              placeholder="https://instagram.com/sfpca"
            />
          </div>
          <div>
            <Label htmlFor="twitter">Twitter URL</Label>
            <Input
              id="twitter"
              value={data.social.twitter || ""}
              onChange={(e) => setData({ ...data, social: { ...data.social, twitter: e.target.value } })}
              placeholder="https://twitter.com/sfpca"
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
