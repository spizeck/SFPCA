"use client";

import { Breadcrumbs } from "@/components/ui/breadcrumbs";

interface LayoutWrapperProps {
  children: React.ReactNode;
}

export function LayoutWrapper({ children }: LayoutWrapperProps) {
  return (
    <>
      <Breadcrumbs />
      {children}
    </>
  );
}
