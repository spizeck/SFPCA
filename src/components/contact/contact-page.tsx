"use client";

import { motion } from "framer-motion";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Phone, Mail, MessageCircle, MapPin, Clock, Facebook, Instagram, Twitter } from "lucide-react";
import { fadeInUpVariants, defaultTransition, shouldReduceMotion } from "@/lib/animations";

interface ContactPageProps {
  contact?: {
    phone: string;
    email: string;
    whatsapp: string;
    address: string;
    hours: string;
  };
  social?: {
    facebook?: string;
    instagram?: string;
    twitter?: string;
  };
  mapEmbedUrl?: string;
}

export function ContactPageContent({ contact, social, mapEmbedUrl }: ContactPageProps) {
  const animationProps = shouldReduceMotion() ? {
    initial: {},
    whileInView: undefined,
    viewport: undefined,
    transition: {},
  } : {
    initial: "initial",
    whileInView: "whileInView",
    viewport: { once: true, margin: "-100px" },
    transition: defaultTransition,
  };

  const contactCards = [
    {
      icon: <Phone className="h-6 w-6 text-primary" />,
      title: "Phone",
      content: contact ? (
        <a href={`tel:${contact.phone}`} className="text-foreground hover:text-primary">
          {contact.phone}
        </a>
      ) : null,
    },
    {
      icon: <Mail className="h-6 w-6 text-primary" />,
      title: "Email",
      content: contact ? (
        <a href={`mailto:${contact.email}`} className="text-foreground hover:text-primary break-all">
          {contact.email}
        </a>
      ) : null,
    },
    {
      icon: <MessageCircle className="h-6 w-6 text-primary" />,
      title: "WhatsApp",
      content: contact ? (
        <a
          href={`https://wa.me/${contact.whatsapp.replace(/\D/g, "")}`}
          target="_blank"
          rel="noopener noreferrer"
          className="text-foreground hover:text-primary"
        >
          {contact.whatsapp}
        </a>
      ) : null,
    },
    {
      icon: <MapPin className="h-6 w-6 text-primary" />,
      title: "Address",
      content: contact ? <p className="text-foreground">{contact.address}</p> : null,
    },
    {
      icon: <Clock className="h-6 w-6 text-primary" />,
      title: "Hours",
      content: contact ? <p className="text-foreground whitespace-pre-line">{contact.hours}</p> : null,
      wide: true,
    },
  ].filter(card => card.content !== null);

  return (
    <div className="min-h-screen bg-background">
      {/* Hero Section */}
      <section className="py-20 bg-primary text-primary-foreground">
        <div className="container mx-auto px-4">
          <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.6 }}
            className="text-center max-w-4xl mx-auto"
          >
            <h1 className="text-4xl md:text-6xl font-bold mb-6">
              Contact Us
            </h1>
            <p className="text-xl md:text-2xl mb-8">
              Get in touch with SABA. We're here to help you and the animals of Saba.
            </p>
          </motion.div>
        </div>
      </section>

      {/* Contact Information */}
      <section className="py-20">
        <div className="container mx-auto px-4">
          <motion.div
            initial={{ opacity: 0, y: 20 }}
            whileInView={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.6 }}
            viewport={{ once: true }}
            className="text-center mb-16"
          >
            <h2 className="text-3xl md:text-4xl font-bold text-foreground mb-4">
              Get in Touch
            </h2>
            <p className="text-xl text-muted-foreground max-w-2xl mx-auto">
              Reach out to us through any of these methods. We're always happy to help!
            </p>
          </motion.div>

          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-8 max-w-6xl mx-auto">
            {contactCards.map((card, index) => (
              <motion.div
                key={card.title}
                initial={{ opacity: 0, y: 20 }}
                whileInView={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.5, delay: index * 0.1 }}
                viewport={{ once: true }}
                className={card.wide ? "md:col-span-2" : ""}
              >
                <Card className="h-full hover:shadow-lg transition-shadow">
                  <CardHeader>
                    <div className="flex items-center gap-3">
                      {card.icon}
                      <CardTitle className="text-xl">{card.title}</CardTitle>
                    </div>
                  </CardHeader>
                  <CardContent>
                    {card.content}
                  </CardContent>
                </Card>
              </motion.div>
            ))}
          </div>
        </div>
      </section>

      {/* Map Section */}
      {mapEmbedUrl && (
        <section className="py-20 bg-muted">
          <div className="container mx-auto px-4">
            <motion.div
              initial={{ opacity: 0, y: 20 }}
              whileInView={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.6 }}
              viewport={{ once: true }}
              className="text-center mb-16"
            >
              <h2 className="text-3xl md:text-4xl font-bold text-foreground mb-4">
                Find Us
              </h2>
              <p className="text-xl text-muted-foreground max-w-2xl mx-auto">
                Visit our location on the beautiful island of Saba
              </p>
            </motion.div>

            <motion.div
              initial={{ opacity: 0, y: 20 }}
              whileInView={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.6 }}
              viewport={{ once: true }}
              className="max-w-4xl mx-auto"
            >
              <div className="rounded-lg overflow-hidden shadow-lg">
                <iframe
                  src={mapEmbedUrl}
                  width="100%"
                  height="400"
                  style={{ border: 0 }}
                  allowFullScreen
                  loading="lazy"
                  referrerPolicy="no-referrer-when-downgrade"
                  className="w-full"
                />
              </div>
            </motion.div>
          </div>
        </section>
      )}

      {/* Social Media */}
      {social && (social.facebook || social.instagram || social.twitter) && (
        <section className="py-20">
          <div className="container mx-auto px-4">
            <motion.div
              initial={{ opacity: 0, y: 20 }}
              whileInView={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.6 }}
              viewport={{ once: true }}
              className="text-center"
            >
              <h2 className="text-3xl md:text-4xl font-bold text-foreground mb-8">
                Follow Us
              </h2>
              <div className="flex justify-center gap-6">
                {social.facebook && (
                  <a
                    href={social.facebook}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="bg-primary text-primary-foreground hover:bg-primary/90 rounded-full p-4 transition-colors"
                    aria-label="Facebook"
                  >
                    <Facebook className="h-6 w-6" />
                  </a>
                )}
                {social.instagram && (
                  <a
                    href={social.instagram}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="bg-primary text-primary-foreground hover:bg-primary/90 rounded-full p-4 transition-colors"
                    aria-label="Instagram"
                  >
                    <Instagram className="h-6 w-6" />
                  </a>
                )}
                {social.twitter && (
                  <a
                    href={social.twitter}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="bg-primary text-primary-foreground hover:bg-primary/90 rounded-full p-4 transition-colors"
                    aria-label="Twitter"
                  >
                    <Twitter className="h-6 w-6" />
                  </a>
                )}
              </div>
            </motion.div>
          </div>
        </section>
      )}
    </div>
  );
}
