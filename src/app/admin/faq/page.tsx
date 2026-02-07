"use client";

import { useState, useEffect, useCallback } from "react";
import { collection, getDocs, addDoc, updateDoc, deleteDoc, doc } from "firebase/firestore";
import { db } from "@/lib/firebase";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useToast } from "@/hooks/use-toast";
import { Plus, Pencil, Trash2, GripVertical } from "lucide-react";

interface FAQ {
  id: string;
  category: string;
  question: string;
  answer: string;
  order: number;
  createdAt: string;
  updatedAt: string;
}

const CATEGORIES = [
  "Registration Fees",
  "Getting Animals to SABA", 
  "Getting Animals from SABA",
  "Veterinary Services",
  "Adoption Process",
  "General",
  "Other"
];

export default function FAQManager() {
  const [faqs, setFaqs] = useState<FAQ[]>([]);
  const [loading, setLoading] = useState(true);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editingFaq, setEditingFaq] = useState<FAQ | null>(null);
  const { toast } = useToast();

  const [formData, setFormData] = useState({
    category: "",
    question: "",
    answer: "",
    order: "0",
  });

  const loadFaqs = useCallback(async () => {
    try {
      const querySnapshot = await getDocs(collection(db, "faq"));
      
      const faqsData: FAQ[] = [];
      
      querySnapshot.forEach((docSnap) => {
        const data = docSnap.data();
        
        if (!data.category || !data.question || !data.answer) {
          return;
        }
        
        faqsData.push({
          id: docSnap.id,
          category: data.category,
          question: data.question,
          answer: data.answer,
          order: typeof data.order === 'number' ? data.order : parseInt(data.order, 10) || 0,
          createdAt: data.createdAt?.toDate?.()?.toISOString() || new Date().toISOString(),
          updatedAt: data.updatedAt?.toDate?.()?.toISOString() || new Date().toISOString(),
        });
      });
      
      faqsData.sort((a, b) => {
        if (a.category !== b.category) {
          return a.category.localeCompare(b.category);
        }
        return a.order - b.order;
      });
      
      setFaqs(faqsData);
    } catch (error) {
      console.error("Error loading FAQs:", error);
      toast({
        title: "Error",
        description: `Failed to load FAQs: ${error instanceof Error ? error.message : 'Unknown error'}`,
        variant: "destructive",
      });
    } finally {
      setLoading(false);
    }
  }, [toast]);

  useEffect(() => {
    loadFaqs();
  }, [loadFaqs]);

  const handleSubmit = async () => {
    try {
      // Validate form data
      if (!formData.category || !formData.question || !formData.answer) {
        toast({
          title: "Validation Error",
          description: "Please fill in all required fields",
          variant: "destructive",
        });
        return;
      }

      const submitData = {
        category: formData.category,
        question: formData.question,
        answer: formData.answer,
        order: parseInt(formData.order, 10) || 0,
      };

      if (editingFaq) {
        const docRef = doc(db, "faq", editingFaq.id);
        await updateDoc(docRef, {
          ...submitData,
          updatedAt: new Date(),
        });
        toast({ title: "Success", description: "FAQ updated successfully" });
      } else {
        await addDoc(collection(db, "faq"), {
          ...submitData,
          order: faqs.filter(f => f.category === formData.category).length,
          createdAt: new Date(),
          updatedAt: new Date(),
        });
        toast({ title: "Success", description: "FAQ added successfully" });
      }
      
      setDialogOpen(false);
      resetForm();
      
      // Reload FAQs after a short delay to ensure Firestore has updated
      setTimeout(() => {
        loadFaqs();
      }, 500);
    } catch (error) {
      console.error("Error saving FAQ:", error);
      toast({
        title: "Error",
        description: `Failed to save FAQ: ${error instanceof Error ? error.message : 'Unknown error'}`,
        variant: "destructive",
      });
    }
  };

  const handleEdit = (faq: FAQ) => {
    setEditingFaq(faq);
    setFormData({
      category: faq.category,
      question: faq.question,
      answer: faq.answer,
      order: faq.order.toString(),
    });
    setDialogOpen(true);
  };

  const handleDelete = async (id: string) => {
    if (!confirm("Are you sure you want to delete this FAQ?")) return;
    
    try {
      await deleteDoc(doc(db, "faq", id));
      toast({ title: "Success", description: "FAQ deleted successfully" });
      loadFaqs();
    } catch (error) {
      console.error("Error deleting FAQ:", error);
      toast({
        title: "Error",
        description: "Failed to delete FAQ",
        variant: "destructive",
      });
    }
  };

  const resetForm = () => {
    setEditingFaq(null);
    setFormData({
      category: "",
      question: "",
      answer: "",
      order: "0",
    });
  };

  const groupedFaqs = faqs.reduce((acc, faq) => {
    if (!acc[faq.category]) {
      acc[faq.category] = [];
    }
    acc[faq.category].push(faq);
    return acc;
  }, {} as Record<string, FAQ[]>);

  if (loading) {
    return <div className="p-8">Loading...</div>;
  }

  return (
    <div className="max-w-6xl mx-auto">
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-3xl font-bold">Manage FAQs</h1>
        <Dialog open={dialogOpen} onOpenChange={(open) => {
          setDialogOpen(open);
          if (!open) resetForm();
        }}>
          <DialogTrigger asChild>
            <Button>
              <Plus className="h-4 w-4 mr-2" />
              Add FAQ
            </Button>
          </DialogTrigger>
          <DialogContent className="max-w-2xl">
            <DialogHeader>
              <DialogTitle>{editingFaq ? "Edit FAQ" : "Add New FAQ"}</DialogTitle>
              <DialogDescription>
                {editingFaq ? "Update FAQ information" : "Add a new frequently asked question"}
              </DialogDescription>
            </DialogHeader>
            <div className="space-y-4 py-4">
              <div>
                <Label htmlFor="category">Category</Label>
                <Select value={formData.category} onValueChange={(value) => setFormData({ ...formData, category: value })}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {CATEGORIES.map((category) => (
                      <SelectItem key={category} value={category}>
                        {category}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div>
                <Label htmlFor="question">Question</Label>
                <Input
                  id="question"
                  value={formData.question}
                  onChange={(e) => setFormData({ ...formData, question: e.target.value })}
                  placeholder="Enter the question"
                />
              </div>
              <div>
                <Label htmlFor="answer">Answer</Label>
                <Textarea
                  id="answer"
                  rows={4}
                  value={formData.answer}
                  onChange={(e) => setFormData({ ...formData, answer: e.target.value })}
                  placeholder="Enter the answer"
                />
              </div>
              <Button onClick={handleSubmit} className="w-full">
                {editingFaq ? "Update FAQ" : "Add FAQ"}
              </Button>
            </div>
          </DialogContent>
        </Dialog>
      </div>

      <div className="space-y-8">
        {Object.entries(groupedFaqs).map(([category, categoryFaqs]) => (
          <Card key={category}>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <GripVertical className="h-5 w-5" />
                {category}
                <span className="text-sm text-muted-foreground">({categoryFaqs.length})</span>
              </CardTitle>
            </CardHeader>
            <CardContent>
              <div className="space-y-4">
                {categoryFaqs.map((faq) => (
                  <div key={faq.id} className="border rounded-lg p-4">
                    <div className="flex items-start justify-between">
                      <div className="flex-1">
                        <h4 className="font-medium mb-2">{faq.question}</h4>
                        <p className="text-sm text-muted-foreground whitespace-pre-wrap">{faq.answer}</p>
                      </div>
                      <div className="flex gap-2 ml-4">
                        <Button variant="ghost" size="sm" onClick={() => handleEdit(faq)}>
                          <Pencil className="h-4 w-4" />
                        </Button>
                        <Button variant="ghost" size="sm" onClick={() => handleDelete(faq.id)}>
                          <Trash2 className="h-4 w-4 text-red-500" />
                        </Button>
                      </div>
                    </div>
                  </div>
                ))}
                {categoryFaqs.length === 0 && (
                  <p className="text-muted-foreground text-center py-4">
                    No FAQs in this category yet.
                  </p>
                )}
              </div>
            </CardContent>
          </Card>
        ))}
      </div>

      {faqs.length === 0 && (
        <Card>
          <CardContent className="pt-6">
            <div className="text-center text-muted-foreground">
              <p>No FAQs yet.</p>
              <Button onClick={() => setDialogOpen(true)} variant="outline" className="mt-2">
                Add your first FAQ
              </Button>
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
