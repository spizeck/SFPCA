import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Animal } from "@/lib/types";
import Image from "next/image";

interface AnimalsSectionProps {
  animals: Animal[];
}

export function AnimalsSection({ animals }: AnimalsSectionProps) {
  if (animals.length === 0) {
    return null;
  }

  return (
    <section id="animals" className="py-16 md:py-24 bg-white">
      <div className="container mx-auto px-4">
        <h2 className="text-3xl md:text-4xl font-bold text-center text-gray-900 mb-4">
          Adoptable Animals
        </h2>
        <p className="text-center text-gray-600 mb-12 max-w-2xl mx-auto">
          Meet our wonderful animals looking for their forever homes
        </p>
        <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-6 max-w-6xl mx-auto">
          {animals.map((animal) => (
            <Card key={animal.id} className="overflow-hidden">
              {animal.photos && animal.photos.length > 0 && (
                <div className="relative h-48 w-full bg-gray-200">
                  <Image
                    src={animal.photos[0]}
                    alt={animal.name}
                    fill
                    className="object-cover"
                  />
                </div>
              )}
              <CardHeader>
                <CardTitle>{animal.name}</CardTitle>
                <CardDescription>
                  {animal.species.charAt(0).toUpperCase() + animal.species.slice(1)} • {animal.sex.charAt(0).toUpperCase() + animal.sex.slice(1)} • {animal.approxAge}
                </CardDescription>
              </CardHeader>
              <CardContent>
                <p className="text-sm text-gray-700">{animal.description}</p>
              </CardContent>
            </Card>
          ))}
        </div>
      </div>
    </section>
  );
}
