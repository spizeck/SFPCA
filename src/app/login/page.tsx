"use client";

import { useState, useEffect } from "react";
import { signInWithPopup, GoogleAuthProvider, signInWithEmailAndPassword } from "firebase/auth";
import { auth } from "@/lib/firebase";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { useRouter } from "next/navigation";
import { useToast } from "@/hooks/use-toast";

export default function LoginPage() {
  const [loading, setLoading] = useState(false);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [mounted, setMounted] = useState(false);
  const router = useRouter();
  const { toast } = useToast();

  // Prevent hydration mismatch
  useEffect(() => {
    setMounted(true);
  }, []);

  // Don't render until mounted to prevent hydration mismatch
  if (!mounted) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gray-50 px-4">
        <div className="w-full max-w-md">
          <div className="h-32 bg-gray-200 rounded-lg animate-pulse"></div>
        </div>
      </div>
    );
  }

  const handleGoogleSignIn = async () => {
    setLoading(true);
    try {
      const provider = new GoogleAuthProvider();
      const result = await signInWithPopup(auth, provider);
      
      const idToken = await result.user.getIdToken();
      
      const response = await fetch("/api/auth/session", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ idToken }),
      });

      if (response.ok) {
        const data = await response.json();
        if (data.authorized) {
          router.push("/admin");
        } else {
          toast({
            title: "Access Denied",
            description: "You are not authorized to access the admin area.",
            variant: "destructive",
          });
          await auth.signOut();
        }
      } else {
        throw new Error("Failed to create session");
      }
    } catch (error) {
      console.error("Login error:", error);
      toast({
        title: "Login Failed",
        description: "An error occurred during login. Please try again.",
        variant: "destructive",
      });
    } finally {
      setLoading(false);
    }
  };

  const handleEmailSignIn = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    try {
      const result = await signInWithEmailAndPassword(auth, email, password);
      
      const idToken = await result.user.getIdToken();
      
      const response = await fetch("/api/auth/session", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ idToken }),
      });

      if (response.ok) {
        const data = await response.json();
        if (data.authorized) {
          router.push("/admin");
        } else {
          toast({
            title: "Access Denied",
            description: "You are not authorized to access the admin area.",
            variant: "destructive",
          });
          await auth.signOut();
        }
      } else {
        throw new Error("Failed to create session");
      }
    } catch (error: any) {
      console.error("Login error:", error);
      toast({
        title: "Login Failed",
        description: error.code === 'auth/user-not-found' 
          ? "No account found with this email."
          : error.code === 'auth/wrong-password'
          ? "Incorrect password."
          : "An error occurred during login. Please try again.",
        variant: "destructive",
      });
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center bg-gray-50 px-4">
      <Card className="w-full max-w-md">
        <CardHeader className="text-center">
          <CardTitle className="text-2xl">SFPCA Admin</CardTitle>
          <CardDescription>Sign in to access the admin dashboard</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <form onSubmit={handleEmailSignIn} className="space-y-3">
            <div className="space-y-1">
              <Label htmlFor="email">Email</Label>
              <Input
                id="email"
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="Enter your email"
                required
                disabled={loading}
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="password">Password</Label>
              <Input
                id="password"
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="Enter your password"
                required
                disabled={loading}
              />
            </div>
            <Button
              type="submit"
              disabled={loading}
              className="w-full"
              size="lg"
            >
              {loading ? "Signing in..." : "Sign in"}
            </Button>
          </form>
          
          <div className="relative">
            <div className="absolute inset-0 flex items-center">
              <span className="w-full border-t" />
            </div>
            <div className="relative flex justify-center text-xs uppercase">
              <span className="bg-background px-2 text-muted-foreground">
                Or continue with
              </span>
            </div>
          </div>
          
          <Button
            onClick={handleGoogleSignIn}
            disabled={loading}
            className="w-full"
            variant="outline"
            size="lg"
          >
            {loading ? "Signing in..." : "Sign in with Google"}
          </Button>
        </CardContent>
      </Card>
    </div>
  );
}
