"use client";

import { useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { ChevronDown, ChevronUp, Phone, Mail, MapPin } from "lucide-react";
import { fadeInUpVariants, shouldReduceMotion } from "@/lib/animations";

const faqCategories = [
  {
    title: "Registration Fees",
    icon: "💰",
    questions: [
      {
        q: "How much does animal registration cost?",
        a: "Registration fees are $10 for spayed/neutered animals and $100 for unaltered animals. This is an annual fee that must be renewed each year."
      },
      {
        q: "When do I need to register my pet?",
        a: "All pets must be registered within 30 days of arrival on Saba or when they reach 4 months of age. Registration must be renewed annually."
      },
      {
        q: "What payment methods are accepted?",
        a: "We accept cash, bank transfers, and major credit cards. Payment can be made at our shelter or online through our payment portal."
      }
    ]
  },
  {
    title: "Getting Animals to SABA",
    icon: "✈️",
    questions: [
      {
        q: "How do I transport my pet to Saba?",
        a: "Pets can travel via WinAir or other regional carriers. You'll need a health certificate from a vet within 10 days of travel, proof of vaccinations, and a valid registration."
      },
      {
        q: "What vaccinations are required?",
        a: "Dogs need rabies, DHPP, and bordetella. Cats need rabies and FVRCP. All vaccinations must be current and documented."
      },
      {
        q: "Is quarantine required?",
        a: "No quarantine is required for pets with proper documentation from rabies-free areas. Please contact us for specific requirements based on your origin."
      }
    ]
  },
  {
    title: "Getting Animals from SABA",
    icon: "🐾",
    questions: [
      {
        q: "How do I adopt an animal from SABA?",
        a: "Start by viewing our available animals online or visiting our shelter. Once you find a pet you're interested in, fill out an adoption application and schedule a meet-and-greet."
      },
      {
        q: "What are the adoption fees?",
        a: "Adoption fees vary by animal and include spay/neuter, initial vaccinations, and microchipping. Please contact us for current fee information."
      },
      {
        q: "Can you help transport adopted animals off-island?",
        a: "Yes, we can assist with arranging transport for adopted animals to many destinations. Adopters are responsible for transport costs and travel requirements."
      }
    ]
  },
  {
    title: "Animal Control Services",
    icon: "🚓",
    questions: [
      {
        q: "What do I do if I find a stray animal?",
        a: "Call our animal control dispatch at 555-123-4567. Do not approach the animal if it appears aggressive or injured. Our team will respond promptly."
      },
      {
        q: "Is animal control available 24/7?",
        a: "Yes, we provide 24/7 emergency response for injured animals, dangerous animals, and animal cruelty reports. Non-emergency calls are handled during shelter hours."
      },
      {
        q: "How do I report animal cruelty?",
        a: "Call our emergency line immediately at 555-123-4567. All reports are confidential and investigated promptly."
      }
    ]
  },
  {
    title: "General Information",
    icon: "ℹ️",
    questions: [
      {
        q: "What are your hours of operation?",
        a: "Shelter: Monday-Friday 9 AM-6 PM, Saturday 10 AM-4 PM, Closed Sundays. Animal Control: Available 24/7 for emergencies."
      },
      {
        q: "How can I volunteer?",
        a: "We welcome volunteers! Please visit our shelter to fill out a volunteer application or email us at volunteer@sfpca.org. Opportunities include dog walking, cat socialization, and event assistance."
      },
      {
        q: "How can I donate?",
        a: "We accept monetary donations, pet food, supplies, and your time. Visit our Support Our Mission section or call us to learn more about donation options."
      }
    ]
  }
];

export function FAQ() {
  const [openItems, setOpenItems] = useState<{ [key: string]: boolean }>({});
  
  const toggleItem = (key: string) => {
    setOpenItems((prev: { [key: string]: boolean }) => ({ ...prev, [key]: !prev[key] }));
  };

  const toggleCategory = (category: string) => {
    const categoryItems = faqCategories
      .find(c => c.title === category)
      ?.questions.map((_, index) => `${category}-${index}`) || [];
    
    const allOpen = categoryItems.every(item => openItems[item]);
    
    if (allOpen) {
      setOpenItems((prev: { [key: string]: boolean }) => {
        const newState = { ...prev };
        categoryItems.forEach(item => delete newState[item]);
        return newState;
      });
    } else {
      setOpenItems((prev: { [key: string]: boolean }) => {
        const newState = { ...prev };
        categoryItems.forEach(item => {
          newState[item] = true;
        });
        return newState;
      });
    }
  };

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
            {faqCategories.map((category, categoryIndex) => (
              <motion.div
                key={category.title}
                initial={{ opacity: 0, y: 20 }}
                whileInView={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.5, delay: categoryIndex * 0.1 }}
                viewport={{ once: true }}
              >
                <Card>
                  <CardHeader>
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-3">
                        <span className="text-2xl">{category.icon}</span>
                        <CardTitle className="text-2xl">{category.title}</CardTitle>
                      </div>
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => toggleCategory(category.title)}
                      >
                        Expand All
                      </Button>
                    </div>
                  </CardHeader>
                  <CardContent className="space-y-4">
                    {category.questions.map((item, index) => {
                      const key = `${category.title}-${index}`;
                      const isOpen = openItems[key];
                      
                      return (
                        <motion.div
                          key={key}
                          initial={{ opacity: 0, y: 10 }}
                          animate={{ opacity: 1, y: 0 }}
                          transition={{ duration: 0.3, delay: index * 0.05 }}
                        >
                          <Card>
                            <CardHeader
                              className="cursor-pointer select-none"
                              onClick={() => toggleItem(key)}
                            >
                              <div className="flex items-center justify-between">
                                <h3 className="text-lg font-medium text-left">
                                  {item.q}
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
                  </CardContent>
                </Card>
              </motion.div>
            ))}
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
              We're here to help! Contact us with any other questions.
            </p>
            <div className="flex flex-col md:flex-row gap-4 justify-center">
              <Button size="lg" asChild>
                <a href="tel:+5994161234">
                  <Phone className="mr-2 h-4 w-4" />
                  Call Us
                </a>
              </Button>
              <Button size="lg" variant="outline" asChild>
                <a href="mailto:info@sfpca.org">
                  <Mail className="mr-2 h-4 w-4" />
                  Email Us
                </a>
              </Button>
              <Button size="lg" variant="outline" asChild>
                <a href="/#contact">
                  <MapPin className="mr-2 h-4 w-4" />
                  Visit Us
                </a>
              </Button>
            </div>
          </motion.div>
        </div>
      </section>
    </div>
  );
}
