import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

interface DonationSectionProps {
  data: {
    title: string;
    content: string;
    paymentMethods: string;
  };
}

export function DonationSection({ data }: DonationSectionProps) {
  return (
    <section id="donation" className="py-16 md:py-24 bg-gray-50">
      <div className="container mx-auto px-4">
        <div className="max-w-3xl mx-auto">
          <Card>
            <CardHeader className="text-center">
              <CardTitle className="text-3xl">{data.title}</CardTitle>
              <CardDescription className="text-base mt-4">
                {data.content}
              </CardDescription>
            </CardHeader>
            <CardContent>
              <div className="bg-green-50 p-6 rounded-lg">
                <h3 className="font-semibold text-lg mb-3">Payment Methods</h3>
                <p className="text-gray-700 whitespace-pre-line">{data.paymentMethods}</p>
              </div>
            </CardContent>
          </Card>
        </div>
      </div>
    </section>
  );
}
