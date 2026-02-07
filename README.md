# SFPCA Website

A modern web application for the **Saba Foundation for the Prevention of Cruelty to Animals (SFPCA)** — serving the island of Saba in the Caribbean Netherlands.

Built with Next.js 16, TypeScript, Tailwind CSS, and Firebase.

## Features

### Public Website
- **Homepage** with hero video, about section, services, adoptable animals, donations, FAQ, and contact
- **FAQ Page** with categorized, expandable questions (dynamically managed via admin)
- **Animal Adoptions** page with filterable listings
- **Contact Page** with contact info, map embed, and social links
- **Under Construction** placeholder for pages in development
- **SEO Optimized** with Open Graph, Twitter cards, JSON-LD structured data, sitemap, and robots.txt
- **Responsive Design** — mobile-first with Tailwind CSS
- **Dark/Light Mode** via next-themes

### Admin Dashboard (`/admin`)
- **Homepage Editor** — edit hero, about, services, donation, and team sections
- **Animal Management** — full CRUD for adoption listings
- **FAQ Management** — add, edit, delete FAQs by category (syncs to homepage + FAQ page)
- **Veterinary Services** — manage vet service content
- **Animal Adoptions** — manage adoption page content
- **Animal Registration** — view and verify submitted registrations
- **Site Settings** — update contact info, social media links, map embed
- **Team Photo Uploads** — Firebase Storage integration with loading states

### Security
- Session-based authentication with HTTP-only cookies
- Middleware-protected admin routes
- Firestore security rules enforce read/write permissions
- Admin allowlist via Firestore `admins` collection

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Framework | Next.js 16 (App Router, Turbopack) |
| Language | TypeScript |
| Styling | Tailwind CSS + shadcn/ui |
| Animation | Framer Motion |
| Backend | Firebase (Auth, Firestore, Storage) |
| Icons | Lucide React |
| Deployment | Vercel |

## Getting Started

### Prerequisites

- Node.js 18+ and npm
- Firebase project with Authentication, Firestore, and Storage enabled
- Firebase service account key (for server-side admin SDK)

### Installation

1. **Clone the repository**
   ```bash
   git clone https://github.com/spizeck/SFPCA.git
   cd SFPCA
   ```

2. **Install dependencies**
   ```bash
   npm install
   ```

3. **Set up environment variables**
   ```bash
   cp .env.example .env.local
   ```
   Fill in your Firebase credentials (see `.env.example` for all required variables).

4. **Set up Firebase**
   - Enable Google Sign-In in Firebase Authentication
   - Create a Firestore database
   - Enable Firebase Storage
   - Deploy security rules:
     ```bash
     firebase deploy --only firestore:rules
     firebase deploy --only storage
     ```

5. **Add yourself as an admin**
   
   In the Firestore console, create a document in the `admins` collection with your email as the document ID.

6. **Run the development server**
   ```bash
   npm run dev
   ```
   Open [http://localhost:3000](http://localhost:3000).

## Project Structure

```
SFPCA/
├── src/
│   ├── app/                          # Next.js App Router
│   │   ├── admin/                    # Admin dashboard (protected)
│   │   │   ├── animals/              # Animal management
│   │   │   ├── animal-adoptions/     # Adoption page editor
│   │   │   ├── animal-registration/  # Registration page editor
│   │   │   ├── faq/                  # FAQ management
│   │   │   ├── homepage/             # Homepage editor
│   │   │   ├── registrations/        # View submitted registrations
│   │   │   ├── settings/             # Site settings
│   │   │   ├── veterinary-services/  # Vet services editor
│   │   │   └── page.tsx              # Admin dashboard
│   │   ├── api/auth/                 # Authentication API routes
│   │   ├── animal-adoptions/         # Public adoptions page
│   │   ├── contact/                  # Contact page
│   │   ├── faq/                      # FAQ page
│   │   ├── login/                    # Login page
│   │   ├── under-construction/       # Placeholder page
│   │   ├── layout.tsx                # Root layout with metadata
│   │   ├── page.tsx                  # Public homepage
│   │   ├── robots.ts                 # SEO robots.txt
│   │   └── sitemap.ts               # SEO sitemap
│   ├── components/
│   │   ├── admin/                    # Admin components (nav, team manager)
│   │   ├── animal-adoptions/         # Adoption page components
│   │   ├── animal-registration/      # Registration form components
│   │   ├── contact/                  # Contact page components
│   │   ├── faq/                      # FAQ page components
│   │   ├── homepage/                 # Homepage section components
│   │   ├── ui/                       # shadcn/ui components
│   │   └── veterinary-services/      # Vet services components
│   ├── hooks/                        # Custom React hooks
│   └── lib/                          # Utilities
│       ├── firebase.ts               # Firebase client config
│       ├── firebase-admin.ts         # Firebase admin SDK config
│       ├── auth.ts                   # Auth helpers
│       ├── animals.ts                # Animal data helpers
│       ├── animations.ts             # Framer Motion utilities
│       ├── types.ts                  # TypeScript types
│       └── utils.ts                  # General utilities
├── firestore.rules                   # Firestore security rules
├── storage.rules                     # Firebase Storage security rules
├── .env.example                      # Environment variable template
└── package.json
```

## Firestore Collections

| Collection | Description |
|-----------|-------------|
| `homepage` | Homepage content (doc: `main`) — hero, about, services, donation, team |
| `siteSettings` | Contact info, social links, map embed (doc: `global`) |
| `animals` | Adoptable animal listings with photos, status, species |
| `faq` | FAQ entries with category, question, answer, and display order |
| `animalRegistrations` | Submitted animal registration forms |
| `admins` | Admin user allowlist (email as document ID) |
| `vetServices` | Veterinary services page content |
| `animalAdoptions` | Animal adoptions page content |

## Admin Access

1. Navigate to `/login`
2. Sign in with Google using an authorized email
3. You will be redirected to `/admin` if authorized

To add an admin, create a document in the `admins` Firestore collection with the user's email as the document ID.

## Deployment

### Vercel

1. Push code to GitHub
2. Import the project in [Vercel](https://vercel.com)
3. Add all environment variables from `.env.example` in the Vercel dashboard
4. Deploy

### Firebase Rules

After any changes to security rules:
```bash
firebase deploy --only firestore:rules
firebase deploy --only storage
```

## Scripts

| Command | Description |
|---------|-------------|
| `npm run dev` | Start development server (Turbopack) |
| `npm run build` | Production build |
| `npm run start` | Start production server |
| `npm run lint` | Run ESLint |
| `npm run lint:fix` | Auto-fix lint issues |
| `npm run type-check` | TypeScript type checking |

## Environment Variables

See `.env.example` for the full list. Key variables:

- `NEXT_PUBLIC_FIREBASE_*` — Firebase client SDK config
- `FIREBASE_ADMIN_*` — Firebase Admin SDK (server-side)
- `ADMIN_EMAILS` — Comma-separated admin email allowlist
- `NEXT_PUBLIC_GA_ID` — Google Analytics measurement ID
- `NEXT_PUBLIC_SITE_URL` — Canonical site URL

## License

Proprietary — &copy; 2025 SFPCA. All rights reserved. See [LICENSE](LICENSE).

## Contact

Saba Foundation for the Prevention of Cruelty to Animals  
Email: sfpcasaba@gmail.com  
Phone: +599 416 7947
