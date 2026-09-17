# Contributing to SFPCA Website

Thank you for your interest in contributing to the SFPCA website! This document provides guidelines for contributors.

## Getting Started

### Prerequisites

- Node.js 24 and npm — the version is declared in `.nvmrc` and root
  `package.json` `engines` (run `nvm use` / `fnm use` if your version
  manager supports it). Firebase Functions also deploys on Node 24.
- Git
- Firebase project access (for development)

### Setup

1. Fork the repository
2. Clone your fork:
   ```bash
   git clone https://github.com/yourusername/SFPCA.git
   cd SFPCA
   ```

3. Install dependencies from the lockfile:
   ```bash
   npm ci
   ```

4. Create a feature branch:
   ```bash
   git checkout -b feature/your-feature-name
   ```

5. Set up environment variables:
   ```bash
   cp .env.example .env.local
   ```
   Fill in your Firebase credentials.

6. Start development server:
   ```bash
   npm run dev
   ```

## Development Guidelines

### Code Style

- Use TypeScript for all new code
- Follow the existing code structure and patterns
- Use server components by default; only use `"use client"` when necessary
- Use shadcn/ui components for UI elements
- Use Lucide React for icons
- Use Framer Motion for animations (respect `shouldReduceMotion`)

### Commit Messages

Use conventional commits:
- `feat:` new features
- `fix:` bug fixes
- `docs:` documentation
- `style:` formatting
- `refactor:` refactoring
- `chore:` maintenance

### Pull Requests

1. Ensure your branch is up to date with `main`
2. Run the same checks CI runs (see `.github/workflows/ci.yml`) before submitting:

   **Root app**
   ```bash
   npm ci
   npm run lint
   npm run type-check
   npm run build
   ```

   **Firebase Functions**
   ```bash
   cd functions
   npm ci
   npm run lint
   node -e "const f = require('./index.js'); for (const name of ['onFirestoreChange', 'triggerRebuild']) { if (!f[name]) { console.error('Missing required function export', name); process.exit(1); } }"
   ```

   `functions/` uses ESLint 8 with `eslint-config-google` via
   `functions/eslint.config.mjs` (a FlatCompat wrapper around
   `.eslintrc.js`), so plain `npm run lint` works identically locally
   and in CI — no environment variables needed.

   **Firestore/Storage security rules** (runs the local Firebase Emulator
   Suite; requires Java, no credentials needed):
   ```bash
   npm run test:rules
   ```

   > **Note:** `npm run build` requires the `NEXT_PUBLIC_FIREBASE_*` variables
   > from `.env.local` (or placeholders) to be set, because the Firebase client
   > SDK initializes during static generation. Real credentials are not needed
   > for the build itself — CI uses placeholder values.

3. Create a PR with a clear title, description, and screenshots for UI changes

## Adding Features

### New Admin Pages

1. Create route at `src/app/admin/[feature]/page.tsx`
2. Add navigation link in `src/components/admin/admin-nav.tsx`
3. Add Firestore security rules if needed
4. Use shadcn/ui components for consistency

### New Public Pages

1. Create route at `src/app/[page]/page.tsx`
2. Add SEO metadata export
3. Add to `src/app/sitemap.ts`
4. Ensure mobile responsiveness

### Database Changes

1. Update TypeScript types in `src/lib/types.ts`
2. Update Firestore security rules in `firestore.rules`
3. Document the new collection in the README

## Security

- Never commit any `.env*` file or credentials — only `.env.example`
  placeholders are committed (see [SECURITY.md](SECURITY.md) for details)
- Validate all user inputs
- Use Firestore security rules for data access control
- No sensitive data in client-side code
- Service account keys must never be committed (covered by `.gitignore`)
- Run `npm audit` (root and `functions/`) before adding or upgrading
  dependencies; report vulnerabilities per [SECURITY.md](SECURITY.md)

## License

By contributing, you agree that your contributions will be licensed under the project's proprietary license. See [LICENSE](LICENSE).
