import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Phone, Mail, MessageCircle, MapPin, Clock } from "lucide-react";

interface ContactSectionProps {
  contact: {
    phone: string;
    email: string;
    whatsapp: string;
    address: string;
    hours: string;
  };
}

export function ContactSection({ contact }: ContactSectionProps) {
  return (
    <section id="contact" className="py-16 md:py-24 bg-background">
      <div className="container mx-auto px-4">
        <h2 className="text-3xl md:text-4xl font-bold text-center text-foreground mb-12">
          Contact Us
        </h2>
        <div className="grid md:grid-cols-2 lg:grid-cols-3 gap-6 max-w-5xl mx-auto">
          <Card>
            <CardHeader>
              <div className="flex items-center gap-3">
                <Phone className="h-6 w-6 text-primary" />
                <CardTitle className="text-lg">Phone</CardTitle>
              </div>
            </CardHeader>
            <CardContent>
              <a href={`tel:${contact.phone}`} className="text-foreground hover:text-primary">
                {contact.phone}
              </a>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <div className="flex items-center gap-3">
                <Mail className="h-6 w-6 text-primary" />
                <CardTitle className="text-lg">Email</CardTitle>
              </div>
            </CardHeader>
            <CardContent>
              <a href={`mailto:${contact.email}`} className="text-foreground hover:text-primary break-all">
                {contact.email}
              </a>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <div className="flex items-center gap-3">
                <MessageCircle className="h-6 w-6 text-primary" />
                <CardTitle className="text-lg">WhatsApp</CardTitle>
              </div>
            </CardHeader>
            <CardContent>
              <a
                href={`https://wa.me/${contact.whatsapp.replace(/\D/g, "")}`}
                target="_blank"
                rel="noopener noreferrer"
                className="text-foreground hover:text-primary"
              >
                {contact.whatsapp}
              </a>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <div className="flex items-center gap-3">
                <MapPin className="h-6 w-6 text-primary" />
                <CardTitle className="text-lg">Address</CardTitle>
              </div>
            </CardHeader>
            <CardContent>
              <p className="text-foreground">{contact.address}</p>
            </CardContent>
          </Card>

          <Card className="md:col-span-2 lg:col-span-2">
            <CardHeader>
              <div className="flex items-center gap-3">
                <Clock className="h-6 w-6 text-primary" />
                <CardTitle className="text-lg">Hours</CardTitle>
              </div>
            </CardHeader>
            <CardContent>
              <p className="text-foreground whitespace-pre-line">{contact.hours}</p>
            </CardContent>
          </Card>
        </div>
      </div>
    </section>
  );
}
