import Link from "next/link";
import {
  FacebookIcon,
  InstagramIcon,
  TwitterIcon,
} from "@/components/ui/brand-icons";
import { ConsentSettingsButton } from "@/components/consent/consent-settings-button";

interface FooterProps {
  social: {
    facebook?: string;
    instagram?: string;
    twitter?: string;
  };
}

export function Footer({ social }: FooterProps) {
  return (
    <footer className="bg-foreground text-background py-12">
      <div className="container mx-auto px-4">
        <div className="flex flex-col items-center gap-6">
          <h3 className="text-2xl font-bold">SFPCA</h3>
          <p className="text-background/80 text-center max-w-md">
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
                <FacebookIcon className="h-6 w-6" aria-hidden="true" />
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
                <InstagramIcon className="h-6 w-6" aria-hidden="true" />
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
                <TwitterIcon className="h-6 w-6" aria-hidden="true" />
              </a>
            )}
          </div>
          <div className="flex items-center gap-4 text-sm">
            <Link
              href="/privacy"
              className="hover:text-primary transition-colors underline-offset-4 hover:underline"
            >
              Privacy policy
            </Link>
            <span aria-hidden="true" className="text-background/40">
              ·
            </span>
            <ConsentSettingsButton className="hover:text-primary transition-colors underline-offset-4 hover:underline" />
          </div>
          <div className="text-sm text-background/80 text-center">
            <p>&copy; {new Date().getFullYear()} SFPCA. All rights reserved.</p>
          </div>
        </div>
      </div>
    </footer>
  );
}
