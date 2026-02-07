"use client";

import { useState, useEffect } from "react";
import { collection, getDocs, orderBy, query } from "firebase/firestore";
import { db } from "@/lib/firebase";
import { motion, AnimatePresence } from "framer-motion";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { ChevronDown, ChevronUp, Phone, Mail, MapPin } from "lucide-react";
import { fadeInUpVariants, shouldReduceMotion } from "@/lib/animations";
import Link from "next/link";

interface FAQItem {
  id: string;
  category: string;
  question: string;
  answer: string;
  order: number;
}

export function FAQ() {
  const [openItems, setOpenItems] = useState<string[]>([]);
  const [faqs, setFaqs] = useState<FAQItem[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    loadFaqs();
  }, []);

  const loadFaqs = async () => {
    try {
      const q = query(collection(db, "faq"), orderBy("category"), orderBy("order"));
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

  const toggleItem = (id: string) => {
    setOpenItems(prev => 
      prev.includes(id) 
        ? prev.filter(i => i !== id)
        : [...prev, id]
    );
  };

  // Group FAQs by category
  const groupedFaqs = faqs.reduce((acc, faq) => {
    if (!acc[faq.category]) {
      acc[faq.category] = [];
    }
    acc[faq.category].push(faq);
    return acc;
  }, {} as Record<string, FAQItem[]>);

  // Category icons
  const categoryIcons: Record<string, string> = {
    "Registration Fees": "💰",
    "Getting Animals to SABA": "✈️",
    "Getting Animals from SABA": "🐾",
    "Veterinary Services": "🏥",
    "Adoption Process": "🏠",
    "General": "❓",
    "Other": "📋"
  };

  if (loading) {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center">
        <div className="text-center">
          <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary mx-auto mb-4"></div>
          <p className="text-muted-foreground">Loading FAQs...</p>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-background">
      {/* Hero Section */}
      <section className="py-20 bg-primary text-primary-foreground">
        <div className="container mx-auto px-4">
          <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.6 }}
            className="text-center"
          >
            <h1 className="text-4xl md:text-5xl font-bold mb-4">
              Frequently Asked Questions
            </h1>
            <p className="text-xl max-w-2xl mx-auto">
              Find answers to common questions about our services and animal care
            </p>
          </motion.div>
        </div>
      </section>

      {/* FAQ Content */}
      <section className="py-16">
        <div className="container mx-auto px-4">
          <div className="max-w-4xl mx-auto space-y-8">
            {Object.entries(groupedFaqs).map(([category, categoryFaqs], categoryIndex) => (
              <motion.div
                key={category}
                initial={{ opacity: 0, y: 20 }}
                whileInView={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.5, delay: categoryIndex * 0.1 }}
                viewport={{ once: true }}
              >
                <Card>
                  <CardHeader>
                    <div className="flex items-center gap-3">
                      <span className="text-2xl">{categoryIcons[category] || "❓"}</span>
                      <CardTitle className="text-2xl">{category}</CardTitle>
                    </div>
                  </CardHeader>
                  <CardContent className="space-y-4">
                    {categoryFaqs.map((faq, index) => {
                      const isOpen = openItems.includes(faq.id);
                      
                      return (
                        <motion.div
                          key={faq.id}
                          initial={{ opacity: 0, y: 10 }}
                          animate={{ opacity: 1, y: 0 }}
                          transition={{ duration: 0.3, delay: index * 0.05 }}
                        >
                          <Card>
                            <CardHeader
                              className="cursor-pointer select-none"
                              onClick={() => toggleItem(faq.id)}
                            >
                              <div className="flex items-center justify-between">
                                <h3 className="text-lg font-medium text-left">
                                  {faq.question}
                                </h3>
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
                                    <p className="text-muted-foreground whitespace-pre-wrap">
                                      {faq.answer}
                                    </p>
                                  </CardContent>
                                </motion.div>
                              )}
                            </AnimatePresence>
                          </Card>
                        </motion.div>
                      );
                    })}
                  </CardContent>
                </Card>
              </motion.div>
            ))}
            
            {faqs.length === 0 && (
              <Card>
                <CardContent className="pt-6">
                  <div className="text-center text-muted-foreground">
                    <p>No FAQs available yet.</p>
                    <p className="text-sm mt-2">Please check back later or contact us directly.</p>
                  </div>
                </CardContent>
              </Card>
            )}
          </div>
        </div>
      </section>

      {/* Contact Section */}
      <section className="py-16 bg-muted">
        <div className="container mx-auto px-4">
          <motion.div
            initial={{ opacity: 0, y: 20 }}
            whileInView={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.6 }}
            viewport={{ once: true }}
            className="text-center"
          >
            <h2 className="text-3xl font-bold mb-4">Still Have Questions?</h2>
            <p className="text-xl text-muted-foreground mb-8">
              We&apos;re here to help! Contact us with any other questions.
            </p>
            <div className="flex flex-col md:flex-row gap-4 justify-center">
              <Button size="lg" asChild>
                <a href="tel:+5994167947">
                  <Phone className="mr-2 h-4 w-4" />
                  Call Us
                </a>
              </Button>
              <Button size="lg" variant="outline" asChild>
                <a href="mailto:sfpcasaba@gmail.com">
                  <Mail className="mr-2 h-4 w-4" />
                  Email Us
                </a>
              </Button>
              <Button size="lg" variant="outline" asChild>
                <Link href="/contact">
                  <MapPin className="mr-2 h-4 w-4" />
                  Visit Us
                </Link>
              </Button>
            </div>
          </motion.div>
        </div>
      </section>
    </div>
  );
}
