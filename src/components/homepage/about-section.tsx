interface AboutSectionProps {
  data: {
    title: string;
    content: string;
  };
}

export function AboutSection({ data }: AboutSectionProps) {
  return (
    <section id="about" className="py-16 md:py-24 bg-background">
      <div className="container mx-auto px-4">
        <div className="max-w-3xl mx-auto text-center">
          <h2 className="text-3xl md:text-4xl font-bold text-foreground mb-6">
            {data.title}
          </h2>
          <p className="text-lg text-muted-foreground leading-relaxed whitespace-pre-line">
            {data.content}
          </p>
        </div>
      </div>
    </section>
  );
}
