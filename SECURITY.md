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

- **Google OAuth**: All admin access requires Google authentication
- **Allowlist System**: Only pre-approved emails can access admin areas
- **Role-Based Access**: Two roles (admin, editor) with appropriate permissions
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
