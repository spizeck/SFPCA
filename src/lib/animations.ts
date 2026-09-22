"use client"

import { Variants, Transition, useReducedMotion } from "framer-motion"

// Base animation variants
export const fadeInUpVariants: Variants = {
  initial: { opacity: 0, y: 20 },
  whileInView: { opacity: 1, y: 0 },
}

export const fadeInVariants: Variants = {
  initial: { opacity: 0 },
  whileInView: { opacity: 1 },
}

export const scaleInVariants: Variants = {
  initial: { opacity: 0, scale: 0.95 },
  whileInView: { opacity: 1, scale: 1 },
}

export const slideInLeftVariants: Variants = {
  initial: { opacity: 0, x: -20 },
  whileInView: { opacity: 1, x: 0 },
}

export const slideInRightVariants: Variants = {
  initial: { opacity: 0, x: 20 },
  whileInView: { opacity: 1, x: 0 },
}

// Stagger animation for container children
export const staggerContainer: Variants = {
  initial: { opacity: 0 },
  whileInView: { 
    opacity: 1,
    transition: {
      staggerChildren: 0.1,
    },
  },
}

// Common transition settings
export const defaultTransition: Transition = {
  duration: 0.6,
  ease: "easeInOut",
}

export const slowTransition: Transition = {
  duration: 0.8,
  ease: "easeInOut",
}

// Viewport settings
export const defaultViewport = {
  once: true,
  margin: "-100px",
}

// Reduced-motion experience: fully instant, no delay.
export const instantTransition: Transition = { duration: 0, delay: 0 }

// Hydration rule: `initial`, `animate`, `whileInView`, `exit`, `variants`,
// and `viewport` are serialized into the rendered markup, so they must be
// identical on the server and the first client render — never vary them by
// media query. `transition` is never serialized, so it is the one prop that
// may safely depend on the user's reduced-motion preference.
//
// Do not reintroduce a render-time matchMedia check here: the server has no
// `window`, so such a check produces divergent markup for reduced-motion
// users (React reports a hydration mismatch and leaves the stale hidden
// styles in place, permanently hiding content).
export function useMotionTransition(transition: Transition = defaultTransition): Transition {
  const reduceMotion = useReducedMotion()
  return reduceMotion ? instantTransition : transition
}

// Shared props for scroll-triggered reveal sections. Markup-affecting props
// are constant; only the transition honors reduced motion.
export function useInViewAnimationProps(transition: Transition = defaultTransition) {
  return {
    initial: "initial" as const,
    whileInView: "whileInView" as const,
    viewport: defaultViewport,
    transition: useMotionTransition(transition),
  }
}
