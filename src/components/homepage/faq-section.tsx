"use client";

import { useState, useEffect } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { ChevronDown, ChevronUp } from "lucide-react";
import { fadeInUpVariants, shouldReduceMotion } from "@/lib/animations";
import { collection, getDocs, orderBy, query } from "firebase/firestore";
import { db } from "@/lib/firebase";

interface FAQItem {
  id: string;
  category: string;
  question: string;
  answer: string;
  order: number;
}

export function FaqSection() {
  const [openItems, setOpenItems] = useState<{ [key: string]: boolean }>({});
  const [faqs, setFaqs] = useState<FAQItem[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    loadFaqs();
  }, []);

  const loadFaqs = async () => {
    try {
      const q = query(collection(db, "faq"), orderBy("order"));
      const querySnapshot = await getDocs(q);
      const faqsData: FAQItem[] = [];
      
      querySnapshot.forEach((doc) => {
        const data = doc.data();
        faqsData.push({
          id: doc.id,
          category: data.category,
          question: data.question,
          answer: data.answer,
          order: data.order,
        });
      });
      
      setFaqs(faqsData);
    } catch (error) {
      console.error("Error loading FAQs:", error);
    } finally {
      setLoading(false);
    }
  };

  const toggleItem = (key: string) => {
    setOpenItems(prev => ({ ...prev, [key]: !prev[key] }));
  };

  if (loading) {
    return <div>Loading...</div>;
  }

  // Show first 5 FAQs on homepage
  const homepageFaqs = faqs.slice(0, 5);

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
          {faqs.length > 5 && (
            <Button asChild className="mt-4" variant="outline">
              <a href="/faq">View All FAQs</a>
            </Button>
          )}
        </motion.div>

        <div className="max-w-3xl mx-auto space-y-4">
          {homepageFaqs.map((item, index) => {
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
