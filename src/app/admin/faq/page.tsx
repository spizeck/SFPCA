"use client";

import { useState, useEffect } from "react";
import { doc, getDoc, setDoc } from "firebase/firestore";
import { db } from "@/lib/firebase";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { useToast } from "@/hooks/use-toast";

interface FAQ {
  question: string;
  answer: string;
}

interface FAQData {
  title: string;
  subtitle: string;
  faqs: FAQ[];
}

export default function FAQAdminPage() {
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const { toast } = useToast();
  
  const [data, setData] = useState<FAQData>({
    title: "Frequently Asked Questions",
    subtitle: "Find answers to common questions about our services",
    faqs: [
      { question: "", answer: "" },
      { question: "", answer: "" },
      { question: "", answer: "" },
      { question: "", answer: "" },
      { question: "", answer: "" },
    ],
  });

  useEffect(() => {
    loadData();
  }, []);

  const loadData = async () => {
    try {
      const docRef = doc(db, "faq", "main");
      const docSnap = await getDoc(docRef);
      
      if (docSnap.exists()) {
        setData(docSnap.data() as FAQData);
      }
    } catch (error) {
      console.error("Error loading FAQ data:", error);
      toast({
        title: "Error",
        description: "Failed to load data",
        variant: "destructive",
      });
    } finally {
      setLoading(false);
    }
  };

  const handleSave = async () => {
    setSaving(true);
    try {
      const docRef = doc(db, "faq", "main");
      await setDoc(docRef, data);
      
      toast({
        title: "Success",
        description: "FAQ page updated successfully",
      });
    } catch (error) {
      console.error("Error saving data:", error);
      toast({
        title: "Error",
        description: "Failed to save data",
        variant: "destructive",
      });
    } finally {
      setSaving(false);
    }
  };

  const updateFAQ = (index: number, field: keyof FAQ, value: string) => {
    const newFAQs = [...data.faqs];
    newFAQs[index] = { ...newFAQs[index], [field]: value };
    setData({ ...data, faqs: newFAQs });
  };

  const addFAQ = () => {
    setData({ ...data, faqs: [...data.faqs, { question: "", answer: "" }] });
  };

  const removeFAQ = (index: number) => {
    const newFAQs = data.faqs.filter((_, i) => i !== index);
    setData({ ...data, faqs: newFAQs });
  };

  if (loading) {
    return <div>Loading...</div>;
  }

  return (
    <div className="max-w-4xl mx-auto space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-3xl font-bold">Edit FAQ Page</h1>
        <Button onClick={handleSave} disabled={saving}>
          {saving ? "Saving..." : "Save Changes"}
        </Button>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Section Header</CardTitle>
          <CardDescription>Title and subtitle for the FAQ section</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div>
            <Label htmlFor="title">Section Title</Label>
            <Input
              id="title"
              value={data.title}
              onChange={(e) => setData({ ...data, title: e.target.value })}
            />
          </div>
          <div>
            <Label htmlFor="subtitle">Section Subtitle</Label>
            <Textarea
              id="subtitle"
              value={data.subtitle}
              onChange={(e) => setData({ ...data, subtitle: e.target.value })}
            />
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Frequently Asked Questions</CardTitle>
          <CardDescription>Edit the questions and answers</CardDescription>
        </CardHeader>
        <CardContent className="space-y-6">
          {data.faqs.map((faq, index) => (
            <div key={index} className="border p-4 rounded-lg space-y-3">
              <div className="flex items-center justify-between">
                <h4 className="font-semibold">FAQ {index + 1}</h4>
                {data.faqs.length > 1 && (
                  <Button
                    type="button"
                    variant="destructive"
                    size="sm"
                    onClick={() => removeFAQ(index)}
                  >
                    Remove
                  </Button>
                )}
              </div>
              <div>
                <Label htmlFor={`faq-${index}-question`}>Question</Label>
                <Input
                  id={`faq-${index}-question`}
                  value={faq.question}
                  onChange={(e) => updateFAQ(index, "question", e.target.value)}
                  placeholder="Enter the question"
                />
              </div>
              <div>
                <Label htmlFor={`faq-${index}-answer`}>Answer</Label>
                <Textarea
                  id={`faq-${index}-answer`}
                  value={faq.answer}
                  onChange={(e) => updateFAQ(index, "answer", e.target.value)}
                  placeholder="Enter the answer"
                  rows={3}
                />
              </div>
            </div>
          ))}
          
          <Button type="button" variant="outline" onClick={addFAQ} className="w-full">
            Add New FAQ
          </Button>
        </CardContent>
      </Card>

      <div className="flex justify-end">
        <Button onClick={handleSave} disabled={saving} size="lg">
          {saving ? "Saving..." : "Save All Changes"}
        </Button>
      </div>
    </div>
  );
}
