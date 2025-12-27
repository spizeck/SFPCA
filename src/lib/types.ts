export interface Animal {
  id: string;
  name: string;
  species: "dog" | "cat" | "other";
  sex: "male" | "female" | "unknown";
  approxAge: string;
  description: string;
  status: "available" | "pending" | "adopted";
  photos: string[];
  createdAt: string;
  updatedAt: string;
}

export interface HomepageSection {
  id: string;
  title: string;
  content: string;
  order: number;
}

export interface Homepage {
  hero: {
    title: string;
    subtitle: string;
    ctaPrimary: string;
    ctaSecondary: string;
  };
  about: {
    title: string;
    content: string;
  };
  services: {
    title: string;
    items: Array<{
      title: string;
      description: string;
    }>;
  };
  donation: {
    title: string;
    content: string;
    paymentMethods: string;
  };
}

export interface SiteSettings {
  contact: {
    phone: string;
    email: string;
    whatsapp: string;
    address: string;
    hours: string;
  };
  social: {
    facebook?: string;
    instagram?: string;
    twitter?: string;
  };
}

export interface AdminUser {
  email: string;
  role: "admin" | "editor";
  createdAt: Date;
}
