"use client"

import { motion } from "framer-motion";
import { fadeInUpVariants, defaultTransition, shouldReduceMotion } from "@/lib/animations";

interface AboutSectionProps {
  data: {
    title: string;
    content: string;
  };
}

export function AboutSection({ data }: AboutSectionProps) {
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
      id="about" 
      className="py-16 md:py-24 bg-background"
      variants={fadeInUpVariants}
      {...animationProps}
    >
      <div className="container mx-auto px-4">
        <div className="max-w-3xl mx-auto text-center">
          <motion.h2 
            className="text-3xl md:text-4xl font-bold text-foreground mb-6"
            variants={fadeInUpVariants}
            {...animationProps}
          >
            {data.title}
          </motion.h2>
          <motion.p 
            className="text-lg text-muted-foreground leading-relaxed whitespace-pre-line"
            variants={fadeInUpVariants}
            {...animationProps}
            transition={{ ...defaultTransition, delay: 0.2 }}
          >
            {data.content}
          </motion.p>
        </div>
      </div>
    </motion.section>
  );
}
