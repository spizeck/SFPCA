# Contributing to SFPCA Website

Thank you for your interest in contributing to the SFPCA website! This document provides guidelines for contributors.

## Getting Started

### Prerequisites

- Node.js 18+ and npm
- Git
- Firebase project access (for development)

### Setup

1. Fork the repository
2. Clone your fork:
   ```bash
   git clone https://github.com/yourusername/SFPCA.git
   cd SFPCA
   ```

3. Install dependencies:
   ```bash
   npm install
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
2. Run checks before submitting:
   ```bash
   npm run lint
   npm run type-check
   npm run build
   ```
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

- Never commit `.env.local` or any files containing secrets
- Validate all user inputs
- Use Firestore security rules for data access control
- No sensitive data in client-side code
- Service account keys must never be committed (covered by `.gitignore`)

## License

By contributing, you agree that your contributions will be licensed under the project's proprietary license. See [LICENSE](LICENSE).
