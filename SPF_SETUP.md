# SPF Record Setup for Email Security

## What is SPF?
Sender Policy Framework (SPF) is an email authentication method that helps prevent spammers from sending emails with forged From addresses from your domain.

## Recommended SPF Record
Add this TXT record to your DNS settings for `sabafpca.com`:

```
v=spf1 include:_spf.google.com ~all
```

## If using Google Workspace/Gmail
```
v=spf1 include:_spf.google.com ~all
```

## If using multiple email services
Combine them like this:
```
v=spf1 include:_spf.google.com include:sendgrid.net ~all
```

## How to Add SPF Record
1. Log into your domain registrar (GoDaddy, Namecheap, etc.)
2. Go to DNS management
3. Add a new TXT record:
   - **Type**: TXT
   - **Host/Name**: @ (or your domain name)
   - **Value**: `v=spf1 include:_spf.google.com ~all`
   - **TTL**: 3600 (1 hour) or default

## Testing SPF
After adding, test with:
- Google Admin Console (if using Workspace)
- MXToolbox SPF Record Tester
- Kitterman SPF Tester

## Notes
- DNS changes can take 24-48 hours to propagate
- Only one SPF record per domain is allowed
- The `~all` means "soft fail" - emails will still be delivered but marked as potentially spam
- Use `-all` for "hard fail" if you want to reject non-authorized emails (may cause legitimate emails to be rejected)
