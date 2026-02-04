"use client";

import { useState, useEffect } from "react";
import { motion } from "framer-motion";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { OptimizedVideo } from "@/components/ui/optimized-video";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import Link from "next/link";
import { Animal } from "@/lib/types";
import { getAvailableAnimals } from "@/lib/animals";

export function AnimalAdoptions() {
  const [animals, setAnimals] = useState<Animal[]>([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState<string>("all");

  useEffect(() => {
    loadAnimals();
  }, []);

  const loadAnimals = async () => {
    try {
      const animalList = await getAvailableAnimals();
      setAnimals(animalList);
    } catch (error) {
      console.error("Error loading animals:", error);
    } finally {
      setLoading(false);
    }
  };

  const filteredAnimals = filter === "all" 
    ? animals 
    : animals.filter(animal => animal.species === filter);

  return (
    <div className="min-h-screen bg-background">
      {/* Hero Section with Full Page Video Background */}
      <section className="relative min-h-screen overflow-hidden flex items-center justify-center">
        {/* Video Background */}
        <div className="absolute inset-0 z-0">
          <OptimizedVideo
            src="/videos/adoption.mp4"
            className="w-full h-full object-cover -z-10"
          />
          {/* Dark overlay for text readability */}
          <div className="absolute inset-0 bg-black/50" />
        </div>
        
        {/* Content */}
        <div className="relative z-10 container mx-auto px-4">
          <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.6 }}
            className="text-center max-w-4xl mx-auto"
          >
            <h1 className="text-4xl md:text-6xl font-bold mb-6 text-white">
              Animal Adoptions
            </h1>
            <p className="text-xl md:text-2xl mb-8 text-white/90">
              Find your perfect companion. Give a loving animal their forever home.
            </p>
            <Button size="lg" variant="secondary" asChild>
              <Link href="#available">View Available Animals</Link>
            </Button>
          </motion.div>
        </div>
      </section>

      {/* Success Stories */}
      <section className="py-20 bg-muted">
        <div className="container mx-auto px-4">
          <div className="text-center mb-16">
            <h2 className="text-3xl md:text-4xl font-bold text-foreground mb-4">
              Success Stories
            </h2>
            <p className="text-xl text-muted-foreground max-w-2xl mx-auto">
              Heartwarming stories of animals who found their forever homes
            </p>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-3 gap-8">
            {[
              {
                name: "Bella",
                story: "Bella was found abandoned but now lives with a loving family who adores her.",
                image: "🐕",
              },
              {
                name: "Max",
                story: "Max spent 6 months in our shelter before finding his perfect match.",
                image: "🐈",
              },
              {
                name: "Luna",
                story: "Luna was rescued from the streets and is now living her best life.",
                image: "🐕",
              },
            ].map((story, index) => (
              <motion.div
                key={index}
                initial={{ opacity: 0, y: 20 }}
                whileInView={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.5, delay: index * 0.1 }}
                viewport={{ once: true }}
              >
                <Card className="h-full">
                  <CardHeader className="text-center">
                    <div className="text-6xl mb-4">{story.image}</div>
                    <CardTitle>{story.name}</CardTitle>
                  </CardHeader>
                  <CardContent>
                    <p className="text-muted-foreground text-center">
                      {story.story}
                    </p>
                  </CardContent>
                </Card>
              </motion.div>
            ))}
          </div>
        </div>
      </section>

      {/* Available Animals */}
      <section id="available" className="py-20">
        <div className="container mx-auto px-4">
          <div className="text-center mb-16">
            <h2 className="text-3xl md:text-4xl font-bold text-foreground mb-4">
              Available for Adoption
            </h2>
            <p className="text-xl text-muted-foreground max-w-2xl mx-auto">
              These loving animals are waiting for their forever homes
            </p>
          </div>

          {/* Filter Buttons */}
          <div className="flex justify-center gap-4 mb-12">
            <Button
              variant={filter === "all" ? "default" : "outline"}
              onClick={() => setFilter("all")}
            >
              All Animals
            </Button>
            <Button
              variant={filter === "dog" ? "default" : "outline"}
              onClick={() => setFilter("dog")}
            >
              Dogs
            </Button>
            <Button
              variant={filter === "cat" ? "default" : "outline"}
              onClick={() => setFilter("cat")}
            >
              Cats
            </Button>
          </div>

          {/* Animals Grid */}
          {loading ? (
            <div className="text-center">Loading...</div>
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-8">
              {filteredAnimals.map((animal, index) => (
                <motion.div
                  key={animal.id}
                  initial={{ opacity: 0, y: 20 }}
                  whileInView={{ opacity: 1, y: 0 }}
                  transition={{ duration: 0.5, delay: index * 0.1 }}
                  viewport={{ once: true }}
                >
                  <Card className="h-full hover:shadow-lg transition-shadow">
                    <CardHeader>
                      <div className="flex justify-between items-start">
                        <CardTitle className="text-xl">{animal.name}</CardTitle>
                        <Badge variant="secondary">
                          {animal.species}
                        </Badge>
                      </div>
                    </CardHeader>
                    <CardContent>
                      {animal.photos && animal.photos.length > 0 && (
                        <div className="aspect-square mb-4 rounded-lg overflow-hidden bg-muted">
                          <img
                            src={animal.photos[0]}
                            alt={animal.name}
                            className="w-full h-full object-cover"
                          />
                        </div>
                      )}
                      <div className="space-y-2 mb-4">
                        <p><strong>Age:</strong> {animal.approxAge}</p>
                        <p><strong>Sex:</strong> {animal.sex}</p>
                      </div>
                      <p className="text-muted-foreground mb-4">
                        {animal.description}
                      </p>
                      <Button className="w-full">
                        Learn More About {animal.name}
                      </Button>
                    </CardContent>
                  </Card>
                </motion.div>
              ))}
            </div>
          )}
        </div>
      </section>

      {/* Partner Organizations */}
      <section className="py-20 bg-secondary">
        <div className="container mx-auto px-4">
          <div className="text-center mb-16">
            <h2 className="text-3xl md:text-4xl font-bold text-foreground mb-4">
              Partner Organizations
            </h2>
            <p className="text-xl text-muted-foreground max-w-2xl mx-auto">
              We work with these amazing organizations to help more animals
            </p>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-8">
            {[
              { name: "Local Pet Rescue", logo: "🏥" },
              { name: "Animal Welfare Society", logo: "🐾" },
              { name: "Community Pet Network", logo: "🐕" },
              { name: "SABA Animal Control", logo: "🚐" },
            ].map((partner, index) => (
              <motion.div
                key={index}
                initial={{ opacity: 0, y: 20 }}
                whileInView={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.5, delay: index * 0.1 }}
                viewport={{ once: true }}
                className="text-center"
              >
                <Card className="p-8">
                  <div className="text-4xl mb-4">{partner.logo}</div>
                  <h3 className="font-semibold">{partner.name}</h3>
                </Card>
              </motion.div>
            ))}
          </div>
        </div>
      </section>

      {/* CTA Section */}
      <section className="py-20 bg-muted">
        <div className="container mx-auto px-4 text-center">
          <h2 className="text-3xl md:text-4xl font-bold text-foreground mb-4">
            Ready to Adopt?
          </h2>
          <p className="text-xl text-muted-foreground mb-8 max-w-2xl mx-auto">
            Take the first step in giving an animal a loving home. Contact us to start the adoption process.
          </p>
          <div className="flex flex-col sm:flex-row gap-4 justify-center">
            <Button size="lg" asChild>
              <Link href="/contact">Start Adoption Process</Link>
            </Button>
            <Button size="lg" variant="outline" asChild>
              <Link href="/animal-registration">Register Your Pet</Link>
            </Button>
          </div>
        </div>
      </section>
    </div>
  );
}
