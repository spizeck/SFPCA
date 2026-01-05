"use client";

import { useState, useEffect } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { ChevronDown, ChevronUp } from "lucide-react";
import { fadeInUpVariants, shouldReduceMotion } from "@/lib/animations";
import { doc, getDoc } from "firebase/firestore";
import { db } from "@/lib/firebase";

interface FAQ {
  question: string;
  answer: string;
}

interface FAQData {
  title: string;
  subtitle: string;
  faqs: FAQ[];
}

export function FaqSection() {
  const [openItems, setOpenItems] = useState<{ [key: string]: boolean }>({});
  const [data, setData] = useState<FAQData | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    loadData();
  }, []);

  const loadData = async () => {
    try {
      const docRef = doc(db, "faq", "main");
      const docSnap = await getDoc(docRef);
      
      if (docSnap.exists()) {
        setData(docSnap.data() as FAQData);
      } else {
        // Fallback data if no data exists
        setData({
          title: "Frequently Asked Questions",
          subtitle: "Find answers to common questions about our services",
          faqs: [
            {
              question: "How much does animal registration cost?",
              answer: "Registration fees are $10 for spayed/neutered animals and $100 for unaltered animals. This is an annual fee that must be renewed each year."
            },
            {
              question: "How do I surrender my pet to SABA?",
              answer: "Please call our office first to discuss the situation. We may be able to help you keep your pet or find alternatives to surrender. If surrender is necessary, we'll schedule an appointment."
            },
            {
              question: "How do I adopt an animal from SABA?",
              answer: "Start by viewing our available animals online or visiting our shelter. Once you find a pet you're interested in, fill out an adoption application."
            },
            {
              question: "What do I do if I find a stray animal?",
              answer: "Call our animal control dispatch at 555-123-4567. Do not approach the animal if it appears aggressive or injured."
            },
            {
              question: "What are your hours of operation?",
              answer: "Shelter: Monday-Friday 9 AM-6 PM, Saturday 10 AM-4 PM, Closed Sundays. Animal Control: Available 24/7 for emergencies."
            }
          ],
        });
      }
    } catch (error) {
      console.error("Error loading FAQ data:", error);
    } finally {
      setLoading(false);
    }
  };

  const toggleItem = (key: string) => {
    setOpenItems(prev => ({ ...prev, [key]: !prev[key] }));
  };

  if (loading || !data) {
    return <div>Loading...</div>;
  }

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
            {data.title}
          </h2>
          <p className="text-xl text-muted-foreground max-w-2xl mx-auto">
            {data.subtitle}
          </p>
        </motion.div>

        <div className="max-w-3xl mx-auto space-y-4">
          {data.faqs.map((item, index) => {
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
                        {item.question}
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
                            {item.answer}
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
      </div>
    </section>
  );
}
