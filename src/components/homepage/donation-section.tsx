"use client"

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { motion } from "framer-motion";
import { fadeInUpVariants, scaleInVariants, defaultTransition, shouldReduceMotion } from "@/lib/animations";

interface DonationSectionProps {
  data: {
    title: string;
    content: string;
    paymentMethods: string;
  };
}

export function DonationSection({ data }: DonationSectionProps) {
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
      id="donation" 
      className="py-16 md:py-24 bg-background"
      variants={fadeInUpVariants}
      {...animationProps}
    >
      <div className="container mx-auto px-4">
        <motion.div 
          className="max-w-3xl mx-auto"
          variants={scaleInVariants}
          {...animationProps}
        >
          <Card>
            <CardHeader className="text-center">
              <motion.h2 
                className="text-3xl font-bold text-foreground"
                variants={fadeInUpVariants}
                {...animationProps}
              >
                {data.title}
              </motion.h2>
              <motion.p 
                className="text-base text-muted-foreground mt-4"
                variants={fadeInUpVariants}
                {...animationProps}
                transition={{ ...defaultTransition, delay: 0.2 }}
              >
                {data.content}
              </motion.p>
            </CardHeader>
            <CardContent>
              <motion.div 
                className="bg-secondary/50 p-6 rounded-lg"
                variants={fadeInUpVariants}
                {...animationProps}
                transition={{ ...defaultTransition, delay: 0.4 }}
              >
                <h3 className="font-semibold text-lg mb-3 text-foreground">Payment Methods</h3>
                <p className="text-muted-foreground whitespace-pre-line">{data.paymentMethods}</p>
              </motion.div>
            </CardContent>
          </Card>
        </motion.div>
      </div>
    </motion.section>
  );
}
