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
- **Allowlist System**: Only identities in the `admins` collection (or
  the `ADMIN_EMAILS` bootstrap env, reconciled into `admins` at session
  creation) can access admin areas and write privileged data. The env
  allowlist is matched case-insensitively; the `admins` document ID is
  the exact token email (the security rules key on it verbatim)
- **Session Management**: HTTP-only session cookies (5-day expiry),
  `secure` in production, `sameSite=Lax`, revocation-checked on every
  verification. Logout clears the cookie with matching attributes; it
  does not revoke the underlying Firebase session — the 5-day cookie
  expiry is the bound
- **CSRF posture**: The session endpoint rejects mutating requests whose
  `Origin` header doesn't match the request host, so cross-site POSTs
  can't plant a session and cross-site DELETEs can't force a logout.
  Next.js Server Actions enforce their own origin checks
- **Layered Protection**: The edge proxy redirects `/admin` requests
  without a session cookie to `/login`; the authoritative check is
  server-side `requireAdmin()` in the admin layout, which re-verifies
  the cookie and the `admins` collection on every request
- **Privileged server actions**: Every `use server` export self-checks
  `requireAdmin()` — the admin UI being unreachable by non-admins is
  never treated as the boundary
- **Roles**: `admins/<email>` docs carry a `role` field (`admin` /
  `editor`, env-bootstrapped admins get `admin`). No code path currently
  distinguishes roles — authorization is binary admin/non-admin
- **Functions**: `triggerRebuild` (manual HTTP rebuild) requires
  `Authorization: Bearer <REBUILD_TRIGGER_TOKEN>` and refuses all
  requests when the token is unconfigured. `onFirestoreChange` is
  event-driven and needs no request authorization

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
  npm audit                            # root, full tree
  npm audit --omit=dev                 # root, production only
  (cd functions && npm audit)          # functions, full tree
  (cd functions && npm audit --omit=dev)  # functions, production only
  ```

- Apply `npm audit fix` for low-risk patches only — never
  `npm audit fix --force` without analyzing each major upgrade.
- Known unresolved items are tracked in GitHub issues (see #110 for the
  moderate transitive advisories that remain upstream-blocked in the
  `firebase-tools` dev chain and `@google-cloud/storage`'s `gaxios`/`uuid`).

## CI Security Controls

- All GitHub Actions are pinned to immutable commit SHAs.
- Workflow permissions are least privilege (`contents: read`).
- PR checks require no secrets; the build uses placeholder public env vars.
- Firebase security rules are tested against the emulator suite on every PR.

## Admin Security Checklist

### For Administrators

- [ ] Use strong, unique passwords (Google or email/password accounts)
- [ ] Enable 2FA where the provider supports it
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

1. **Single Factor Auth**: No in-app 2FA (Google OAuth or verified
   email/password; provider-level 2FA is up to the account)
2. **Session Duration**: Sessions last 5 days (set in
   `src/app/api/auth/session/route.ts`)
3. **No Audit Logs**: Admin actions are not currently logged

## Future Security Enhancements

- [ ] Add audit logging for admin actions
- [ ] Implement shorter session durations
- [ ] Add IP-based restrictions
- [ ] Implement rate limiting
- [ ] Add security headers (CSP, HSTS)

---

This security policy is part of our commitment to maintaining a safe and secure platform for SFPCA operations.
