# SFPCA Website

A modern Next.js web application for the Saba Foundation for Preventing Cruelty to Animals (SFPCA).

## Features

- **Public Website**: Single-page layout with hero, about, services, adoptable animals, donation info, and contact sections
- **Admin Dashboard**: Protected admin area for managing content
- **Homepage Editor**: Edit all homepage content including hero, about, services, and donation sections
- **Animal Management**: Full CRUD for animal adoption listings
- **Settings Management**: Update contact information and social media links
- **Firebase Integration**: Authentication, Firestore database, and Storage
- **Responsive Design**: Mobile-first design with Tailwind CSS
- **Type-Safe**: Built with TypeScript for reliability

## Tech Stack

- **Framework**: Next.js 15+ (App Router)
- **Language**: TypeScript
- **Styling**: Tailwind CSS + shadcn/ui components
- **Backend**: Firebase (Auth, Firestore, Storage)
- **Deployment**: Vercel-ready

## Getting Started

### Prerequisites

- Node.js 18+ and npm
- Firebase project with Firestore and Authentication enabled
- Firebase service account key (for admin SDK)

### Installation

1. **Clone the repository**
   ```bash
   cd SFPCA
   ```

2. **Install dependencies**
   ```bash
   npm install
   ```

3. **Set up environment variables**
   
   Copy `.env.example` to `.env.local`:
   ```bash
   cp .env.example .env.local
   ```

   Fill in your Firebase credentials:
   ```env
   # Firebase Client Config
   NEXT_PUBLIC_FIREBASE_API_KEY=your_api_key
   NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN=your_project.firebaseapp.com
   NEXT_PUBLIC_FIREBASE_PROJECT_ID=your_project_id
   NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET=your_project.appspot.com
   NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID=your_sender_id
   NEXT_PUBLIC_FIREBASE_APP_ID=your_app_id

   # Firebase Admin (Server-side)
   FIREBASE_ADMIN_PROJECT_ID=your_project_id
   FIREBASE_ADMIN_CLIENT_EMAIL=firebase-adminsdk@your_project.iam.gserviceaccount.com
   FIREBASE_ADMIN_PRIVATE_KEY="-----BEGIN PRIVATE KEY-----\n...\n-----END PRIVATE KEY-----\n"

   # Admin Allowlist
   ADMIN_EMAILS=admin@example.com
   ```

4. **Set up Firebase**

   - Enable Google Sign-In in Firebase Authentication
   - Create Firestore database
   - Deploy Firestore security rules:
     ```bash
     firebase deploy --only firestore:rules
     ```

5. **Seed initial data** (optional)

   Set the path to your Firebase service account JSON file:
   ```bash
   export FIREBASE_SERVICE_ACCOUNT_PATH=/path/to/serviceAccountKey.json
   npm run seed
   ```

6. **Run the development server**
   ```bash
   npm run dev
   ```

   Open [http://localhost:3000](http://localhost:3000) in your browser.

## Project Structure

```
SFPCA/
├── src/
│   ├── app/                    # Next.js App Router pages
│   │   ├── admin/             # Admin area (protected)
│   │   │   ├── animals/       # Animal management
│   │   │   ├── homepage/      # Homepage editor
│   │   │   ├── settings/      # Site settings
│   │   │   └── page.tsx       # Admin dashboard
│   │   ├── api/               # API routes
│   │   │   └── auth/          # Authentication endpoints
│   │   ├── login/             # Login page
│   │   ├── layout.tsx         # Root layout
│   │   ├── page.tsx           # Public homepage
│   │   └── globals.css        # Global styles
│   ├── components/            # React components
│   │   ├── admin/             # Admin-specific components
│   │   ├── homepage/          # Homepage sections
│   │   └── ui/                # shadcn/ui components
│   ├── lib/                   # Utilities and helpers
│   │   ├── firebase.ts        # Firebase client config
│   │   ├── firebase-admin.ts  # Firebase admin config
│   │   ├── auth.ts            # Auth helpers
│   │   ├── types.ts           # TypeScript types
│   │   └── utils.ts           # Utility functions
│   └── hooks/                 # Custom React hooks
├── scripts/                   # Utility scripts
│   ├── seed.ts               # Database seeding script
│   └── seed-data.json        # Seed data
├── firestore.rules           # Firestore security rules
├── middleware.ts             # Next.js middleware (auth)
└── package.json
```

## Admin Access

### Setting Up Admin Users

Admins can be configured in two ways:

1. **Environment Variable** (recommended for initial setup):
   Add emails to `ADMIN_EMAILS` in `.env.local`:
   ```env
   ADMIN_EMAILS=admin@example.com,editor@example.com
   ```

2. **Firestore Collection**:
   Add documents to the `admins` collection:
   ```javascript
   {
     email: "user@example.com",
     role: "admin" | "editor",
     createdAt: Timestamp
   }
   ```

### Admin Roles

- **Admin**: Full access including managing the admin allowlist
- **Editor**: Can edit content but cannot manage admin users

### Accessing the Admin Area

1. Navigate to `/login`
2. Sign in with Google using an authorized email
3. You'll be redirected to `/admin` if authorized

## Firestore Collections

### `homepage` (doc: "main")
Stores all homepage content including hero, about, services, and donation sections.

### `siteSettings` (doc: "global")
Stores contact information and social media links.

### `animals`
Collection of animal documents with fields:
- `name`: string
- `species`: "dog" | "cat" | "other"
- `sex`: "male" | "female" | "unknown"
- `approxAge`: string
- `description`: string
- `status`: "available" | "pending" | "adopted"
- `photos`: string[] (URLs)
- `createdAt`: timestamp
- `updatedAt`: timestamp

### `admins`
Collection of admin user documents (email as document ID).

## Deployment

### Vercel Deployment

1. Push your code to GitHub
2. Import the project in Vercel
3. Add environment variables in Vercel dashboard
4. Deploy!

The app is optimized for Vercel with:
- Automatic API routes
- Edge middleware for authentication
- Image optimization
- Server-side rendering

## Future Enhancements (Phase 2)

The following features are marked with TODO comments in the codebase:

- [ ] Animal registration form for public users
- [ ] Admin queue for registration approvals
- [ ] Firebase Storage integration for photo uploads
- [ ] Email notifications
- [ ] Advanced search and filtering for animals
- [ ] Adoption application workflow
- [ ] Volunteer management system

## Security

- Admin routes are protected by middleware
- Firestore security rules enforce data access
- Session-based authentication with HTTP-only cookies
- Admin allowlist prevents unauthorized access

## Contributing

This is a custom project for SFPCA. For modifications or issues, please contact the development team.

## License

Proprietary - © 2025 SFPCA. All rights reserved.
