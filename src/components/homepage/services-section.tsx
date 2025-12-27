"use client"

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Stethoscope, Heart, ClipboardList } from "lucide-react";
import { motion } from "framer-motion";
import { fadeInUpVariants, staggerContainer, defaultTransition, shouldReduceMotion } from "@/lib/animations";

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
          {data.title}
        </motion.h2>
        <motion.div 
          className="grid md:grid-cols-3 gap-8 max-w-5xl mx-auto"
          variants={staggerContainer}
          {...animationProps}
        >
          {data.items.map((service, index) => (
            <motion.div
              key={index}
              variants={fadeInUpVariants}
              transition={{
                ...defaultTransition,
                delay: index * 0.1,
              }}
            >
              <Card className="text-center">
                <CardHeader>
                  <div className="flex justify-center mb-4">
                    {iconMap[index] || <Heart className="h-10 w-10 text-primary" />}
                  </div>
                  <CardTitle>{service.title}</CardTitle>
                </CardHeader>
                <CardContent>
                  <CardDescription className="text-base">
                    {service.description}
                  </CardDescription>
                </CardContent>
              </Card>
            </motion.div>
          ))}
        </motion.div>
      </div>
    </motion.section>
  );
}
