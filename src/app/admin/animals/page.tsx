"use client";

import { useState, useEffect } from "react";
import { collection, getDocs, addDoc, updateDoc, deleteDoc, doc } from "firebase/firestore";
import { db } from "@/lib/firebase";
import { Animal } from "@/lib/types";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useToast } from "@/hooks/use-toast";
import { Plus, Pencil, Trash2 } from "lucide-react";

export default function AnimalsManager() {
  const [animals, setAnimals] = useState<Animal[]>([]);
  const [loading, setLoading] = useState(true);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editingAnimal, setEditingAnimal] = useState<Animal | null>(null);
  const { toast } = useToast();

  const [formData, setFormData] = useState({
    name: "",
    species: "dog" as "dog" | "cat" | "other",
    sex: "unknown" as "male" | "female" | "unknown",
    approxAge: "",
    description: "",
    status: "available" as "available" | "pending" | "adopted",
    photos: [] as string[],
  });

  useEffect(() => {
    loadAnimals();
  }, []);

  const loadAnimals = async () => {
    try {
      const querySnapshot = await getDocs(collection(db, "animals"));
      const animalsData = querySnapshot.docs.map((doc) => ({
        id: doc.id,
        ...doc.data(),
      })) as Animal[];
      setAnimals(animalsData);
    } catch (error) {
      console.error("Error loading animals:", error);
      toast({
        title: "Error",
        description: "Failed to load animals",
        variant: "destructive",
      });
    } finally {
      setLoading(false);
    }
  };

  const handleSubmit = async () => {
    try {
      if (editingAnimal) {
        const docRef = doc(db, "animals", editingAnimal.id);
        await updateDoc(docRef, {
          ...formData,
          updatedAt: new Date(),
        });
        toast({ title: "Success", description: "Animal updated successfully" });
      } else {
        await addDoc(collection(db, "animals"), {
          ...formData,
          createdAt: new Date(),
          updatedAt: new Date(),
        });
        toast({ title: "Success", description: "Animal added successfully" });
      }
      
      setDialogOpen(false);
      resetForm();
      loadAnimals();
    } catch (error) {
      console.error("Error saving animal:", error);
      toast({
        title: "Error",
        description: "Failed to save animal",
        variant: "destructive",
      });
    }
  };

  const handleEdit = (animal: Animal) => {
    setEditingAnimal(animal);
    setFormData({
      name: animal.name,
      species: animal.species,
      sex: animal.sex,
      approxAge: animal.approxAge,
      description: animal.description,
      status: animal.status,
      photos: animal.photos || [],
    });
    setDialogOpen(true);
  };

  const handleDelete = async (id: string) => {
    if (!confirm("Are you sure you want to delete this animal?")) return;
    
    try {
      await deleteDoc(doc(db, "animals", id));
      toast({ title: "Success", description: "Animal deleted successfully" });
      loadAnimals();
    } catch (error) {
      console.error("Error deleting animal:", error);
      toast({
        title: "Error",
        description: "Failed to delete animal",
        variant: "destructive",
      });
    }
  };

  const resetForm = () => {
    setEditingAnimal(null);
    setFormData({
      name: "",
      species: "dog",
      sex: "unknown",
      approxAge: "",
      description: "",
      status: "available",
      photos: [],
    });
  };

  if (loading) {
    return <div>Loading...</div>;
  }

  return (
    <div className="max-w-6xl mx-auto">
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-3xl font-bold">Manage Animals</h1>
        <Dialog open={dialogOpen} onOpenChange={(open) => {
          setDialogOpen(open);
          if (!open) resetForm();
        }}>
          <DialogTrigger asChild>
            <Button>
              <Plus className="h-4 w-4 mr-2" />
              Add Animal
            </Button>
          </DialogTrigger>
          <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
            <DialogHeader>
              <DialogTitle>{editingAnimal ? "Edit Animal" : "Add New Animal"}</DialogTitle>
              <DialogDescription>
                {editingAnimal ? "Update animal information" : "Add a new animal to the adoption list"}
              </DialogDescription>
            </DialogHeader>
            <div className="space-y-4 py-4">
              <div>
                <Label htmlFor="name">Name</Label>
                <Input
                  id="name"
                  value={formData.name}
                  onChange={(e) => setFormData({ ...formData, name: e.target.value })}
                />
              </div>
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <Label htmlFor="species">Species</Label>
                  <Select value={formData.species} onValueChange={(value: any) => setFormData({ ...formData, species: value })}>
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="dog">Dog</SelectItem>
                      <SelectItem value="cat">Cat</SelectItem>
                      <SelectItem value="other">Other</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div>
                  <Label htmlFor="sex">Sex</Label>
                  <Select value={formData.sex} onValueChange={(value: any) => setFormData({ ...formData, sex: value })}>
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="male">Male</SelectItem>
                      <SelectItem value="female">Female</SelectItem>
                      <SelectItem value="unknown">Unknown</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              </div>
              <div>
                <Label htmlFor="age">Approximate Age</Label>
                <Input
                  id="age"
                  value={formData.approxAge}
                  onChange={(e) => setFormData({ ...formData, approxAge: e.target.value })}
                  placeholder="e.g., 2 years, 6 months"
                />
              </div>
              <div>
                <Label htmlFor="description">Description</Label>
                <Textarea
                  id="description"
                  rows={4}
                  value={formData.description}
                  onChange={(e) => setFormData({ ...formData, description: e.target.value })}
                />
              </div>
              <div>
                <Label htmlFor="status">Status</Label>
                <Select value={formData.status} onValueChange={(value: any) => setFormData({ ...formData, status: value })}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="available">Available</SelectItem>
                    <SelectItem value="pending">Pending</SelectItem>
                    <SelectItem value="adopted">Adopted</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div>
                <Label htmlFor="photos">Photo URL (optional)</Label>
                <Input
                  id="photos"
                  value={formData.photos[0] || ""}
                  onChange={(e) => setFormData({ ...formData, photos: e.target.value ? [e.target.value] : [] })}
                  placeholder="https://example.com/photo.jpg"
                />
                <p className="text-xs text-gray-500 mt-1">
                  TODO: Add Firebase Storage integration for photo uploads
                </p>
              </div>
              <Button onClick={handleSubmit} className="w-full">
                {editingAnimal ? "Update Animal" : "Add Animal"}
              </Button>
            </div>
          </DialogContent>
        </Dialog>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Animals List</CardTitle>
          <CardDescription>Manage all animals in the system</CardDescription>
        </CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Name</TableHead>
                <TableHead>Species</TableHead>
                <TableHead>Sex</TableHead>
                <TableHead>Age</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {animals.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={6} className="text-center text-gray-500">
                    No animals found. Add your first animal!
                  </TableCell>
                </TableRow>
              ) : (
                animals.map((animal) => (
                  <TableRow key={animal.id}>
                    <TableCell className="font-medium">{animal.name}</TableCell>
                    <TableCell className="capitalize">{animal.species}</TableCell>
                    <TableCell className="capitalize">{animal.sex}</TableCell>
                    <TableCell>{animal.approxAge}</TableCell>
                    <TableCell>
                      <span className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium ${
                        animal.status === "available" ? "bg-green-100 text-green-800" :
                        animal.status === "pending" ? "bg-yellow-100 text-yellow-800" :
                        "bg-gray-100 text-gray-800"
                      }`}>
                        {animal.status}
                      </span>
                    </TableCell>
                    <TableCell className="text-right space-x-2">
                      <Button variant="ghost" size="sm" onClick={() => handleEdit(animal)}>
                        <Pencil className="h-4 w-4" />
                      </Button>
                      <Button variant="ghost" size="sm" onClick={() => handleDelete(animal.id)}>
                        <Trash2 className="h-4 w-4 text-red-500" />
                      </Button>
                    </TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </div>
  );
}
