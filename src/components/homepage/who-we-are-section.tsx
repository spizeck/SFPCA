"use client";

import { useState, useEffect } from "react";
import { motion, Transition, AnimatePresence } from "framer-motion";
import { fadeInUpVariants, shouldReduceMotion } from "@/lib/animations";
import { Card, CardContent } from "@/components/ui/card";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { Button } from "@/components/ui/button";

interface TeamMember {
  name: string;
  role: string;
  bio: string;
  photo?: string;
}

interface WhoWeAreSectionProps {
  data?: {
    title: string;
    subtitle: string;
    team: TeamMember[];
  };
}

export function WhoWeAreSection({ data }: WhoWeAreSectionProps) {
  const [currentIndex, setCurrentIndex] = useState(0);
  
  // Add fallback data with made up team members
  const fallbackData = {
    title: "Who We Are",
    subtitle: "Meet our dedicated team of professionals",
    team: [
      {
        name: "Dr. Sarah Johnson",
        role: "Lead Veterinarian",
        bio: "With over 15 years of experience in veterinary medicine, Dr. Johnson leads our medical team with compassion and expertise. She specializes in spay/neuter procedures and emergency care.",
        photo: "https://images.unsplash.com/photo-1559839734-49b0a14d7267?w=400&h=400&fit=crop&crop=face"
      },
      {
        name: "Michael Chen",
        role: "Animal Care Director",
        bio: "Michael has been with SFPCA for 10 years and oversees all animal care operations. His dedication to animal welfare has helped countless pets find loving homes.",
        photo: "https://images.unsplash.com/photo-1507003211169-0a1dd7228f2d?w=400&h=400&fit=crop&crop=face"
      },
      {
        name: "Emily Rodriguez",
        role: "Adoption Coordinator",
        bio: "Emily's passion for matching pets with perfect families has made our adoption program a huge success. She works tirelessly to ensure every animal finds their forever home.",
        photo: "https://images.unsplash.com/photo-1438761681033-6461ffad8d80?w=400&h=400&fit=crop&crop=face"
      },
      {
        name: "James Wilson",
        role: "Volunteer Manager",
        bio: "James coordinates our amazing team of volunteers who are the backbone of our shelter. He ensures every volunteer has a rewarding experience helping our animals.",
        photo: "https://images.unsplash.com/photo-1472099645785-5658abf4ff4e?w=400&h=400&fit=crop&crop=face"
      },
      {
        name: "Lisa Thompson",
        role: "Fundraising Director",
        bio: "Lisa's innovative fundraising initiatives keep our shelter running. She organizes events and campaigns that support our mission of animal welfare.",
        photo: "https://images.unsplash.com/photo-1494790108755-2616b612b620?w=400&h=400&fit=crop&crop=face"
      },
      {
        name: "Dr. Robert Martinez",
        role: "Veterinary Surgeon",
        bio: "Dr. Martinez brings surgical expertise to our team, performing life-saving procedures and specialized surgeries that give animals a second chance at life.",
        photo: "https://images.unsplash.com/photo-1582750433449-648ed127bb54?w=400&h=400&fit=crop&crop=face"
      }
    ]
  };

  const sectionData = data || fallbackData;
  const teamMembers = sectionData.team;
  
  // Show 3 cards at a time
  const itemsPerSlide = 3;
  const totalSlides = Math.ceil(teamMembers.length / itemsPerSlide);

  // Auto-rotate carousel
  useEffect(() => {
    const timer = setInterval(() => {
      setCurrentIndex((prev) => (prev + 1) % totalSlides);
    }, 5000); // Change every 5 seconds

    return () => clearInterval(timer);
  }, [totalSlides]);

  const goToSlide = (index: number) => {
    setCurrentIndex(index);
  };

  const goToPrevious = () => {
    setCurrentIndex((prev) => (prev - 1 + totalSlides) % totalSlides);
  };

  const goToNext = () => {
    setCurrentIndex((prev) => (prev + 1) % totalSlides);
  };

  const animationProps = shouldReduceMotion() ? {
    initial: {},
    animate: {},
    transition: {},
  } : {
    initial: { opacity: 0 },
    animate: { opacity: 1 },
    transition: { duration: 0.8, ease: "easeInOut" } as Transition,
  };

  return (
    <section className="py-20 bg-secondary" id="who-we-are">
      <motion.div 
        className="container mx-auto px-4"
        {...animationProps}
      >
        {/* Section Header */}
        <motion.div 
          className="text-center mb-16"
          variants={fadeInUpVariants}
          initial="hidden"
          whileInView="visible"
          viewport={{ once: true, amount: 0.1 }}
          transition={{ duration: 0.6 }}
        >
          <h2 className="text-3xl md:text-4xl font-bold text-foreground mb-4">
            {sectionData.title}
          </h2>
          <p className="text-xl text-muted-foreground max-w-2xl mx-auto">
            {sectionData.subtitle}
          </p>
        </motion.div>

        {/* Carousel */}
        <div className="relative">
          <div className="overflow-hidden">
            <AnimatePresence mode="wait">
              <motion.div
                key={currentIndex}
                initial={{ opacity: 0, x: 100 }}
                animate={{ opacity: 1, x: 0 }}
                exit={{ opacity: 0, x: -100 }}
                transition={{ duration: 0.5 }}
                className="grid md:grid-cols-3 gap-8"
              >
                {teamMembers
                  .slice(currentIndex * itemsPerSlide, (currentIndex + 1) * itemsPerSlide)
                  .map((member, index) => (
                    <motion.div
                      key={`${currentIndex}-${index}`}
                      initial={{ opacity: 0, y: 20 }}
                      animate={{ opacity: 1, y: 0 }}
                      transition={{ delay: index * 0.1 }}
                    >
                      <Card className="h-full bg-card shadow-lg hover:shadow-xl transition-shadow">
                        <CardContent className="p-6 text-center">
                          {/* Photo */}
                          <div className="mb-6">
                            <div className="w-32 h-32 mx-auto rounded-full overflow-hidden bg-muted">
                              {member.photo ? (
                                <img
                                  src={member.photo}
                                  alt={member.name}
                                  className="w-full h-full object-cover"
                                />
                              ) : (
                                <div className="w-full h-full flex items-center justify-center">
                                  <div className="w-16 h-16 bg-muted-foreground/20 rounded-full flex items-center justify-center">
                                    <span className="text-2xl text-muted-foreground">
                                      {member.name.split(' ').map(n => n[0]).join('')}
                                    </span>
                                  </div>
                                </div>
                              )}
                            </div>
                          </div>
                          
                          {/* Name and Role */}
                          <h3 className="text-xl font-semibold text-foreground mb-2">
                            {member.name}
                          </h3>
                          <p className="text-primary font-medium mb-4">
                            {member.role}
                          </p>
                          
                          {/* Bio */}
                          <p className="text-muted-foreground text-sm leading-relaxed">
                            {member.bio}
                          </p>
                        </CardContent>
                      </Card>
                    </motion.div>
                  ))}
              </motion.div>
            </AnimatePresence>
          </div>

          {/* Navigation Buttons */}
          <div className="flex justify-center items-center gap-4 mt-8">
            <Button
              variant="outline"
              size="icon"
              onClick={goToPrevious}
              className="bg-background hover:bg-accent"
            >
              <ChevronLeft className="h-4 w-4" />
            </Button>
            
            {/* Dots Indicator */}
            <div className="flex gap-2">
              {Array.from({ length: totalSlides }).map((_, index) => (
                <button
                  key={index}
                  onClick={() => goToSlide(index)}
                  className={`w-2 h-2 rounded-full transition-colors ${
                    index === currentIndex
                      ? "bg-primary"
                      : "bg-muted-foreground/30 hover:bg-muted-foreground/50"
                  }`}
                />
              ))}
            </div>

            <Button
              variant="outline"
              size="icon"
              onClick={goToNext}
              className="bg-background hover:bg-accent"
            >
              <ChevronRight className="h-4 w-4" />
            </Button>
          </div>
        </div>
      </motion.div>
    </section>
  );
}
