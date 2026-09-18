import type { Metadata } from "next";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Construction, Mail, Phone } from "lucide-react";
import { SHARE_OG_IMAGES } from "@/lib/seo";

export const metadata: Metadata = {
  title: "Under Construction",
  description: "Our website is currently under development. Contact SFPCA for more information.",
  openGraph: {
    title: "Under Construction | SFPCA",
    description: "Our website is currently under development. Contact SFPCA for more information.",
    images: SHARE_OG_IMAGES,
  },
  // Temporary landing page while the public site is gated — never indexed.
  robots: { index: false, follow: false },
};

export default function UnderConstructionPage() {
  return (
    <main id="main-content" tabIndex={-1} className="min-h-screen bg-background flex items-center justify-center px-4">
      <Card className="max-w-2xl w-full text-center">
        <CardHeader className="pb-6">
          <div className="flex justify-center mb-4">
            <div className="p-4 bg-yellow-100 rounded-full" aria-hidden="true">
              <Construction className="h-12 w-12 text-yellow-600" />
            </div>
          </div>
          <h1 className="text-3xl md:text-4xl font-semibold tracking-tight">Under Construction</h1>
        </CardHeader>
        <CardContent className="space-y-6">
          <p className="text-lg text-muted-foreground">
            Our website is currently being developed and will be available soon.
          </p>

          <div className="bg-muted p-6 rounded-lg">
            <h2 className="font-semibold mb-4">In the meantime, you can reach us directly:</h2>
            <div className="grid md:grid-cols-2 gap-4 text-left">
              <div className="flex items-center gap-3">
                <Phone className="h-5 w-5 text-primary" aria-hidden="true" />
                <div>
                  <p className="font-medium">Call us</p>
                  <p className="text-sm text-foreground/80">+599 416 7947</p>
                </div>
              </div>
              <div className="flex items-center gap-3">
                <Mail className="h-5 w-5 text-primary" aria-hidden="true" />
                <div>
                  <p className="font-medium">Email us</p>
                  <p className="text-sm text-foreground/80">sfpcasaba@gmail.com</p>
                </div>
              </div>
            </div>
          </div>

          <div className="flex flex-col sm:flex-row gap-4 justify-center">
            <Button asChild variant="default">
              <a href="tel:+5994167947">Call Us</a>
            </Button>
            <Button asChild variant="outline">
              <a href="mailto:sfpcasaba@gmail.com">Email Us</a>
            </Button>
          </div>
        </CardContent>
      </Card>
    </main>
  );
}
