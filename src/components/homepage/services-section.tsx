"use client"

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Stethoscope, Heart, ClipboardList, ArrowRight } from "lucide-react";
import { motion } from "framer-motion";
import { fadeInUpVariants, staggerContainer, defaultTransition, shouldReduceMotion } from "@/lib/animations";
import Link from "next/link";

interface ServicesSectionProps {
  data: {
    title: string;
    items: Array<{
      title: string;
      description: string;
    }>;
  };
}

const iconMap: Record<number, React.ReactNode> = {
  0: <Stethoscope className="h-10 w-10 text-primary" />,
  1: <Heart className="h-10 w-10 text-primary" />,
  2: <ClipboardList className="h-10 w-10 text-primary" />,
};

export function ServicesSection({ data }: ServicesSectionProps) {
  // Add fallback data to prevent empty cards
  const fallbackData = {
    title: "Our Services",
    items: [
      { title: "Veterinary Services", description: "Professional vet care, spay/neuter, vaccinations" },
      { title: "Animal Adoptions", description: "Find your perfect companion from our shelter" },
      { title: "Animal Registration", description: "Annual registration for all pets in the community" },
    ],
  };

  const servicesData = data.title && data.items.length > 0 ? data : fallbackData;
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

  return (
    <motion.section 
      id="services" 
      className="py-16 md:py-24 bg-muted"
      variants={fadeInUpVariants}
      {...animationProps}
    >
      <div className="container mx-auto px-4">
        <motion.h2 
          className="text-3xl md:text-4xl font-bold text-center text-foreground mb-12"
          variants={fadeInUpVariants}
          {...animationProps}
        >
          {servicesData.title}
        </motion.h2>
        <motion.div 
          className="grid md:grid-cols-3 gap-8 max-w-5xl mx-auto"
          variants={staggerContainer}
          {...animationProps}
        >
          {servicesData.items.map((service, index) => (
            <motion.div
              key={index}
              variants={fadeInUpVariants}
              transition={{
                ...defaultTransition,
                delay: index * 0.1,
              }}
            >
              <Card className="text-center h-full hover:shadow-lg transition-shadow">
                <CardHeader>
                  <div className="flex justify-center mb-4">
                    {iconMap[index] || <Heart className="h-10 w-10 text-primary" />}
                  </div>
                  <CardTitle>{service.title}</CardTitle>
                </CardHeader>
                <CardContent className="space-y-4">
                  <CardDescription className="text-base">
                    {service.description}
                  </CardDescription>
                  <Button variant="outline" className="w-full" asChild>
                    <Link href={
                      service.title === "Veterinary Services" ? "/vet-services" :
                      service.title === "Animal Adoptions" ? "/animal-adoptions" :
                      "/animal-registration"
                    }>
                      Learn More
                      <ArrowRight className="ml-2 h-4 w-4" />
                    </Link>
                  </Button>
                </CardContent>
              </Card>
            </motion.div>
          ))}
        </motion.div>
      </div>
    </motion.section>
  );
}
