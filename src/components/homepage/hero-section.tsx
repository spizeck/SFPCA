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
    <section className="relative h-screen overflow-hidden">
      {/* Background Video */}
      <video
        autoPlay
        loop
        muted
        playsInline
        className="absolute top-0 left-0 w-full h-full object-cover"
      >
        <source src="videos/herocat.mp4" type="video/mp4" />
      </video>
      
      {/* Dark overlay for text readability */}
      <div className="absolute inset-0 bg-black/50" />
      
      {/* Hero Content - now with relative positioning to sit above video */}
      <div className="relative z-10 container mx-auto px-4 h-full flex items-center justify-center">
        <div className="max-w-3xl mx-auto text-center">
          <h1 className="text-4xl md:text-6xl font-bold text-white mb-6 drop-shadow-lg">
            {data.title}
          </h1>
          <p className="text-xl md:text-2xl text-white/90 mb-8 drop-shadow-md">
            {data.subtitle}
          </p>
          <div className="flex flex-col sm:flex-row gap-4 justify-center">
            <Button size="lg" asChild className="shadow-xl">
              <Link href="#animals">{data.ctaPrimary}</Link>
            </Button>
            <Button size="lg" variant="outline" asChild className="bg-white/10 backdrop-blur-sm text-white border-white/30 hover:bg-white/20 shadow-xl">
              <Link href="#donation">{data.ctaSecondary}</Link>
            </Button>
          </div>
        </div>
      </div>
    </section>
  );
}
