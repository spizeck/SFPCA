"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { LogOut } from "lucide-react";

export function PortalSignOut() {
  const router = useRouter();
  const [signingOut, setSigningOut] = useState(false);

  const handleSignOut = async () => {
    if (signingOut) return;
    setSigningOut(true);
    try {
      await fetch("/api/auth/session", { method: "DELETE" });
      router.push("/login");
    } finally {
      setSigningOut(false);
    }
  };

  return (
    <Button variant="outline" size="sm" onClick={handleSignOut} disabled={signingOut}>
      <LogOut className="h-4 w-4 mr-2" />
      Sign out
    </Button>
  );
}
