# Security Policy

## Supported Versions

| Version | Supported          |
|---------|--------------------|
| 1.0.x   | ✅ Current         |

## Reporting a Vulnerability

If you discover a security vulnerability, please report it privately before disclosing it publicly.

### Contact Information

- Email: sfpcasaba@gmail.com
- Or contact the development team through private channels

### What to Include

- Type of vulnerability
- Steps to reproduce
- Potential impact
- Any screenshots or logs (if applicable)

## Security Measures

### Authentication & Authorization

- **Verified Identity**: Admin access requires a verified Firebase Auth
  email (Google OAuth or verified email/password)
- **Allowlist System**: Only identities in the `admins` collection can
  access admin areas and write privileged data
- **Session Management**: HTTP-only cookies with secure configuration
- **Middleware Protection**: All admin routes protected at the edge

### Data Protection

- **Firestore Security Rules**: Server-side enforcement of data access
- **Input Validation**: All form inputs validated on both client and server
- **TypeScript**: Type safety prevents many classes of vulnerabilities
- **No Direct Database Access**: All database operations go through Firebase SDK

### Best Practices

- **Environment Variables**: All secrets stored in environment variables
- **HTTPS Only**: Production enforces HTTPS
- **CORS Configured**: Proper cross-origin resource sharing settings
- **No Raw HTML**: Admin interfaces use structured fields, not raw HTML editing
- **Dependency Updates**: Regular security updates for all dependencies

## Secrets Management

- **Never commit** real credentials to any file. Only `.env.example` files
  (root and `functions/`) are committed, and they must contain placeholders
  only.
- `.gitignore` ignores all `.env*` files and `*-firebase-adminsdk-*.json`
  service-account downloads. Do not weaken these patterns.
- **Secret values** (never commit): `FIREBASE_ADMIN_PRIVATE_KEY`,
  `FIREBASE_ADMIN_CLIENT_EMAIL`, `VERCEL_TOKEN`, `ADMIN_EMAILS` contents,
  session cookies, and any service-account JSON.
- **Public config, not secrets**: `NEXT_PUBLIC_FIREBASE_*` values and
  `NEXT_PUBLIC_GA_ID` are shipped to browsers by design — they identify the
  project but grant no access (Firestore/Storage rules enforce that).
- Production secrets live in Vercel environment variables / Firebase
  config, never in the repository. CI runs credential-free with clearly
  fake placeholder values.
- If a real credential is ever committed: rotate it immediately, then
  coordinate history cleanup — do not force-push without team approval.

## Dependency Maintenance

- **Dependabot** (`.github/dependabot.yml`) opens weekly grouped PRs for
  minor/patch updates in the root and `functions/` npm trees plus GitHub
  Actions. Major upgrades open individually for review.
- Audit both trees periodically:

  ```bash
  npm audit            # root, full tree
  npm audit --omit=dev # root, production only
  cd functions && npm audit            # functions, full tree
  cd functions && npm audit --omit=dev # functions, production only
  ```

- Apply `npm audit fix` for low-risk patches only — never
  `npm audit fix --force` without analyzing each major upgrade.
- Known unresolved items are tracked in GitHub issues (e.g., the
  `firebase-admin` 13→14 major upgrade for moderate transitive advisories).

## CI Security Controls

- All GitHub Actions are pinned to immutable commit SHAs.
- Workflow permissions are least privilege (`contents: read`).
- PR checks require no secrets; the build uses placeholder public env vars.
- Firebase security rules are tested against the emulator suite on every PR.

## Admin Security Checklist

### For Administrators

- [ ] Use strong, unique Google passwords
- [ ] Enable 2FA on Google accounts
- [ ] Log out when finished
- [ ] Don't share credentials
- [ ] Report suspicious activity immediately

### For Developers

- [ ] Review security rules before deployment
- [ ] Never commit `.env.local` files
- [ ] Use `npm audit` regularly
- [ ] Keep dependencies updated
- [ ] Review Firebase console for unusual activity

## Known Limitations

1. **Single Factor Auth**: Currently only uses Google OAuth (no 2FA in app)
2. **Session Duration**: Sessions last 14 days (configurable)
3. **No Audit Logs**: Admin actions are not currently logged

## Future Security Enhancements

- [ ] Add audit logging for admin actions
- [ ] Implement shorter session durations
- [ ] Add IP-based restrictions
- [ ] Implement rate limiting
- [ ] Add security headers (CSP, HSTS)

---

This security policy is part of our commitment to maintaining a safe and secure platform for SFPCA operations.
