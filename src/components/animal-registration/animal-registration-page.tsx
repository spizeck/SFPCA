"use client";

import { useState } from "react";
import { motion } from "framer-motion";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Checkbox } from "@/components/ui/checkbox";
import { useToast } from "@/hooks/use-toast";

export function AnimalRegistration() {
  const [isSubmitting, setIsSubmitting] = useState(false);
  const { toast } = useToast();
  
  const [formData, setFormData] = useState({
    ownerName: "",
    ownerAddress: "",
    ownerPhone: "",
    ownerEmail: "",
    animalName: "",
    animalType: "",
    animalSex: "",
    isFixed: "",
    paymentReceipt: null as File | null,
  });

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsSubmitting(true);

    try {
      // Calculate registration fee
      const fee = formData.isFixed === "yes" ? 10 : 100;
      
      // Here you would upload to Firebase Storage and save to Firestore
      console.log("Submitting registration:", { ...formData, fee });
      
      toast({
        title: "Registration Submitted",
        description: `Your registration has been submitted. The fee is $${fee}. Please allow 24-48 hours for verification.`,
      });
      
      // Reset form
      setFormData({
        ownerName: "",
        ownerAddress: "",
        ownerPhone: "",
        ownerEmail: "",
        animalName: "",
        animalType: "",
        animalSex: "",
        isFixed: "",
        paymentReceipt: null as File | null,
      });
    } catch (error) {
      toast({
        title: "Error",
        description: "Failed to submit registration. Please try again.",
        variant: "destructive",
      });
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files[0]) {
      setFormData({ ...formData, paymentReceipt: e.target.files[0] });
    }
  };

  const handleSexChange = (value: string) => {
    setFormData({ ...formData, animalSex: value });
  };

  const handleFixedChange = (value: string) => {
    setFormData({ ...formData, isFixed: value });
  };

  const fee = formData.isFixed === "yes" ? 10 : 100;

  return (
    <div className="min-h-screen bg-background">
      {/* Hero Section */}
      <section className="py-20 bg-primary text-primary-foreground">
        <div className="container mx-auto px-4">
          <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.6 }}
            className="text-center max-w-4xl mx-auto"
          >
            <h1 className="text-4xl md:text-6xl font-bold mb-6">
              Animal Registration
            </h1>
            <p className="text-xl md:text-2xl mb-8">
              Register your pet with SABA. Annual registration required for all animals.
            </p>
            <div className="bg-primary-foreground/20 rounded-lg p-6 max-w-2xl mx-auto">
              <h3 className="text-xl font-semibold mb-2">Registration Fees</h3>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4 text-left">
                <div className="bg-white/10 rounded p-3">
                  <p className="font-semibold">Spayed/Neutered: $10</p>
                </div>
                <div className="bg-white/10 rounded p-3">
                  <p className="font-semibold">Not Fixed: $100</p>
                </div>
              </div>
            </div>
          </motion.div>
        </div>
      </section>

      {/* Registration Form */}
      <section className="py-20">
        <div className="container mx-auto px-4 max-w-2xl">
          <motion.div
            initial={{ opacity: 0, y: 20 }}
            whileInView={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.6 }}
            viewport={{ once: true }}
          >
            <Card>
              <CardHeader>
                <CardTitle className="text-2xl">Animal Registration Form</CardTitle>
                <p className="text-muted-foreground">
                  Please fill out all required fields. Registration must be renewed annually.
                </p>
              </CardHeader>
              <CardContent>
                <form onSubmit={handleSubmit} className="space-y-6">
                  {/* Owner Information */}
                  <div className="space-y-4">
                    <h3 className="text-lg font-semibold">Owner Information</h3>
                    <div>
                      <Label htmlFor="ownerName">Full Name *</Label>
                      <Input
                        id="ownerName"
                        value={formData.ownerName}
                        onChange={(e) => setFormData({ ...formData, ownerName: e.target.value })}
                        required
                      />
                    </div>
                    <div>
                      <Label htmlFor="ownerAddress">Address *</Label>
                      <Textarea
                        id="ownerAddress"
                        value={formData.ownerAddress}
                        onChange={(e) => setFormData({ ...formData, ownerAddress: e.target.value })}
                        required
                      />
                    </div>
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                      <div>
                        <Label htmlFor="ownerPhone">Phone Number *</Label>
                        <Input
                          id="ownerPhone"
                          type="tel"
                          value={formData.ownerPhone}
                          onChange={(e) => setFormData({ ...formData, ownerPhone: e.target.value })}
                          required
                        />
                      </div>
                      <div>
                        <Label htmlFor="ownerEmail">Email Address *</Label>
                        <Input
                          id="ownerEmail"
                          type="email"
                          value={formData.ownerEmail}
                          onChange={(e) => setFormData({ ...formData, ownerEmail: e.target.value })}
                          required
                        />
                      </div>
                    </div>
                  </div>

                  {/* Animal Information */}
                  <div className="space-y-4">
                    <h3 className="text-lg font-semibold">Animal Information</h3>
                    <div>
                      <Label htmlFor="animalName">Animal's Name *</Label>
                      <Input
                        id="animalName"
                        value={formData.animalName}
                        onChange={(e) => setFormData({ ...formData, animalName: e.target.value })}
                        required
                      />
                    </div>
                    <div>
                      <Label htmlFor="animalType">Type of Animal *</Label>
                      <Input
                        id="animalType"
                        placeholder="e.g., Dog, Cat, etc."
                        value={formData.animalType}
                        onChange={(e) => setFormData({ ...formData, animalType: e.target.value })}
                        required
                      />
                    </div>
                    <div>
                      <Label>Sex *</Label>
                      <RadioGroup
                        value={formData.animalSex}
                        onValueChange={handleSexChange}
                        className="flex gap-4 mt-2"
                      >
                        <div className="flex items-center space-x-2">
                          <RadioGroupItem value="male" id="male" />
                          <Label htmlFor="male">Male</Label>
                        </div>
                        <div className="flex items-center space-x-2">
                          <RadioGroupItem value="female" id="female" />
                          <Label htmlFor="female">Female</Label>
                        </div>
                      </RadioGroup>
                    </div>
                    <div>
                      <Label>Is the animal spayed/neutered? *</Label>
                      <RadioGroup
                        value={formData.isFixed}
                        onValueChange={handleFixedChange}
                        className="flex gap-4 mt-2"
                      >
                        <div className="flex items-center space-x-2">
                          <RadioGroupItem value="yes" id="yes" />
                          <Label htmlFor="yes">Yes</Label>
                        </div>
                        <div className="flex items-center space-x-2">
                          <RadioGroupItem value="no" id="no" />
                          <Label htmlFor="no">No</Label>
                        </div>
                      </RadioGroup>
                      {formData.isFixed && (
                        <p className="text-sm text-muted-foreground mt-2">
                          Registration fee: <span className="font-semibold text-primary">${fee}</span>
                        </p>
                      )}
                    </div>
                  </div>

                  {/* Payment Receipt */}
                  <div className="space-y-4">
                    <h3 className="text-lg font-semibold">Payment Information</h3>
                    <div>
                      <Label htmlFor="paymentReceipt">Upload Payment Receipt *</Label>
                      <Input
                        id="paymentReceipt"
                        type="file"
                        accept="image/*,.pdf"
                        onChange={handleFileChange}
                        className="mt-2"
                        required
                      />
                      <p className="text-sm text-muted-foreground mt-1">
                        Please upload a copy of your payment receipt. Accepted formats: JPG, PNG, PDF
                      </p>
                    </div>
                  </div>

                  {/* Terms and Conditions */}
                  <div className="space-y-4">
                    <div className="flex items-start space-x-2">
                      <Checkbox id="terms" required />
                      <Label htmlFor="terms" className="text-sm">
                        I certify that all information provided is accurate and understand that this registration must be renewed annually.
                      </Label>
                    </div>
                  </div>

                  <Button type="submit" className="w-full" disabled={isSubmitting}>
                    {isSubmitting ? "Submitting..." : `Submit Registration - $${fee}`}
                  </Button>
                </form>
              </CardContent>
            </Card>
          </motion.div>
        </div>
      </section>

      {/* Additional Information */}
      <section className="py-20 bg-muted">
        <div className="container mx-auto px-4">
          <div className="max-w-3xl mx-auto">
            <h2 className="text-3xl font-bold text-foreground mb-8 text-center">
              Registration Information
            </h2>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-8">
              <Card>
                <CardHeader>
                  <CardTitle>How to Pay</CardTitle>
                </CardHeader>
                <CardContent className="space-y-2">
                  <p>• In person at our office</p>
                  <p>• Via bank transfer</p>
                  <p>• Through our online portal</p>
                  <p>• At participating vet clinics</p>
                </CardContent>
              </Card>
              <Card>
                <CardHeader>
                  <CardTitle>What Happens Next</CardTitle>
                </CardHeader>
                <CardContent className="space-y-2">
                  <p>• Submit this form with payment receipt</p>
                  <p>• We verify your payment within 24-48 hours</p>
                  <p>• You'll receive a registration certificate</p>
                  <p>• Annual renewal required</p>
                </CardContent>
              </Card>
            </div>
          </div>
        </div>
      </section>
    </div>
  );
}
