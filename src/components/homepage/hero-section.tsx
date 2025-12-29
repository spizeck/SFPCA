"use client"

import { Button } from "@/components/ui/button";
import Link from "next/link";
import { motion, Transition } from "framer-motion";
import { fadeInUpVariants, scaleInVariants, shouldReduceMotion } from "@/lib/animations";

interface HeroSectionProps {
  data: {
    title: string;
    subtitle: string;
  };
}

export function HeroSection({ data }: HeroSectionProps) {
  const animationProps = shouldReduceMotion() ? {
    initial: {},
    animate: {},
    transition: {},
  } : {
    initial: { opacity: 0 },
    animate: { opacity: 1 },
    transition: { duration: 1, ease: "easeInOut" } as Transition,
  };

  return (
    <motion.section 
      className="relative h-screen overflow-hidden"
      {...animationProps}
    >
      {/* Background Video */}
      <video
        autoPlay
        loop
        muted
        playsInline
        className="absolute top-0 left-0 w-full h-full object-cover"
      >
        <source src="videos/herocat.mp4" type="video/mp4" />
      </video>
      
      {/* Dark overlay for text readability */}
      <div className="absolute inset-0 bg-black/50" />
      
      {/* Hero Content - now with relative positioning to sit above video */}
      <div className="relative z-10 container mx-auto px-4 h-full flex items-center justify-center">
        <div className="max-w-3xl mx-auto text-center">
          <motion.h1 
            className="text-4xl md:text-6xl font-bold text-white mb-6 drop-shadow-lg"
            initial={{ opacity: 0, y: 30 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.6, ease: "easeInOut", delay: 0.2 } as Transition}
          >
            {data.title}
          </motion.h1>
          <motion.p 
            className="text-xl md:text-2xl text-white/90 mb-8 drop-shadow-md"
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.6, ease: "easeInOut", delay: 0.5 } as Transition}
          >
            {data.subtitle}
          </motion.p>
          <motion.div 
            className="flex flex-col sm:flex-row gap-4 justify-center"
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.6, ease: "easeInOut", delay: 0.8 } as Transition}
          >
            <Button size="lg" asChild className="shadow-xl">
              <Link href="#services">Our Services</Link>
            </Button>
            <Button size="lg" variant="outline" asChild className="bg-white/10 backdrop-blur-sm text-white border-white/30 hover:bg-white/20 shadow-xl">
              <Link href="/animal-registration">Register Your Pet</Link>
            </Button>
          </motion.div>
        </div>
      </div>
    </motion.section>
  );
}
