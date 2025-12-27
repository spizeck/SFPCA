"use client"

import { useEffect } from "react";
import { clearHashOnScroll } from "@/lib/utils";

export function HashClear() {
  useEffect(() => {
    const cleanup = clearHashOnScroll();
    return cleanup;
  }, []);

  return null;
}
