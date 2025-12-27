"use client"

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Phone, Mail, MessageCircle, MapPin, Clock } from "lucide-react";
import { motion } from "framer-motion";
import { fadeInUpVariants, staggerContainer, defaultTransition, shouldReduceMotion } from "@/lib/animations";

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
      content: (
        <a href={`tel:${contact.phone}`} className="text-foreground hover:text-primary">
          {contact.phone}
        </a>
      ),
    },
    {
      icon: <Mail className="h-6 w-6 text-primary" />,
      title: "Email",
      content: (
        <a href={`mailto:${contact.email}`} className="text-foreground hover:text-primary break-all">
          {contact.email}
        </a>
      ),
    },
    {
      icon: <MessageCircle className="h-6 w-6 text-primary" />,
      title: "WhatsApp",
      content: (
        <a
          href={`https://wa.me/${contact.whatsapp.replace(/\D/g, "")}`}
          target="_blank"
          rel="noopener noreferrer"
          className="text-foreground hover:text-primary"
        >
          {contact.whatsapp}
        </a>
      ),
    },
    {
      icon: <MapPin className="h-6 w-6 text-primary" />,
      title: "Address",
      content: <p className="text-foreground">{contact.address}</p>,
    },
    {
      icon: <Clock className="h-6 w-6 text-primary" />,
      title: "Hours",
      content: <p className="text-foreground whitespace-pre-line">{contact.hours}</p>,
      wide: true,
    },
  ];

  return (
    <motion.section 
      id="contact" 
      className="py-16 md:py-24 bg-background"
      variants={fadeInUpVariants}
      {...animationProps}
    >
      <div className="container mx-auto px-4">
        <motion.h2 
          className="text-3xl md:text-4xl font-bold text-center text-foreground mb-12"
          variants={fadeInUpVariants}
          {...animationProps}
        >
          Contact Us
        </motion.h2>
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
