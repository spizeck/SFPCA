import { type ClassValue, clsx } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

export function formatDate(date: Date | string): string {
  const d = typeof date === "string" ? new Date(date) : date;
  return d.toLocaleDateString("en-US", {
    year: "numeric",
    month: "long",
    day: "numeric",
  });
}

export function clearHashOnScroll() {
  let lastKnownScrollPosition = 0;
  let ticking = false;
  let initialTargetHash: string | null = null;

  function handleScroll() {
    lastKnownScrollPosition = window.scrollY;

    if (!ticking) {
      window.requestAnimationFrame(() => {
        // Store the initial hash when we first see one
        if (window.location.hash && !initialTargetHash) {
          initialTargetHash = window.location.hash.slice(1);
        }

        // Clear hash if user has scrolled away from the target
        if (initialTargetHash && lastKnownScrollPosition > 100) {
          const targetElement = document.getElementById(initialTargetHash);
          
          if (targetElement) {
            const targetRect = targetElement.getBoundingClientRect();
            const targetTop = targetRect.top + window.scrollY;
            
            // If we've scrolled more than 200px away from the target, clear the hash
            if (Math.abs(lastKnownScrollPosition - targetTop) > 200) {
              window.history.replaceState(null, '', window.location.pathname);
              initialTargetHash = null; // Reset so we don't try to clear again
            }
          }
        }
        
        ticking = false;
      });

      ticking = true;
    }
  }

  // Add scroll listener
  window.addEventListener('scroll', handleScroll, { passive: true });

  // Cleanup function
  return () => {
    window.removeEventListener('scroll', handleScroll);
  };
}
