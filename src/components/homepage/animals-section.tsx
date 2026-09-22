"use client"

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Animal } from "@/lib/types";
import Link from "next/link";
import { motion, useReducedMotion } from "framer-motion";
import { fadeInUpVariants, fadeInVariants, staggerContainer, defaultTransition, instantTransition, useInViewAnimationProps, useMotionTransition } from "@/lib/animations";

interface AnimalsSectionProps {
  animals: Animal[];
}

// Homepage preview of adoptable animals (#126). The caller passes only
// publicly listable (`available`) animals, already bounded to the
// preview count; each card links to the animal's real detail page and
// the section links through to the full adoption listing. When nothing
// is available the section simply doesn't render — an ordinary state,
// not an error.
export function AnimalsSection({ animals }: AnimalsSectionProps) {
  const animationProps = useInViewAnimationProps();
  const delayedTransition = useMotionTransition({ ...defaultTransition, delay: 0.2 });
  const reduceMotion = useReducedMotion();

  if (animals.length === 0) {
    return null;
  }

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
          transition={delayedTransition}
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
              transition={reduceMotion ? instantTransition : {
                ...defaultTransition,
                delay: index * 0.1,
              }}
              className="h-full"
            >
              <Link
                href={`/animal-adoptions/${animal.id}`}
                aria-label={`Learn more about ${animal.name}`}
                className="block h-full rounded-xl focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
              >
                <Card className="overflow-hidden h-full hover:shadow-lg transition-shadow">
                  {animal.photos && animal.photos.length > 0 && (
                    <motion.div 
                      className="h-48 w-full bg-muted"
                      variants={fadeInVariants}
                      transition={reduceMotion ? instantTransition : {
                        ...defaultTransition,
                        delay: index * 0.1 + 0.2,
                      }}
                    >
                      {/* Plain img: photo URLs are admin-entered and can
                          point at any host, so they can't go through
                          next/image's configured remotePatterns. */}
                      <img
                        src={animal.photos[0]}
                        alt={animal.name}
                        className="h-48 w-full object-cover"
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
              </Link>
            </motion.div>
          ))}
        </motion.div>
        <motion.div
          className="text-center mt-12"
          variants={fadeInUpVariants}
          {...animationProps}
          transition={delayedTransition}
        >
          <Button asChild variant="outline" size="lg">
            <Link href="/animal-adoptions">View All Adoptable Animals</Link>
          </Button>
        </motion.div>
      </div>
    </motion.section>
  );
}
