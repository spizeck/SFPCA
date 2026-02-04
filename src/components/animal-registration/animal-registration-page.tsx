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
import { Plus, Trash2 } from "lucide-react";
import { AnimalRegistrationData } from "@/lib/types";
import { collection, addDoc, serverTimestamp } from "firebase/firestore";
import { db } from "@/lib/firebase";
import { OptimizedVideo } from "@/components/ui/optimized-video";

export function AnimalRegistration() {
  const [isSubmitting, setIsSubmitting] = useState(false);
  const { toast } = useToast();
  
  const [formData, setFormData] = useState({
    ownerName: "",
    ownerAddress: "",
    ownerPhone: "",
    ownerEmail: "",
    animals: [
      {
        name: "",
        type: "",
        sex: "",
        isFixed: "",
      } as AnimalRegistrationData,
    ],
    paymentReceipt: null as File | null,
  });

  const calculateTotalFee = () => {
    return formData.animals.reduce((total, animal) => {
      return total + (animal.isFixed === "yes" ? 10 : 100);
    }, 0);
  };

  const addAnimal = () => {
    setFormData({
      ...formData,
      animals: [
        ...formData.animals,
        {
          name: "",
          type: "",
          sex: "",
          isFixed: "",
        } as AnimalRegistrationData,
      ],
    });
  };

  const removeAnimal = (index: number) => {
    if (formData.animals.length > 1) {
      setFormData({
        ...formData,
        animals: formData.animals.filter((_, i) => i !== index),
      });
    }
  };

  const updateAnimal = (index: number, field: keyof AnimalRegistrationData, value: string) => {
    const updatedAnimals = [...formData.animals];
    updatedAnimals[index] = { ...updatedAnimals[index], [field]: value };
    setFormData({ ...formData, animals: updatedAnimals });
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsSubmitting(true);

    try {
      const totalFee = calculateTotalFee();
      
      // Prepare data for Firestore
      const registrationData = {
        ownerInfo: {
          name: formData.ownerName,
          address: formData.ownerAddress,
          phone: formData.ownerPhone,
          email: formData.ownerEmail,
        },
        animals: formData.animals,
        paymentReceipt: null, // Will be updated if file is uploaded
        totalFee,
        status: "pending",
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      };
      
      // Save to Firestore
      const docRef = await addDoc(collection(db, "animalRegistrations"), registrationData);
      
      // TODO: Upload payment receipt to Firebase Storage if provided
      if (formData.paymentReceipt) {
        // File upload logic would go here
        console.log("Payment receipt to upload:", formData.paymentReceipt);
      }
      
      console.log("Registration saved with ID:", docRef.id);
      
      toast({
        title: "Registration Submitted",
        description: `Your registration for ${formData.animals.length} animal(s) has been submitted. The total fee is $${totalFee}. Please allow 24-48 hours for verification.`,
      });
      
      // Reset form
      setFormData({
        ownerName: "",
        ownerAddress: "",
        ownerPhone: "",
        ownerEmail: "",
        animals: [
          {
            name: "",
            type: "",
            sex: "",
            isFixed: "",
          } as AnimalRegistrationData,
        ],
        paymentReceipt: null as File | null,
      });
    } catch (error) {
      console.error("Error submitting registration:", error);
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

  const totalFee = calculateTotalFee();

  return (
    <div className="min-h-screen bg-background">
      {/* Hero Section with Full Page Video Background */}
      <section className="relative min-h-screen overflow-hidden flex items-center justify-center">
        {/* Video Background */}
        <div className="absolute inset-0 z-0">
          <OptimizedVideo
            src="/videos/catbag.mp4"
            className="w-full h-full object-cover -z-10"
          />
          {/* Dark overlay for text readability */}
          <div className="absolute inset-0 bg-black/50" />
        </div>
        
        {/* Content */}
        <div className="relative z-10 container mx-auto px-4">
          <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.6 }}
            className="text-center max-w-4xl mx-auto"
          >
            <h1 className="text-4xl md:text-6xl font-bold mb-6 text-white">
              Animal Registration
            </h1>
            <p className="text-xl md:text-2xl mb-8 text-white/90">
              Register your pet with SABA. Annual registration required for all animals.
            </p>
            <div className="bg-white/10 backdrop-blur-sm rounded-lg p-6 max-w-2xl mx-auto">
              <h3 className="text-xl font-semibold mb-2 text-white">Registration Fees</h3>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4 text-left">
                <div className="bg-white/10 rounded p-3">
                  <p className="font-semibold text-white">Spayed/Neutered: $10</p>
                </div>
                <div className="bg-white/10 rounded p-3">
                  <p className="font-semibold text-white">Not Fixed: $100</p>
                </div>
              </div>
            </div>
            <Button size="lg" variant="secondary" className="mt-8" asChild>
              <a href="#form">Start Registration</a>
            </Button>
          </motion.div>
        </div>
      </section>

      {/* Registration Form */}
      <section id="form" className="py-20">
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
                  <div className="space-y-6">
                    <div className="flex items-center justify-between">
                      <h3 className="text-lg font-semibold">Animal Information</h3>
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        onClick={addAnimal}
                        className="flex items-center gap-2"
                      >
                        <Plus className="h-4 w-4" />
                        Add Another Animal
                      </Button>
                    </div>
                    
                    {formData.animals.map((animal, index) => (
                      <Card key={index} className="p-4">
                        <div className="flex items-center justify-between mb-4">
                          <h4 className="font-medium">Animal {index + 1}</h4>
                          {formData.animals.length > 1 && (
                            <Button
                              type="button"
                              variant="destructive"
                              size="sm"
                              onClick={() => removeAnimal(index)}
                              className="flex items-center gap-2"
                            >
                              <Trash2 className="h-4 w-4" />
                              Remove
                            </Button>
                          )}
                        </div>
                        
                        <div className="space-y-4">
                          <div>
                            <Label htmlFor={`animalName-${index}`}>Animal's Name *</Label>
                            <Input
                              id={`animalName-${index}`}
                              value={animal.name}
                              onChange={(e) => updateAnimal(index, 'name', e.target.value)}
                              required
                            />
                          </div>
                          <div>
                            <Label htmlFor={`animalType-${index}`}>Type of Animal *</Label>
                            <Input
                              id={`animalType-${index}`}
                              placeholder="e.g., Dog, Cat, etc."
                              value={animal.type}
                              onChange={(e) => updateAnimal(index, 'type', e.target.value)}
                              required
                            />
                          </div>
                          <div>
                            <Label>Sex *</Label>
                            <RadioGroup
                              value={animal.sex}
                              onValueChange={(value) => updateAnimal(index, 'sex', value)}
                              className="flex gap-4 mt-2"
                            >
                              <div className="flex items-center space-x-2">
                                <RadioGroupItem value="male" id={`male-${index}`} />
                                <Label htmlFor={`male-${index}`}>Male</Label>
                              </div>
                              <div className="flex items-center space-x-2">
                                <RadioGroupItem value="female" id={`female-${index}`} />
                                <Label htmlFor={`female-${index}`}>Female</Label>
                              </div>
                            </RadioGroup>
                          </div>
                          <div>
                            <Label>Is the animal spayed/neutered? *</Label>
                            <RadioGroup
                              value={animal.isFixed}
                              onValueChange={(value) => updateAnimal(index, 'isFixed', value)}
                              className="flex gap-4 mt-2"
                            >
                              <div className="flex items-center space-x-2">
                                <RadioGroupItem value="yes" id={`yes-${index}`} />
                                <Label htmlFor={`yes-${index}`}>Yes</Label>
                              </div>
                              <div className="flex items-center space-x-2">
                                <RadioGroupItem value="no" id={`no-${index}`} />
                                <Label htmlFor={`no-${index}`}>No</Label>
                              </div>
                            </RadioGroup>
                            {animal.isFixed && (
                              <p className="text-sm text-muted-foreground mt-2">
                                Registration fee: <span className="font-semibold text-primary">
                                  ${animal.isFixed === "yes" ? 10 : 100}
                                </span>
                              </p>
                            )}
                          </div>
                        </div>
                      </Card>
                    ))}
                    
                    <div className="bg-muted p-4 rounded-lg">
                      <h4 className="font-semibold mb-2">Fee Summary</h4>
                      <div className="space-y-1">
                        {formData.animals.map((animal, index) => (
                          <div key={index} className="flex justify-between text-sm">
                            <span>Animal {index + 1} ({animal.name || 'Unnamed'})</span>
                            <span>${animal.isFixed === "yes" ? 10 : 100}</span>
                          </div>
                        ))}
                        <div className="border-t pt-2 mt-2">
                          <div className="flex justify-between font-semibold">
                            <span>Total Fee:</span>
                            <span className="text-primary">${totalFee}</span>
                          </div>
                        </div>
                      </div>
                    </div>
                  </div>

                  {/* Payment Receipt */}
                  <div className="space-y-4">
                    <h3 className="text-lg font-semibold">Payment Information</h3>
                    <div>
                      <Label htmlFor="paymentReceipt">Upload Payment Receipt (Optional)</Label>
                      <Input
                        id="paymentReceipt"
                        type="file"
                        accept="image/*,.pdf"
                        onChange={handleFileChange}
                        className="mt-2"
                      />
                      <p className="text-sm text-muted-foreground mt-1">
                        Optionally upload a copy of your payment receipt. Accepted formats: JPG, PNG, PDF
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
                    {isSubmitting ? "Submitting..." : `Submit Registration - $${totalFee}`}
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
