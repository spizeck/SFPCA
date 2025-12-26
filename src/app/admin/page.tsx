import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import Link from "next/link";
import { FileText, PawPrint, Settings } from "lucide-react";

export default function AdminDashboard() {
  return (
    <div className="max-w-4xl mx-auto">
      <h1 className="text-3xl font-bold mb-8">Admin Dashboard</h1>
      
      <div className="grid md:grid-cols-3 gap-6">
        <Card>
          <CardHeader>
            <div className="flex items-center gap-3 mb-2">
              <FileText className="h-8 w-8 text-primary" />
              <CardTitle>Homepage</CardTitle>
            </div>
            <CardDescription>
              Edit homepage content, hero section, services, and donation information
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Button asChild className="w-full">
              <Link href="/admin/homepage">Edit Homepage</Link>
            </Button>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <div className="flex items-center gap-3 mb-2">
              <PawPrint className="h-8 w-8 text-primary" />
              <CardTitle>Animals</CardTitle>
            </div>
            <CardDescription>
              Manage adoptable animals, add photos, and update adoption status
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Button asChild className="w-full">
              <Link href="/admin/animals">Manage Animals</Link>
            </Button>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <div className="flex items-center gap-3 mb-2">
              <Settings className="h-8 w-8 text-primary" />
              <CardTitle>Settings</CardTitle>
            </div>
            <CardDescription>
              Update contact information, social media links, and site settings
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Button asChild className="w-full">
              <Link href="/admin/settings">Edit Settings</Link>
            </Button>
          </CardContent>
        </Card>
      </div>

      <Card className="mt-8">
        <CardHeader>
          <CardTitle>Quick Tips</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2">
          <p className="text-sm text-gray-600">
            • Changes to the homepage and settings are reflected immediately on the public site
          </p>
          <p className="text-sm text-gray-600">
            • Only animals marked as "available" will appear on the public homepage
          </p>
          <p className="text-sm text-gray-600">
            • Use the "View Site" button in the navigation to preview your changes
          </p>
        </CardContent>
      </Card>
    </div>
  );
}
