"use client";

// "I think I've seen this animal" form on the public lost-pets page
// (#176). Submits to a case update, not a messaging channel — the
// reporter's contact details go only to staff inside the case record.
// Never reveals anything about the owner.

import { useState } from "react";
import { submitSightingAction } from "@/app/lost-pets/actions";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";

export function SightingForm({ caseId }: { caseId: string }) {
  const [open, setOpen] = useState(false);
  const [location, setLocation] = useState("");
  const [note, setNote] = useState("");
  const [name, setName] = useState("");
  const [contact, setContact] = useState("");
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState(false);

  if (sent) {
    return (
      <p className="text-sm text-green-700 dark:text-green-400 font-medium">
        Thank you — your report has been sent to SFPCA.
      </p>
    );
  }

  if (!open) {
    return (
      <Button variant="outline" size="sm" onClick={() => setOpen(true)}>
        I&apos;ve seen this animal
      </Button>
    );
  }

  return (
    <form
      className="space-y-2 border-t pt-3 mt-3"
      onSubmit={async (e) => {
        e.preventDefault();
        setBusy(true);
        setError(false);
        const r = await submitSightingAction({
          caseId,
          location: location || null,
          note: note || null,
          reporterName: name || null,
          reporterContact: contact || null,
        });
        setBusy(false);
        if (r.ok) setSent(true);
        else setError(true);
      }}
    >
      <div className="space-y-1">
        <Label htmlFor={`sighting-where-${caseId}`}>Where did you see it?</Label>
        <Input
          id={`sighting-where-${caseId}`}
          value={location}
          onChange={(e) => setLocation(e.target.value)}
          placeholder="e.g. Windwardside, near the trails"
        />
      </div>
      <div className="space-y-1">
        <Label htmlFor={`sighting-note-${caseId}`}>Anything else? (optional)</Label>
        <Textarea
          id={`sighting-note-${caseId}`}
          value={note}
          onChange={(e) => setNote(e.target.value)}
          rows={2}
          placeholder="When, condition, direction headed…"
        />
      </div>
      <div className="grid gap-2 sm:grid-cols-2">
        <div className="space-y-1">
          <Label htmlFor={`sighting-name-${caseId}`}>Your name (optional)</Label>
          <Input
            id={`sighting-name-${caseId}`}
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
        </div>
        <div className="space-y-1">
          <Label htmlFor={`sighting-contact-${caseId}`}>
            How can SFPCA reach you? (optional)
          </Label>
          <Input
            id={`sighting-contact-${caseId}`}
            value={contact}
            onChange={(e) => setContact(e.target.value)}
            placeholder="Phone or email"
          />
        </div>
      </div>
      {error && (
        <p className="text-sm text-destructive">
          Something went wrong — please try again or contact SFPCA directly.
        </p>
      )}
      <Button type="submit" size="sm" disabled={busy}>
        {busy ? "Sending…" : "Send report"}
      </Button>
    </form>
  );
}
