"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Upload, X, Plus } from "lucide-react";

interface TeamMember {
  id?: string;
  name: string;
  role: string;
  bio: string;
  photo?: string;
}

interface TeamManagerProps {
  team: TeamMember[];
  onChange: (team: TeamMember[]) => void;
}

export function TeamManager({ team, onChange }: TeamManagerProps) {
  const [uploadingId, setUploadingId] = useState<string | null>(null);

  const addMember = () => {
    const newMember: TeamMember = {
      id: Date.now().toString(),
      name: "",
      role: "",
      bio: "",
      photo: "",
    };
    onChange([...team, newMember]);
  };

  const updateMember = (index: number, updates: Partial<TeamMember>) => {
    const newTeam = [...team];
    const member = newTeam[index];
    if (!member.id) {
      member.id = Date.now().toString();
    }
    newTeam[index] = { ...member, ...updates };
    onChange(newTeam);
  };

  const removeMember = (index: number) => {
    onChange(team.filter((_, i) => i !== index));
  };

  const handlePhotoUpload = async (index: number, file: File) => {
    // TODO: Implement Firebase Storage upload
    // For now, just create a local URL
    const url = URL.createObjectURL(file);
    updateMember(index, { photo: url });
  };

  return (
    <div className="space-y-4">
      <div className="flex justify-between items-center">
        <h4 className="font-semibold">Team Members</h4>
        <Button onClick={addMember} size="sm">
          <Plus className="h-4 w-4 mr-2" />
          Add Member
        </Button>
      </div>

      {team.map((member, index) => (
        <Card key={index}>
          <CardHeader className="flex flex-row items-center justify-between">
            <CardTitle className="text-lg">Team Member {index + 1}</CardTitle>
            {team.length > 1 && (
              <Button
                variant="ghost"
                size="sm"
                onClick={() => removeMember(index)}
              >
                <X className="h-4 w-4" />
              </Button>
            )}
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid md:grid-cols-2 gap-4">
              <div>
                <Label htmlFor={`name-${index}`}>Name</Label>
                <Input
                  id={`name-${index}`}
                  value={member.name}
                  onChange={(e) => updateMember(index, { name: e.target.value })}
                  placeholder="Enter name"
                />
              </div>
              <div>
                <Label htmlFor={`role-${index}`}>Role/Title</Label>
                <Input
                  id={`role-${index}`}
                  value={member.role}
                  onChange={(e) => updateMember(index, { role: e.target.value })}
                  placeholder="Enter role or title"
                />
              </div>
            </div>
            
            <div>
              <Label htmlFor={`bio-${index}`}>Biography</Label>
              <Textarea
                id={`bio-${index}`}
                rows={3}
                value={member.bio}
                onChange={(e) => updateMember(index, { bio: e.target.value })}
                placeholder="Enter biography"
              />
            </div>

            <div>
              <Label>Photo</Label>
              <div className="mt-2 flex items-center gap-4">
                {member.photo ? (
                  <div className="relative">
                    <img
                      src={member.photo}
                      alt={member.name}
                      className="w-20 h-20 rounded-full object-cover"
                    />
                    <Button
                      variant="destructive"
                      size="sm"
                      className="absolute -top-2 -right-2 h-6 w-6 rounded-full p-0"
                      onClick={() => updateMember(index, { photo: undefined })}
                    >
                      <X className="h-3 w-3" />
                    </Button>
                  </div>
                ) : (
                  <div className="w-20 h-20 rounded-full bg-muted flex items-center justify-center">
                    <span className="text-2xl text-muted-foreground">
                      {member.name.split(' ').map(n => n[0]).join('') || '?'}
                    </span>
                  </div>
                )}
                <div>
                  <Input
                    type="file"
                    accept="image/*"
                    onChange={(e) => {
                      const file = e.target.files?.[0];
                      if (file) {
                        handlePhotoUpload(index, file);
                      }
                    }}
                    className="hidden"
                    id={`photo-${index}`}
                  />
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => document.getElementById(`photo-${index}`)?.click()}
                  >
                    <Upload className="h-4 w-4 mr-2" />
                    Upload Photo
                  </Button>
                  <p className="text-xs text-muted-foreground mt-1">
                    JPG, PNG or GIF. Max 5MB.
                  </p>
                </div>
              </div>
            </div>
          </CardContent>
        </Card>
      ))}

      {team.length === 0 && (
        <Card>
          <CardContent className="pt-6">
            <div className="text-center text-muted-foreground">
              <p>No team members yet.</p>
              <Button onClick={addMember} variant="outline" className="mt-2">
                Add your first team member
              </Button>
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
