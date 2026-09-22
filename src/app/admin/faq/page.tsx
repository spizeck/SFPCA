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
import { useMutation } from "@/hooks/use-mutation";
import { Plus, Pencil, Trash, GripVertical } from "lucide-react";
import { logError } from "@/lib/logger";
import { ConfirmDialog } from "@/components/admin/confirm-dialog";
import { LoadError } from "@/components/admin/load-error";

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

const EMPTY_FORM = { category: "", question: "", answer: "", order: "0" };

export default function FAQManager() {
  const [faqs, setFaqs] = useState<FAQ[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editingFaq, setEditingFaq] = useState<FAQ | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<FAQ | null>(null);
  const [fieldErrors, setFieldErrors] = useState<{
    category?: string;
    question?: string;
    answer?: string;
  }>({});
  const [initialFormJson, setInitialFormJson] = useState(() =>
    JSON.stringify(EMPTY_FORM),
  );
  const mutation = useMutation();
  const { toast } = useToast();

  const [formData, setFormData] = useState({ ...EMPTY_FORM });

  const loadFaqs = useCallback(async () => {
    setLoading(true);
    setLoadError(false);
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
      logError("admin", "faq-load", error);
      setLoadError(true);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadFaqs();
  }, [loadFaqs]);

  const handleSubmit = () => {
    // Field-level validation: name each missing field and keep the
    // dialog open so entered data is preserved.
    const errors: typeof fieldErrors = {};
    if (!formData.category) errors.category = "Choose a category.";
    if (!formData.question.trim()) errors.question = "Enter a question.";
    if (!formData.answer.trim()) errors.answer = "Enter an answer.";
    if (Object.keys(errors).length > 0) {
      setFieldErrors(errors);
      return;
    }

    mutation.run(async () => {
      const submitData = {
        category: formData.category,
        question: formData.question,
        answer: formData.answer,
        order: parseInt(formData.order, 10) || 0,
      };

      try {
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
            order: faqs.filter((f) => f.category === formData.category).length,
            createdAt: new Date(),
            updatedAt: new Date(),
          });
          toast({ title: "Success", description: "FAQ added successfully" });
        }

        setDialogOpen(false);
        resetForm();
        loadFaqs();
      } catch (error) {
        logError("admin", "faq-save", error);
        toast({
          title: "Error",
          description:
            "Failed to save FAQ. Your entries are kept — try again.",
          variant: "destructive",
        });
      }
    });
  };

  const handleEdit = (faq: FAQ) => {
    setEditingFaq(faq);
    const editForm = {
      category: faq.category,
      question: faq.question,
      answer: faq.answer,
      order: faq.order.toString(),
    };
    setFormData(editForm);
    setInitialFormJson(JSON.stringify(editForm));
    setFieldErrors({});
    setDialogOpen(true);
  };

  const handleDelete = () => {
    const target = deleteTarget;
    if (!target) return;
    mutation.run(async () => {
      try {
        await deleteDoc(doc(db, "faq", target.id));
        setDeleteTarget(null);
        toast({ title: "Success", description: "FAQ deleted successfully" });
        loadFaqs();
      } catch (error) {
        logError("admin", "faq-delete", error);
        toast({
          title: "Error",
          description: "Failed to delete FAQ. Try again.",
          variant: "destructive",
        });
      }
    });
  };

  const formDirty = JSON.stringify(formData) !== initialFormJson;

  const resetForm = () => {
    setEditingFaq(null);
    setFieldErrors({});
    setFormData({ ...EMPTY_FORM });
    setInitialFormJson(JSON.stringify(EMPTY_FORM));
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

  if (loadError) {
    return <LoadError label="FAQs" onRetry={loadFaqs} />;
  }

  const closeDialog = (open: boolean) => {
    if (open) {
      setDialogOpen(true);
      return;
    }
    if (formDirty && !window.confirm("Discard unsaved changes to this FAQ?")) {
      return;
    }
    setDialogOpen(false);
    resetForm();
  };

  return (
    <div className="max-w-6xl mx-auto">
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-3xl font-bold">Manage FAQs</h1>
        <Dialog open={dialogOpen} onOpenChange={closeDialog}>
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
                <Select
                  value={formData.category}
                  onValueChange={(value) => {
                    setFormData({ ...formData, category: value });
                    setFieldErrors((prev) => ({ ...prev, category: undefined }));
                  }}
                >
                  <SelectTrigger
                    id="category"
                    aria-invalid={!!fieldErrors.category}
                    aria-describedby={fieldErrors.category ? "category-error" : undefined}
                  >
                    <SelectValue placeholder="Choose a category" />
                  </SelectTrigger>
                  <SelectContent>
                    {CATEGORIES.map((category) => (
                      <SelectItem key={category} value={category}>
                        {category}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                {fieldErrors.category && (
                  <p id="category-error" role="alert" className="text-xs text-red-600 mt-1">
                    {fieldErrors.category}
                  </p>
                )}
              </div>
              <div>
                <Label htmlFor="question">Question</Label>
                <Input
                  id="question"
                  value={formData.question}
                  onChange={(e) => {
                    setFormData({ ...formData, question: e.target.value });
                    setFieldErrors((prev) => ({ ...prev, question: undefined }));
                  }}
                  placeholder="Enter the question"
                  aria-invalid={!!fieldErrors.question}
                  aria-describedby={fieldErrors.question ? "question-error" : undefined}
                />
                {fieldErrors.question && (
                  <p id="question-error" role="alert" className="text-xs text-red-600 mt-1">
                    {fieldErrors.question}
                  </p>
                )}
              </div>
              <div>
                <Label htmlFor="answer">Answer</Label>
                <Textarea
                  id="answer"
                  rows={4}
                  value={formData.answer}
                  onChange={(e) => {
                    setFormData({ ...formData, answer: e.target.value });
                    setFieldErrors((prev) => ({ ...prev, answer: undefined }));
                  }}
                  placeholder="Enter the answer"
                  aria-invalid={!!fieldErrors.answer}
                  aria-describedby={fieldErrors.answer ? "answer-error" : undefined}
                />
                {fieldErrors.answer && (
                  <p id="answer-error" role="alert" className="text-xs text-red-600 mt-1">
                    {fieldErrors.answer}
                  </p>
                )}
              </div>
              <Button onClick={handleSubmit} className="w-full" disabled={mutation.pending}>
                {mutation.pending ? "Saving…" : editingFaq ? "Update FAQ" : "Add FAQ"}
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
                        <Button
                          variant="ghost"
                          size="sm"
                          aria-label={`Edit FAQ: ${faq.question}`}
                          onClick={() => handleEdit(faq)}
                        >
                          <Pencil className="h-4 w-4" />
                        </Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          aria-label={`Delete FAQ: ${faq.question}`}
                          onClick={() => setDeleteTarget(faq)}
                        >
                          <Trash className="h-4 w-4 text-red-500" />
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

      <ConfirmDialog
        open={deleteTarget !== null}
        title="Delete FAQ"
        description={
          deleteTarget ? (
            <>
              Permanently delete the FAQ{" "}
              <strong>&ldquo;{deleteTarget.question}&rdquo;</strong>? This
              cannot be undone.
            </>
          ) : null
        }
        pending={mutation.pending}
        onConfirm={handleDelete}
        onCancel={() => setDeleteTarget(null)}
      />
    </div>
  );
}
