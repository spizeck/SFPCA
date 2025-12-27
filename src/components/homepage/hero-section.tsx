import { Button } from "@/components/ui/button";
import Link from "next/link";

interface HeroSectionProps {
  data: {
    title: string;
    subtitle: string;
    ctaPrimary: string;
    ctaSecondary: string;
  };
}

export function HeroSection({ data }: HeroSectionProps) {
  return (
    <section className="relative bg-gradient-to-br from-background to-muted py-20 md:py-32">
      <div className="container mx-auto px-4">
        <div className="max-w-3xl mx-auto text-center">
          <h1 className="text-4xl md:text-6xl font-bold text-foreground mb-6">
            {data.title}
          </h1>
          <p className="text-xl md:text-2xl text-muted-foreground mb-8">
            {data.subtitle}
          </p>
          <div className="flex flex-col sm:flex-row gap-4 justify-center">
            <Button size="lg" asChild>
              <Link href="#animals">{data.ctaPrimary}</Link>
            </Button>
            <Button size="lg" variant="outline" asChild>
              <Link href="#donation">{data.ctaSecondary}</Link>
            </Button>
          </div>
        </div>
      </div>
    </section>
  );
}
