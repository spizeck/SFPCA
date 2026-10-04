import * as React from "react";
import { Slot } from "@radix-ui/react-slot";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";
import { Spinner } from "@/components/ui/spinner";

// Interaction layer (#280):
// - cursor-pointer: Tailwind v4 preflight leaves buttons on
//   `cursor: default`, which made every action read as non-interactive.
// - select-none: rapid clicks must never select the label text.
// - active:scale-[0.98] at --duration-press: the button physically
//   acknowledges the press before the network round-trip. Kept to 2%
//   so it reads as weight, not a bounce. The `link` variant opts out —
//   a text link should underline, not shrink.
// - transition-all + --duration-fast: colour/hover/active changes ride
//   the shared timing tokens. Reduced-motion users get the same states
//   instantly via the global transition cap in globals.css.
const buttonVariants = cva(
  "relative inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-md text-sm font-medium ring-offset-background transition-all duration-fast active:duration-press cursor-pointer select-none active:scale-[0.98] focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0",
  {
    variants: {
      variant: {
        default: "bg-primary text-primary-foreground hover:bg-primary/90",
        destructive: "bg-destructive text-destructive-foreground hover:bg-destructive/90",
        outline: "border border-input bg-background hover:bg-accent hover:text-accent-foreground",
        secondary: "bg-secondary text-secondary-foreground hover:bg-secondary/80",
        ghost: "hover:bg-accent hover:text-accent-foreground",
        link: "text-primary underline-offset-4 hover:underline active:scale-100",
      },
      size: {
        default: "h-10 px-4 py-2",
        sm: "h-9 rounded-md px-3",
        lg: "h-11 rounded-md px-8",
        icon: "h-10 w-10",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  }
);

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {
  asChild?: boolean;
  // True while an async action is in flight. The button becomes
  // non-interactive (duplicate submissions can't fire), gains
  // aria-busy, and shows a centred spinner over the hidden label —
  // the label keeps its layout box so the button never changes size
  // mid-interaction, and the accessible name becomes "Loading…".
  loading?: boolean;
}

const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, asChild = false, loading = false, disabled, children, ...props }, ref) => {
    const Comp = asChild ? Slot : "button";
    return (
      <Comp
        className={cn(buttonVariants({ variant, size, className }), loading && "pointer-events-none")}
        ref={ref}
        // Native `disabled` blocks re-clicks on real buttons; slotted
        // children (usually <a>) get aria-disabled + pointer-events-none
        // instead since anchors have no disabled attribute.
        disabled={asChild ? undefined : disabled || loading}
        aria-disabled={asChild && (disabled || loading) ? true : undefined}
        aria-busy={loading || undefined}
        {...props}
      >
        {loading ? (
          <>
            <span
              className="inline-flex items-center justify-center gap-2 opacity-0"
              aria-hidden="true"
            >
              {children}
            </span>
            <span
              className="absolute inset-0 flex items-center justify-center"
              aria-hidden="true"
            >
              <Spinner />
            </span>
            <span className="sr-only">Loading…</span>
          </>
        ) : (
          children
        )}
      </Comp>
    );
  }
);
Button.displayName = "Button";

export { Button, buttonVariants };
