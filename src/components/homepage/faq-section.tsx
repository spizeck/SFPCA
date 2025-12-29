"use client";

import { useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { ChevronDown, ChevronUp } from "lucide-react";
import { fadeInUpVariants, shouldReduceMotion } from "@/lib/animations";

const faqData = [
  {
    q: "How much does animal registration cost?",
    a: "Registration fees are $10 for spayed/neutered animals and $100 for unaltered animals. This is an annual fee that must be renewed each year."
  },
  {
    q: "How do I surrender my pet to SABA?",
    a: "Please call our office first to discuss the situation. We may be able to help you keep your pet or find alternatives to surrender. If surrender is necessary, we'll schedule an appointment."
  },
  {
    q: "How do I adopt an animal from SABA?",
    a: "Start by viewing our available animals online or visiting our shelter. Once you find a pet you're interested in, fill out an adoption application."
  },
  {
    q: "What do I do if I find a stray animal?",
    a: "Call our animal control dispatch at 555-123-4567. Do not approach the animal if it appears aggressive or injured."
  },
  {
    q: "What are your hours of operation?",
    a: "Shelter: Monday-Friday 9 AM-6 PM, Saturday 10 AM-4 PM, Closed Sundays. Animal Control: Available 24/7 for emergencies."
  }
];

export function FaqSection() {
  const [openItems, setOpenItems] = useState<{ [key: string]: boolean }>({});

  const toggleItem = (key: string) => {
    setOpenItems(prev => ({ ...prev, [key]: !prev[key] }));
  };

  return (
    <section className="py-20 bg-background">
      <div className="container mx-auto px-4">
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          whileInView={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.6 }}
          viewport={{ once: true }}
          className="text-center mb-16"
        >
          <h2 className="text-3xl md:text-4xl font-bold text-foreground mb-4">
            Frequently Asked Questions
          </h2>
          <p className="text-xl text-muted-foreground max-w-2xl mx-auto">
            Find answers to common questions about our services
          </p>
        </motion.div>

        <div className="max-w-3xl mx-auto space-y-4">
          {faqData.map((item, index) => {
            const key = `faq-${index}`;
            const isOpen = openItems[key];
            
            return (
              <motion.div
                key={key}
                initial={{ opacity: 0, y: 10 }}
                whileInView={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.3, delay: index * 0.05 }}
                viewport={{ once: true }}
              >
                <Card>
                  <CardHeader
                    className="cursor-pointer select-none"
                    onClick={() => toggleItem(key)}
                  >
                    <div className="flex items-center justify-between">
                      <CardTitle className="text-lg text-left">
                        {item.q}
                      </CardTitle>
                      <Button variant="ghost" size="sm">
                        {isOpen ? <ChevronUp /> : <ChevronDown />}
                      </Button>
                    </div>
                  </CardHeader>
                  <AnimatePresence>
                    {isOpen && (
                      <motion.div
                        initial={{ height: 0, opacity: 0 }}
                        animate={{ height: "auto", opacity: 1 }}
                        exit={{ height: 0, opacity: 0 }}
                        transition={{ duration: 0.3 }}
                      >
                        <CardContent className="pt-0">
                          <p className="text-muted-foreground">
                            {item.a}
                          </p>
                        </CardContent>
                      </motion.div>
                    )}
                  </AnimatePresence>
                </Card>
              </motion.div>
            );
          })}
        </div>

        <motion.div
          initial={{ opacity: 0, y: 20 }}
          whileInView={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.6, delay: 0.3 }}
          viewport={{ once: true }}
          className="text-center mt-12"
        >
          <p className="text-muted-foreground mb-4">
            Still have questions?
          </p>
          <a
            href="/faq"
            className="inline-flex items-center justify-center rounded-md text-sm font-medium ring-offset-background transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:pointer-events-none disabled:opacity-50 bg-primary text-primary-foreground hover:bg-primary/90 h-10 px-4 py-2"
          >
            View All FAQs
          </a>
        </motion.div>
      </div>
    </section>
  );
}
