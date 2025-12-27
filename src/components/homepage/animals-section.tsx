"use client"

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Animal } from "@/lib/types";
import Image from "next/image";
import { motion } from "framer-motion";
import { fadeInUpVariants, fadeInVariants, staggerContainer, defaultTransition, shouldReduceMotion } from "@/lib/animations";

interface AnimalsSectionProps {
  animals: Animal[];
}

export function AnimalsSection({ animals }: AnimalsSectionProps) {
  if (animals.length === 0) {
    return null;
  }

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
      id="animals" 
      className="py-16 md:py-24 bg-background"
      variants={fadeInUpVariants}
      {...animationProps}
    >
      <div className="container mx-auto px-4">
        <motion.h2 
          className="text-3xl md:text-4xl font-bold text-center text-foreground mb-4"
          variants={fadeInUpVariants}
          {...animationProps}
        >
          Adoptable Animals
        </motion.h2>
        <motion.p 
          className="text-center text-muted-foreground mb-12 max-w-2xl mx-auto"
          variants={fadeInUpVariants}
          {...animationProps}
          transition={{ ...defaultTransition, delay: 0.2 }}
        >
          Meet our wonderful animals looking for their forever homes
        </motion.p>
        <motion.div 
          className="grid sm:grid-cols-2 lg:grid-cols-3 gap-6 max-w-6xl mx-auto"
          variants={staggerContainer}
          {...animationProps}
        >
          {animals.map((animal, index) => (
            <motion.div
              key={animal.id}
              variants={fadeInUpVariants}
              transition={{
                ...defaultTransition,
                delay: index * 0.1,
              }}
            >
              <Card className="overflow-hidden">
                {animal.photos && animal.photos.length > 0 && (
                  <motion.div 
                    className="relative h-48 w-full bg-muted"
                    variants={fadeInVariants}
                    transition={{
                      ...defaultTransition,
                      delay: index * 0.1 + 0.2,
                    }}
                  >
                    <Image
                      src={animal.photos[0]}
                      alt={animal.name}
                      fill
                      className="object-cover"
                    />
                  </motion.div>
                )}
                <CardHeader>
                  <CardTitle>{animal.name}</CardTitle>
                  <CardDescription>
                    {animal.species.charAt(0).toUpperCase() + animal.species.slice(1)} • {animal.sex.charAt(0).toUpperCase() + animal.sex.slice(1)} • {animal.approxAge}
                  </CardDescription>
                </CardHeader>
                <CardContent>
                  <p className="text-sm text-muted-foreground">{animal.description}</p>
                </CardContent>
              </Card>
            </motion.div>
          ))}
        </motion.div>
      </div>
    </motion.section>
  );
}
