# Contributing to SFPCA Website

Thank you for your interest in contributing to the SFPCA website! This document provides guidelines and information for contributors.

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
- Follow the existing code structure
- Use server components by default
- Only use `"use client"` when necessary
- Follow shadcn/ui patterns for UI components

### Commit Messages

Use conventional commits:
- `feat:` for new features
- `fix:` for bug fixes
- `docs:` for documentation
- `style:` for formatting
- `refactor:` for refactoring
- `test:` for tests
- `chore:` for maintenance

Example:
```
feat: add animal search functionality
fix: resolve mobile layout issue
```

### Pull Requests

1. Ensure your branch is up to date:
   ```bash
   git checkout main
   git pull upstream main
   git checkout your-branch
   git rebase main
   ```

2. Run tests and linting:
   ```bash
   npm run lint
   npm run type-check
   npm run build
   ```

3. Create a pull request with:
   - Clear title and description
   - Reference any related issues
   - Include screenshots if UI changes
   - Mark as ready for review

## Project Structure

```
src/
├── app/                # Next.js App Router pages
│   ├── admin/         # Admin routes (protected)
│   ├── api/           # API routes
│   └── (routes)/      # Public routes
├── components/        # React components
│   ├── admin/         # Admin components
│   ├── homepage/      # Homepage sections
│   └── ui/            # shadcn/ui components
├── lib/               # Utilities and helpers
│   ├── firebase.ts    # Firebase client config
│   ├── auth.ts        # Auth helpers
│   └── types.ts       # TypeScript types
└── hooks/             # Custom React hooks
```

## Adding Features

### New Admin Pages

1. Create route in `src/app/admin/[feature]/page.tsx`
2. Add navigation link in `src/components/admin/admin-nav.tsx`
3. Implement server-side auth check
4. Use shadcn/ui components for UI

### New Public Pages

1. Create route in `src/app/[page]/page.tsx`
2. Use server components for data fetching
3. Ensure mobile responsiveness
4. Add to navigation if needed

### Database Changes

1. Update TypeScript types in `src/lib/types.ts`
2. Update Firestore security rules
3. Update seed data if needed
4. Document changes in PR

## Testing

### Manual Testing Checklist

- [ ] Feature works on desktop
- [ ] Feature works on mobile
- [ ] Admin authentication works
- [ ] Form validation works
- [ ] Error states handled
- [ ] Loading states shown

### Type Checking

Run TypeScript compiler:
```bash
npm run type-check
```

### Linting

Run ESLint:
```bash
npm run lint
```

## Deployment

### Preview Deployments

- Each PR creates a Vercel preview
- Test on preview before merging

### Production Deployment

- Merge to `main` branch triggers deployment
- Ensure environment variables are set in Vercel

## Security Considerations

- Never commit `.env.local`
- Validate all inputs
- Use Firebase security rules
- Check permissions before data access
- No sensitive data in client code

## Getting Help

- Check existing issues and PRs
- Read the documentation
- Ask questions in discussions
- Contact the development team

## Code of Conduct

Be respectful and professional:
- Use inclusive language
- Provide constructive feedback
- Help others learn
- Follow GitHub's CoC

---

Thank you for contributing to SFPCA! Your efforts help us care for animals in need.
