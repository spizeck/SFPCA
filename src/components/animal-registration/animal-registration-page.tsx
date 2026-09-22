"use client";

import { useRef, useState } from "react";
import { motion } from "framer-motion";
import { shouldReduceMotion } from "@/lib/animations";
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
import { collection, doc, setDoc, serverTimestamp } from "firebase/firestore";
import { ref, uploadBytes, deleteObject } from "firebase/storage";
import { db, storage } from "@/lib/firebase";
import { logError } from "@/lib/logger";
import {
  calculateRegistrationFee,
  isReceiptFile,
  validateRegistration,
  REGISTRATION_FIELD_LIMITS,
  REGISTRATION_FEE_FIXED,
  REGISTRATION_FEE_NOT_FIXED,
  REGISTRATION_INITIAL_STATUS,
} from "@/lib/animal-registration";
import { OptimizedVideo } from "@/components/ui/optimized-video";
import {
  AnimalRegistrationContent,
  DEFAULT_REGISTRATION_CONTENT,
} from "@/lib/page-content";

export function AnimalRegistration({
  content = DEFAULT_REGISTRATION_CONTENT,
}: {
  content?: AnimalRegistrationContent;
}) {
  const [isSubmitting, setIsSubmitting] = useState(false);
  // Synchronous re-entrancy guard: state updates flush after the event
  // handler runs, so a fast double-submit could slip past a state check.
  const submittingRef = useRef(false);
  const [receiptError, setReceiptError] = useState<string | null>(null);
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

  const calculateTotalFee = () => calculateRegistrationFee(formData.animals);

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
    // Guard against re-entrant submits (double-click, Enter during submit).
    if (submittingRef.current) return;

    const trimmed = {
      ownerName: formData.ownerName.trim(),
      ownerAddress: formData.ownerAddress.trim(),
      ownerPhone: formData.ownerPhone.trim(),
      ownerEmail: formData.ownerEmail.trim(),
      animals: formData.animals.map((a) => ({
        ...a,
        name: a.name.trim(),
        type: a.type.trim(),
      })),
    };

    // Structural check mirroring the Firestore rules so a bad submission
    // fails here with a useful message rather than a generic write error.
    const errors = validateRegistration(trimmed);
    if (errors.owner || errors.animals) {
      toast({
        title: "Check your submission",
        description: errors.owner ?? errors.animals,
        variant: "destructive",
      });
      return;
    }

    submittingRef.current = true;
    setIsSubmitting(true);

    try {
      const totalFee = calculateTotalFee();

      // The registration document ID is generated up front so the
      // receipt object can live at the path bound to it
      // (receipts/<doc id>). That binding is what lets the rules layer
      // authorize orphan cleanup and prevents a submission from ever
      // referencing another registration's receipt.
      const docRef = doc(collection(db, "animalRegistrations"));

      // Upload the optional receipt first so its storage path can be
      // written with the submission in a single public create. A failed
      // upload must not block the registration itself.
      let receiptPath: string | null = null;
      if (formData.paymentReceipt) {
        try {
          const path = `receipts/${docRef.id}`;
          await uploadBytes(ref(storage, path), formData.paymentReceipt, {
            contentType: formData.paymentReceipt.type,
          });
          receiptPath = path;
        } catch (uploadError) {
          logError("registration", "receipt-upload", uploadError);
        }
      }

      const registrationData = {
        ownerInfo: {
          name: trimmed.ownerName,
          address: trimmed.ownerAddress,
          phone: trimmed.ownerPhone,
          email: trimmed.ownerEmail,
        },
        animals: trimmed.animals,
        paymentReceipt: receiptPath,
        totalFee,
        status: REGISTRATION_INITIAL_STATUS,
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      };

      let submissionLanded = false;
      try {
        await setDoc(docRef, registrationData);
        submissionLanded = true;
      } catch (writeError) {
        // The receipt upload already succeeded — the object is an orphan
        // unless removed. Storage rules permit anonymous delete of a
        // receipts/<id> object only while animalRegistrations/<id> does
        // not exist, so this delete succeeds exactly when the write
        // truly failed and is denied when the document actually landed.
        if (receiptPath) {
          try {
            await deleteObject(ref(storage, receiptPath));
          } catch (cleanupError) {
            if (
              (cleanupError as { code?: string }).code ===
              "storage/unauthorized"
            ) {
              // Delete denied ⟺ the registration document exists: the
              // write succeeded but its response was lost. Treat the
              // submission as successful rather than retrying into a
              // duplicate.
              submissionLanded = true;
            } else {
              // Cleanup itself failed (offline, quota, ...). The orphan
              // is not permanent: the scheduled sweepOrphanedReceipts
              // function deletes unreferenced receipts. Report the
              // write failure honestly either way.
              logError("registration", "receipt-cleanup", cleanupError);
            }
          }
        }
        if (!submissionLanded) throw writeError;
      }

      toast({
        title: "Registration Submitted",
        description:
          formData.paymentReceipt && !receiptPath
            ? `Your registration for ${formData.animals.length} animal(s) was submitted, but the receipt could not be uploaded. You can bring it to our office instead.`
            : `Your registration for ${formData.animals.length} animal(s) has been submitted. The total fee is $${totalFee}. Please allow 24-48 hours for verification.`,
      });

      // Reset form only after the write succeeds so failed submissions
      // preserve what the visitor entered.
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
      setReceiptError(null);
    } catch (error) {
      logError("registration", "submit", error);
      toast({
        title: "Error",
        description: "Failed to submit registration. Please try again.",
        variant: "destructive",
      });
    } finally {
      submittingRef.current = false;
      setIsSubmitting(false);
    }
  };

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    if (!isReceiptFile(file)) {
      setFormData({ ...formData, paymentReceipt: null });
      setReceiptError(
        "Receipt must be an image or PDF no larger than 5 MB.",
      );
      e.target.value = "";
      return;
    }
    setReceiptError(null);
    setFormData({ ...formData, paymentReceipt: file });
  };

  const totalFee = calculateTotalFee();

  return (
    <div className="min-h-screen bg-background">
      {/* Hero Section with Full Page Video Background */}
      <section className="relative min-h-screen overflow-hidden flex items-center justify-center">
        {/* Video Background */}
        <div className="absolute inset-0 z-0 bg-black">
          <OptimizedVideo
            src="/videos/catbag.mp4"
            webmSrc="/videos/catbag.webm"
            className="w-full h-full object-cover -z-10"
          />
          {/* Dark overlay for text readability */}
          <div className="absolute inset-0 bg-black/50" />
        </div>
        
        {/* Content */}
        <div className="relative z-10 container mx-auto px-4">
          <motion.div
            initial={{ opacity: shouldReduceMotion() ? 1 : 0, y: shouldReduceMotion() ? 0 : 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.6 }}
            className="text-center max-w-4xl mx-auto"
          >
            <h1 className="text-4xl md:text-6xl font-bold mb-6 text-white">
              {content.heroTitle}
            </h1>
            <p className="text-xl md:text-2xl mb-8 text-white/90">
              {content.heroDescription}
            </p>
            <div className="bg-black/40 backdrop-blur-sm rounded-lg p-6 max-w-2xl mx-auto">
              <h2 className="text-xl font-semibold mb-2 text-white">Registration Fees</h2>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4 text-left">
                <div className="bg-white/10 rounded p-3">
                  <p className="font-semibold text-white">Spayed/Neutered: ${REGISTRATION_FEE_FIXED}</p>
                </div>
                <div className="bg-white/10 rounded p-3">
                  <p className="font-semibold text-white">Not Fixed: ${REGISTRATION_FEE_NOT_FIXED}</p>
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
            initial={{ opacity: shouldReduceMotion() ? 1 : 0, y: shouldReduceMotion() ? 0 : 20 }}
            whileInView={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.6 }}
            viewport={{ once: true }}
          >
            <Card>
              <CardHeader>
                <h2 className="text-2xl font-semibold tracking-tight">{content.formTitle}</h2>
                <p className="text-muted-foreground">
                  {content.formDescription}
                </p>
              </CardHeader>
              <CardContent>
                <form onSubmit={handleSubmit} className="space-y-6">
                  {/* Owner Information */}
                  <div className="space-y-4">
                    <h3 className="text-lg font-semibold">Owner Information</h3>
                    <div>
                      <Label htmlFor="ownerName">Full Name <span aria-hidden="true">*</span></Label>
                      <Input
                        id="ownerName"
                        autoComplete="name"
                        value={formData.ownerName}
                        onChange={(e) => setFormData({ ...formData, ownerName: e.target.value })}
                        maxLength={REGISTRATION_FIELD_LIMITS.ownerName}
                        required
                      />
                    </div>
                    <div>
                      <Label htmlFor="ownerAddress">Address <span aria-hidden="true">*</span></Label>
                      <Textarea
                        id="ownerAddress"
                        autoComplete="street-address"
                        value={formData.ownerAddress}
                        onChange={(e) => setFormData({ ...formData, ownerAddress: e.target.value })}
                        maxLength={REGISTRATION_FIELD_LIMITS.ownerAddress}
                        required
                      />
                    </div>
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                      <div>
                        <Label htmlFor="ownerPhone">Phone Number <span aria-hidden="true">*</span></Label>
                        <Input
                          id="ownerPhone"
                          type="tel"
                          autoComplete="tel"
                          value={formData.ownerPhone}
                          onChange={(e) => setFormData({ ...formData, ownerPhone: e.target.value })}
                          maxLength={REGISTRATION_FIELD_LIMITS.ownerPhone}
                          required
                        />
                      </div>
                      <div>
                        <Label htmlFor="ownerEmail">Email Address <span aria-hidden="true">*</span></Label>
                        <Input
                          id="ownerEmail"
                          type="email"
                          autoComplete="email"
                          value={formData.ownerEmail}
                          onChange={(e) => setFormData({ ...formData, ownerEmail: e.target.value })}
                          maxLength={REGISTRATION_FIELD_LIMITS.ownerEmail}
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
                        disabled={
                          formData.animals.length >=
                          REGISTRATION_FIELD_LIMITS.maxAnimals
                        }
                        className="flex items-center gap-2"
                      >
                        <Plus className="h-4 w-4" aria-hidden="true" />
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
                              <Trash2 className="h-4 w-4" aria-hidden="true" />
                              Remove<span className="sr-only"> animal {index + 1}</span>
                            </Button>
                          )}
                        </div>
                        
                        <div className="space-y-4">
                          <div>
                            <Label htmlFor={`animalName-${index}`}>Animal&apos;s Name <span aria-hidden="true">*</span></Label>
                            <Input
                              id={`animalName-${index}`}
                              value={animal.name}
                              onChange={(e) => updateAnimal(index, 'name', e.target.value)}
                              maxLength={REGISTRATION_FIELD_LIMITS.animalName}
                              required
                            />
                          </div>
                          <div>
                            <Label htmlFor={`animalType-${index}`}>Type of Animal <span aria-hidden="true">*</span></Label>
                            <Input
                              id={`animalType-${index}`}
                              placeholder="e.g., Dog, Cat, etc."
                              value={animal.type}
                              onChange={(e) => updateAnimal(index, 'type', e.target.value)}
                              maxLength={REGISTRATION_FIELD_LIMITS.animalType}
                              required
                            />
                          </div>
                          <fieldset>
                            <legend className="text-sm font-medium leading-none">Sex <span aria-hidden="true">*</span></legend>
                            <RadioGroup
                              name={`sex-${index}`}
                              value={animal.sex}
                              onValueChange={(value) => updateAnimal(index, 'sex', value)}
                              className="flex gap-4 mt-2"
                              required
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
                          </fieldset>
                          <fieldset>
                            <legend className="text-sm font-medium leading-none">Is the animal spayed/neutered? <span aria-hidden="true">*</span></legend>
                            <RadioGroup
                              name={`fixed-${index}`}
                              value={animal.isFixed}
                              onValueChange={(value) => updateAnimal(index, 'isFixed', value)}
                              className="flex gap-4 mt-2"
                              required
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
                                  ${animal.isFixed === "yes" ? REGISTRATION_FEE_FIXED : REGISTRATION_FEE_NOT_FIXED}
                                </span>
                              </p>
                            )}
                          </fieldset>
                        </div>
                      </Card>
                    ))}
                    
                    <div className="bg-muted p-4 rounded-lg">
                      <h4 className="font-semibold mb-2">Fee Summary</h4>
                      <div className="space-y-1">
                        {formData.animals.map((animal, index) => (
                          <div key={index} className="flex justify-between text-sm">
                            <span>Animal {index + 1} ({animal.name || 'Unnamed'})</span>
                            <span>${animal.isFixed === "yes" ? REGISTRATION_FEE_FIXED : REGISTRATION_FEE_NOT_FIXED}</span>
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
                        aria-describedby="paymentReceipt-help"
                      />
                      <p id="paymentReceipt-help" className="text-sm text-muted-foreground mt-1">
                        Optionally upload a copy of your payment receipt. Accepted formats: JPG, PNG, PDF (max 5 MB)
                      </p>
                      {receiptError && (
                        <p role="alert" className="text-sm text-destructive mt-1">
                          {receiptError}
                        </p>
                      )}
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
                  <CardTitle>{content.howToPayTitle}</CardTitle>
                </CardHeader>
                <CardContent>
                  <ul className="list-disc pl-5 space-y-2">
                    {content.howToPayItems.map((item, index) => (
                      <li key={index}>{item}</li>
                    ))}
                  </ul>
                </CardContent>
              </Card>
              <Card>
                <CardHeader>
                  <CardTitle>{content.whatHappensNextTitle}</CardTitle>
                </CardHeader>
                <CardContent>
                  <ul className="list-disc pl-5 space-y-2">
                    {content.whatHappensNextItems.map((item, index) => (
                      <li key={index}>{item}</li>
                    ))}
                  </ul>
                </CardContent>
              </Card>
            </div>
          </div>
        </div>
      </section>
    </div>
  );
}
