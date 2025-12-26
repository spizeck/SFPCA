# AI Instructions – SFPCA Website & Admin

## Project Overview
This repository is a **Next.js 16** application for the  
**Saba Foundation for the Prevention of Cruelty to Animals (SFPCA)**.

The project consists of:
- A **public-facing single-page website**
- A protected **/admin area** for non-technical editors
- A foundation for future workflows such as:
  - Animal registrations
  - Adoption applications
  - Admin review queues
  - Payments and receipts (future phase)

The codebase should prioritize **clarity, stability, and ease of maintenance**.

---

## Core Tech Stack (Hard Requirements)
- **Next.js 16.x**
- **React 19 (stable)**
- **App Router only** (`app/` directory)
- **TypeScript**
- **Tailwind CSS**
- **shadcn/ui**
- **Firebase**
  - Auth (Google sign-in)
  - Firestore
  - Storage
- Deployment target: **Vercel**

---

## Next.js 16 Rules (Very Important)
- Use **Server Components by default**
- Use `"use client"` **only** when required:
  - Forms
  - Auth state
  - File uploads
  - Interactive admin UI
- **DO NOT** use:
  - `pages/`
  - `getServerSideProps`
  - `getStaticProps`
  - legacy API routes unless explicitly justified
- Prefer **Server Actions** for mutations (Firestore writes).
- Use modern `fetch` caching patterns:
  - `cache: 'no-store'` for admin data
  - `revalidate` for public content where appropriate
- Use **route groups** to separate public/admin concerns.

---

## Routing Structure

### Public
- `/` – Single-page landing site
- `/adopt` – Optional later (full list of adoptable animals)
- `/login` – Admin login

### Admin (Protected)
- `/admin`
- `/admin/homepage`
- `/admin/animals`
- `/admin/settings`

All `/admin` routes must:
- Require authentication
- Verify allowlist/role before rendering
- Redirect unauthorized users safely

---

## UI / UX Principles
- Use **shadcn/ui components** consistently
- Favor simple, predictable layouts
- Optimize for **non-technical editors**
- Avoid raw HTML editing in admin
- Prefer structured fields over free-form blobs
- Mobile-friendly admin UI is required

---

## Content Strategy
### Use structured fields for:
- Hero title & subtitle
- CTAs (label + link)
- Short descriptions
- Services lists
- Contact info
- Donation info

### Markdown policy:
- Markdown is **NOT** used for homepage sections
- Markdown may be introduced later for:
  - Policies
  - FAQs
  - Long-form informational pages
- Do not assume Markdown everywhere

---

## Firestore Data Model (Canonical)

### `siteSettings/global`
- orgName
- phone
- whatsapp
- email
- address
- hours
- socialLinks

### `homepage/main`
- heroTitle
- heroSubtitle
- ctas[]
- services[]
- donationText
- updatedAt

### `animals/{id}`
- name
- species: `"dog" | "cat" | "other"`
- sex: `"male" | "female" | "unknown"`
- approxAge (string)
- description
- status: `"available" | "pending" | "adopted"`
- photos: string[] (Storage URLs)
- createdAt
- updatedAt

### `users/{uid}` (or `admins/{uid}`)
- email
- displayName
- role: `"admin" | "editor"`

---

## Permissions & Roles
- Public users:
  - Read-only access to homepage content
  - Read-only access to animals with `status === "available"`
- Editors:
  - Edit homepage content
  - Manage animals
- Admins:
  - All editor permissions
  - Manage user allowlist
  - Edit site settings

All permissions must be enforced server-side.

---

## Firebase Rules Guidance
- Reads for public content allowed
- Writes restricted to authenticated, allowlisted users
- Never trust client-only role checks
- Firebase Admin SDK must run server-side only

---

## Code Organization Guidelines
- `src/app` – routes and layouts
- `src/components` – reusable UI components
- `src/lib` – Firebase init, auth helpers
- `src/services` – Firestore data access logic
- `src/types` – shared TypeScript types
- Keep files small and focused

---

## Design Philosophy
- Prefer boring, understandable code
- Avoid over-abstraction
- No premature optimization
- No experimental-only APIs
- Prioritize maintainability over cleverness

---

## Phase 2 (Future – Do Not Implement Yet)
- `/register` public form (animal registration intake)
- Admin registration review queue
- Registration number assignment
- Stripe payments
- Receipt generation
- Export/print utilities

Add TODO comments where relevant, but do not build these yet.

---

## Final Instruction to AI
When making decisions:
- Choose the **simplest working solution**
- Assume editors are not technical
- Assume this project will be maintained for years
- Avoid introducing unnecessary libraries
- Follow Next.js 16 best practices strictly
