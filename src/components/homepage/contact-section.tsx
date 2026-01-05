"use client"

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Phone, Mail, MessageCircle, MapPin, Clock } from "lucide-react";
import { motion } from "framer-motion";
import { fadeInUpVariants, staggerContainer, defaultTransition, shouldReduceMotion } from "@/lib/animations";

interface ContactSectionProps {
  contact?: {
    phone: string;
    email: string;
    whatsapp: string;
    address: string;
    hours: string;
  };
  mapEmbedUrl?: string;
  whereWeAre?: {
    title: string;
    subtitle: string;
    address: string;
    mapEmbedUrl: string;
    hours: string;
  };
}

export function ContactSection({ contact, mapEmbedUrl, whereWeAre }: ContactSectionProps) {
  // Use whereWeAre data if provided, otherwise use contact/settings data
  const sectionTitle = whereWeAre?.title || "Contact Us";
  const sectionSubtitle = whereWeAre?.subtitle || "";
  const sectionAddress = whereWeAre?.address || contact?.address || "";
  const sectionHours = whereWeAre?.hours || contact?.hours || "";
  const sectionMapEmbedUrl = whereWeAre?.mapEmbedUrl || mapEmbedUrl || "";
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
      content: <p className="text-foreground">{sectionAddress}</p>,
    },
    {
      icon: <Clock className="h-6 w-6 text-primary" />,
      title: "Hours",
      content: <p className="text-foreground whitespace-pre-line">{sectionHours}</p>,
      wide: true,
    },
  ].filter(card => card.content !== null);

  return (
    <motion.section 
      id="contact" 
      className="py-16 md:py-24 bg-muted"
      variants={fadeInUpVariants}
      {...animationProps}
    >
      <div className="container mx-auto px-4">
        <motion.h2 
          className="text-3xl md:text-4xl font-bold text-center text-foreground mb-4"
          variants={fadeInUpVariants}
          {...animationProps}
        >
          {sectionTitle}
        </motion.h2>
        {sectionSubtitle && (
          <motion.p 
            className="text-xl text-muted-foreground text-center mb-12"
            variants={fadeInUpVariants}
            {...animationProps}
          >
            {sectionSubtitle}
          </motion.p>
        )}
        
        {/* Google Map */}
        {sectionMapEmbedUrl ? (
          <motion.div 
            className="mb-12 rounded-lg overflow-hidden shadow-lg"
            variants={fadeInUpVariants}
            {...animationProps}
          >
            <iframe
              src={sectionMapEmbedUrl}
              width="100%"
              height="400"
              style={{ border: 0 }}
              allowFullScreen
              loading="lazy"
              referrerPolicy="no-referrer-when-downgrade"
              className="w-full"
            />
          </motion.div>
        ) : (
          <motion.div 
            className="mb-12 rounded-lg bg-muted border-2 border-dashed border-muted-foreground/20 flex items-center justify-center"
            style={{ height: "400px" }}
            variants={fadeInUpVariants}
            {...animationProps}
          >
            <div className="text-center">
              <MapPin className="h-12 w-12 text-muted-foreground mx-auto mb-4" />
              <p className="text-muted-foreground">Map will be displayed here</p>
              <p className="text-sm text-muted-foreground mt-2">Configure location in admin settings</p>
            </div>
          </motion.div>
        )}
        
        <motion.div 
          className="grid md:grid-cols-2 lg:grid-cols-3 gap-6 max-w-5xl mx-auto"
          variants={staggerContainer}
          {...animationProps}
        >
          {contactCards.map((card, index) => (
            <motion.div
              key={card.title}
              variants={fadeInUpVariants}
              transition={{
                ...defaultTransition,
                delay: index * 0.1,
              }}
              className={card.wide ? "md:col-span-2 lg:col-span-2" : ""}
            >
              <Card>
                <CardHeader>
                  <div className="flex items-center gap-3">
                    {card.icon}
                    <CardTitle className="text-lg">{card.title}</CardTitle>
                  </div>
                </CardHeader>
                <CardContent>
                  {card.content}
                </CardContent>
              </Card>
            </motion.div>
          ))}
        </motion.div>
      </div>
    </motion.section>
  );
}
