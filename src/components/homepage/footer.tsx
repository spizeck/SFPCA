import { Facebook, Instagram, Twitter } from "lucide-react";

interface FooterProps {
  social: {
    facebook?: string;
    instagram?: string;
    twitter?: string;
  };
}

export function Footer({ social }: FooterProps) {
  return (
    <footer className="bg-gray-900 text-white py-12">
      <div className="container mx-auto px-4">
        <div className="flex flex-col items-center gap-6">
          <h3 className="text-2xl font-bold">SFPCA</h3>
          <p className="text-gray-400 text-center max-w-md">
            Saba Foundation for Preventing Cruelty to Animals
          </p>
          <div className="flex gap-6">
            {social.facebook && (
              <a
                href={social.facebook}
                target="_blank"
                rel="noopener noreferrer"
                className="hover:text-primary transition-colors"
                aria-label="Facebook"
              >
                <Facebook className="h-6 w-6" />
              </a>
            )}
            {social.instagram && (
              <a
                href={social.instagram}
                target="_blank"
                rel="noopener noreferrer"
                className="hover:text-primary transition-colors"
                aria-label="Instagram"
              >
                <Instagram className="h-6 w-6" />
              </a>
            )}
            {social.twitter && (
              <a
                href={social.twitter}
                target="_blank"
                rel="noopener noreferrer"
                className="hover:text-primary transition-colors"
                aria-label="Twitter"
              >
                <Twitter className="h-6 w-6" />
              </a>
            )}
          </div>
          <div className="text-sm text-gray-500 text-center">
            <p>&copy; {new Date().getFullYear()} SFPCA. All rights reserved.</p>
          </div>
        </div>
      </div>
    </footer>
  );
}
