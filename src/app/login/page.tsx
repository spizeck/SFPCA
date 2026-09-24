"use client";

import { useState, useEffect } from "react";
import { signInWithPopup, GoogleAuthProvider, signInWithEmailAndPassword, createUserWithEmailAndPassword, sendPasswordResetEmail } from "firebase/auth";
import { auth } from "@/lib/firebase";
import { logError, logWarn } from "@/lib/logger";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardDescription, CardHeader } from "@/components/ui/card";
import { useRouter } from "next/navigation";
import { useToast } from "@/hooks/use-toast";
import { ThemeToggle } from "@/components/theme-toggle";

export default function LoginPage() {
  const [loading, setLoading] = useState(false);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [mounted, setMounted] = useState(false);
  const [isSignIn, setIsSignIn] = useState(true);
  const router = useRouter();
  const { toast } = useToast();

  // Expected auth outcomes (wrong password, popup closed, duplicate
  // email, ...) are user-facing and handled by toasts — they are not
  // operational incidents. Only non-auth failures (network, internal
  // SDK errors) warrant error-level logging.
  const logAuthFailure = (operation: string, error: unknown) => {
    const code = (error as { code?: unknown })?.code;
    if (typeof code === "string" && code.startsWith("auth/")) {
      logWarn("auth", operation, "authentication rejected", {
        errorCode: code,
      });
    } else {
      logError("auth", operation, error);
    }
  };

  // Prevent hydration mismatch
  useEffect(() => {
    setMounted(true);
  }, []);

  // Don't render until mounted to prevent hydration mismatch
  if (!mounted) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background px-4">
        <div className="w-full max-w-md">
          <div className="h-32 bg-muted rounded-lg animate-pulse"></div>
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

      const data = await response.json().catch(() => null);

      if (response.ok && data?.authorized) {
        // The session route set the admin custom claim; refresh the ID
        // token so rules-evaluated client writes (CMS, team photos)
        // carry it immediately.
        await result.user.getIdToken(true);
        // Staff land on /admin; owners land on the owner portal. The
        // session route decides — the login page never guesses.
        router.push(data.isAdmin ? "/admin" : "/portal");
      } else if (response.status === 403) {
        toast({
          title: "Access Denied",
          description: "This account is not authorized. Please contact the site administrator.",
          variant: "destructive",
        });
        await auth.signOut();
      } else {
        throw new Error("Failed to create session");
      }
    } catch (error) {
      logAuthFailure("google-sign-in", error);
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

      const data = await response.json().catch(() => null);

      if (response.ok && data?.authorized) {
        // See handleGoogleSignIn: pick up the admin custom claim set by
        // the session route before rules-evaluated client writes run.
        await result.user.getIdToken(true);
        router.push(data.isAdmin ? "/admin" : "/portal");
      } else if (response.status === 403) {
        toast({
          title: "Access Denied",
          description: "This account is not authorized. Please contact the site administrator.",
          variant: "destructive",
        });
        await auth.signOut();
      } else {
        throw new Error("Failed to create session");
      }
    } catch (error: any) {
      logAuthFailure("email-sign-in", error);
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

  const handleEmailSignUp = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    try {
      const result = await createUserWithEmailAndPassword(auth, email, password);

      toast({
        title: "Account Created",
        description: "Your account has been created successfully! Sign in to continue.",
      });

      await auth.signOut();
      
      // Reset form
      setEmail("");
      setPassword("");
      setIsSignIn(true);
    } catch (error: any) {
      logAuthFailure("email-sign-up", error);
      toast({
        title: "Registration Failed",
        description: error.code === 'auth/email-already-in-use'
          ? "An account with this email already exists."
          : error.code === 'auth/weak-password'
          ? "Password should be at least 6 characters."
          : "An error occurred during registration. Please try again.",
        variant: "destructive",
      });
    } finally {
      setLoading(false);
    }
  };

  const handleEmailAuth = async (e: React.FormEvent) => {
    if (isSignIn) {
      await handleEmailSignIn(e);
    } else {
      await handleEmailSignUp(e);
    }
  };

  const handleForgotPassword = async () => {
    if (!email) {
      toast({
        title: "Email Required",
        description: "Please enter your email address first.",
        variant: "destructive",
      });
      return;
    }

    try {
      await sendPasswordResetEmail(auth, email);
      toast({
        title: "Password Reset Email Sent",
        description: "Check your inbox for instructions to reset your password.",
      });
    } catch (error: any) {
      logAuthFailure("password-reset", error);
      toast({
        title: "Error",
        description: error.code === 'auth/user-not-found'
          ? "No account found with this email."
          : "Failed to send password reset email. Please try again.",
        variant: "destructive",
      });
    }
  };

  return (
    <main id="main-content" tabIndex={-1} className="min-h-screen flex items-center justify-center bg-background px-4 relative">
      <ThemeToggle />
      <Card className="w-full max-w-md">
        <CardHeader className="text-center">
          <h1 className="text-2xl font-semibold tracking-tight">SFPCA</h1>
          <CardDescription>{isSignIn ? "Sign in to your account" : "Create a new account"}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex items-center justify-center space-x-2">
            <Button
              type="button"
              variant={isSignIn ? "default" : "ghost"}
              size="sm"
              onClick={() => setIsSignIn(true)}
              className={isSignIn ? "" : "text-muted-foreground"}
            >
              Sign In
            </Button>
            <span className="text-muted-foreground">or</span>
            <Button
              type="button"
              variant={!isSignIn ? "default" : "ghost"}
              size="sm"
              onClick={() => setIsSignIn(false)}
              className={!isSignIn ? "" : "text-muted-foreground"}
            >
              Register
            </Button>
          </div>
          
          <form onSubmit={handleEmailAuth} className="space-y-3">
            <div className="space-y-1">
              <Label htmlFor="email">Email</Label>
              <Input
                id="email"
                type="email"
                autoComplete="email"
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
                autoComplete={isSignIn ? "current-password" : "new-password"}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="Enter your password"
                required
                disabled={loading}
              />
              {isSignIn && (
                <div className="text-right">
                  <Button
                    type="button"
                    variant="link"
                    size="sm"
                    className="h-auto p-0 text-xs"
                    onClick={handleForgotPassword}
                  >
                    Forgot your password?
                  </Button>
                </div>
              )}
            </div>
            <Button
              type="submit"
              disabled={loading}
              className="w-full"
              size="lg"
            >
              {loading ? (isSignIn ? "Signing in..." : "Creating account...") : (isSignIn ? "Sign in" : "Create Account")}
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
          
          <p className="text-xs text-muted-foreground text-center pt-4">
            {isSignIn
              ? "Staff and registered animal owners sign in here."
              : "Create an account to access the owner portal."
            }
          </p>
        </CardContent>
      </Card>
    </main>
  );
}
