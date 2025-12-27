import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Stethoscope, Heart, ClipboardList } from "lucide-react";

interface ServicesSectionProps {
  data: {
    title: string;
    items: Array<{
      title: string;
      description: string;
    }>;
  };
}

const iconMap: Record<number, React.ReactNode> = {
  0: <Stethoscope className="h-10 w-10 text-primary" />,
  1: <Heart className="h-10 w-10 text-primary" />,
  2: <ClipboardList className="h-10 w-10 text-primary" />,
};

export function ServicesSection({ data }: ServicesSectionProps) {
  return (
    <section id="services" className="py-16 md:py-24 bg-muted">
      <div className="container mx-auto px-4">
        <h2 className="text-3xl md:text-4xl font-bold text-center text-foreground mb-12">
          {data.title}
        </h2>
        <div className="grid md:grid-cols-3 gap-8 max-w-5xl mx-auto">
          {data.items.map((service, index) => (
            <Card key={index} className="text-center">
              <CardHeader>
                <div className="flex justify-center mb-4">
                  {iconMap[index] || <Heart className="h-10 w-10 text-primary" />}
                </div>
                <CardTitle>{service.title}</CardTitle>
              </CardHeader>
              <CardContent>
                <CardDescription className="text-base">
                  {service.description}
                </CardDescription>
              </CardContent>
            </Card>
          ))}
        </div>
      </div>
    </section>
  );
}
