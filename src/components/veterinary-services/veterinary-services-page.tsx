"use client";

import { motion } from "framer-motion";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import Link from "next/link";

const services = [
  {
    title: "Spay & Neuter Services",
    description: "Low-cost spay and neuter services for cats and dogs in the community.",
    price: "Starting at $50",
    icon: "🏥",
  },
  {
    title: "Vaccinations",
    description: "Essential vaccinations to keep your pets healthy and protected.",
    price: "Starting at $25",
    icon: "💉",
  },
  {
    title: "Microchipping",
    description: "Permanent identification for your pet to help ensure they can be returned if lost.",
    price: "$30",
    icon: "📍",
  },
  {
    title: "Wellness Exams",
    description: "Comprehensive health check-ups to maintain your pet's wellbeing.",
    price: "$45",
    icon: "🩺",
  },
  {
    title: "Dental Cleaning",
    description: "Professional dental services to keep your pet's teeth clean and healthy.",
    price: "Starting at $100",
    icon: "🦷",
  },
  {
    title: "Emergency Care",
    description: "24/7 emergency services for urgent medical needs.",
    price: "Varies",
    icon: "🚨",
  },
];

export function VeterinaryServices() {
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
              Veterinary Services
            </h1>
            <p className="text-xl md:text-2xl mb-8">
              Professional and affordable veterinary care for your beloved pets
            </p>
            <Button size="lg" variant="secondary" asChild>
              <Link href="#services">View Our Services</Link>
            </Button>
          </motion.div>
        </div>
      </section>

      {/* Services Grid */}
      <section id="services" className="py-20">
        <div className="container mx-auto px-4">
          <div className="text-center mb-16">
            <h2 className="text-3xl md:text-4xl font-bold text-foreground mb-4">
              Our Services
            </h2>
            <p className="text-xl text-muted-foreground max-w-2xl mx-auto">
              We offer a comprehensive range of veterinary services to keep your pets healthy and happy
            </p>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-8">
            {services.map((service, index) => (
              <motion.div
                key={index}
                initial={{ opacity: 0, y: 20 }}
                whileInView={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.5, delay: index * 0.1 }}
                viewport={{ once: true }}
              >
                <Card className="h-full hover:shadow-lg transition-shadow">
                  <CardHeader>
                    <div className="text-4xl mb-4">{service.icon}</div>
                    <CardTitle className="text-xl">{service.title}</CardTitle>
                  </CardHeader>
                  <CardContent>
                    <p className="text-muted-foreground mb-4">
                      {service.description}
                    </p>
                    <div className="text-lg font-semibold text-primary">
                      {service.price}
                    </div>
                  </CardContent>
                </Card>
              </motion.div>
            ))}
          </div>
        </div>
      </section>

      {/* CTA Section */}
      <section className="py-20 bg-secondary">
        <div className="container mx-auto px-4 text-center">
          <h2 className="text-3xl md:text-4xl font-bold text-foreground mb-4">
            Ready to Book an Appointment?
          </h2>
          <p className="text-xl text-muted-foreground mb-8 max-w-2xl mx-auto">
            Contact us today to schedule a visit for your pet. Our caring team is ready to help!
          </p>
          <div className="flex flex-col sm:flex-row gap-4 justify-center">
            <Button size="lg" asChild>
              <Link href="tel:555-123-4567">Call Us</Link>
            </Button>
            <Button size="lg" variant="outline" asChild>
              <Link href="/contact">Send Message</Link>
            </Button>
          </div>
        </div>
      </section>
    </div>
  );
}
