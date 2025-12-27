"use client"

import { Variants, Transition } from "framer-motion"

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

// Check for reduced motion preference
export const shouldReduceMotion = () => {
  if (typeof window === "undefined") return false
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches
}

// Animation props that respect reduced motion
export const getAnimationProps = (variants: Variants, transition = defaultTransition) => {
  if (shouldReduceMotion()) {
    return {
      initial: false,
      whileInView: undefined,
      viewport: undefined,
      transition: undefined,
    }
  }

  return {
    initial: "initial",
    whileInView: "whileInView",
    viewport: defaultViewport,
    transition,
    variants,
  }
}
