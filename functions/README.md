# Firebase Cloud Functions

This directory contains Firebase Cloud Functions that trigger Vercel rebuilds when Firestore data is updated.

## Functions

### 1. onFirestoreChange
- **Trigger**: Document write/update/delete in a *content* collection
  (`homepage`, `siteSettings`, `animals`, `faq`, `vetServices`,
  `animalAdoptions`, `animalRegistration` — the `REBUILD_COLLECTIONS`
  set in `index.js`). Writes to `animalRegistrations` and `admins`
  trigger nothing.
- **Action**: Triggers a rebuild on Vercel
- **Smart Detection**: Skips rebuild if no actual data change occurred

### 2. triggerRebuild
- **Trigger**: HTTP request
- **URL**: `https://[region]-[project-id].cloudfunctions.net/triggerRebuild`
- **Action**: Manually triggers a Vercel rebuild
- **Authorization**: requires `Authorization: Bearer <REBUILD_TRIGGER_TOKEN>`.
  When `REBUILD_TRIGGER_TOKEN` is not configured the endpoint refuses all
  requests (fails closed).

(The old `sweepOrphanedReceipts` Cloud Function was retired in #183 —
orphan cleanup is now the Vercel cron route `/api/cron/sweep-receipts`.)

## Setup

### 1. Install Dependencies
```bash
cd functions
npm install
```

### 2. Configure Environment Variables
Copy `.env.example` to `.env` and fill in your credentials:

```bash
cp .env.example .env
```

Edit `.env` with your actual values:

```env
# Vercel Configuration
VERCEL_TOKEN=your_vercel_token_here
VERCEL_PROJECT_ID=your_vercel_project_id_here
# Shared secret for the manual trigger endpoint
REBUILD_TRIGGER_TOKEN=your_random_secret_here
```

#### Getting Your Credentials

**Vercel Token:**
1. Go to [Vercel Account Settings → Tokens](https://vercel.com/account/tokens)
2. Create a new token
3. Copy the token

**Vercel Project ID:**
1. Go to your project's dashboard on Vercel
2. Go to Settings → General
3. Copy the Project ID (it starts with `prj_`)

### 3. Deploy Functions
```bash
npm run deploy
```

Or use the deployment script from the repo root:
```bash
npm run deploy:functions
```

Both route through the repo's 60-second discovery-timeout override —
a bare `firebase deploy` bypasses it; see Troubleshooting #4.

## Usage

### Automatic Trigger
The function will automatically trigger a Vercel rebuild whenever a document in a content collection is created, updated, or deleted (with actual data changes). Private submission (`animalRegistrations`) and `admins` writes are ignored — see `REBUILD_COLLECTIONS` in `index.js`.

### Manual Trigger
You can manually trigger a rebuild by calling the triggerRebuild function
with the shared secret:
```bash
curl -H "Authorization: Bearer $REBUILD_TRIGGER_TOKEN" \
  https://[region]-[project-id].cloudfunctions.net/triggerRebuild
```

## Security Notes

- Never commit your `.env` file to version control
- Keep your Vercel token secure and rotate it regularly
- The function only needs Vercel permissions - no GitHub access required

## Troubleshooting

### Common Issues

1. **Vercel rebuild not triggering**
   - Check that VERCEL_TOKEN and VERCEL_PROJECT_ID are correct
   - Ensure the Vercel token has the necessary permissions
   - Check the function logs: `firebase functions:log`

2. **Too many rebuilds**
   - The function includes smart detection to skip rebuilds when data hasn't actually changed
   - Check logs to see if "No actual data change detected" messages appear

3. **Function deployment errors**
   - Run `npm install` in the functions directory
   - Check that all dependencies are installed
   - Review the Firebase console for detailed error messages

4. **`User code failed to load. Cannot determine backend specification.
   Timeout after 10000`**
   - Cold filesystem/AV scan of `node_modules` exceeds firebase-tools'
     default 10 s discovery deadline — environmental, not a code bug.
     Retrying once usually works (warm cache).
   - The `serve`/`shell`/`deploy` scripts here run through
     `scripts/firebase-cli.mjs`, which sets the supported
     `FUNCTIONS_DISCOVERY_TIMEOUT=60` override; `npm run
     deploy:functions` sets it too.
   - Bare `firebase …` and `npx firebase …` calls bypass the wrapper
     and keep the 10 s default. For any direct invocation that loads
     the functions code (`deploy`, `emulators:start`,
     `functions:shell`), either route it through the wrapper —
     `node ../scripts/firebase-cli.mjs <args>` from this directory —
     or set the variable yourself:

     ```bash
     FUNCTIONS_DISCOVERY_TIMEOUT=60 firebase deploy --only functions   # bash/zsh
     $env:FUNCTIONS_DISCOVERY_TIMEOUT=60                                # PowerShell — then run the command
     ```
   - Persisting slowness is diagnosed in RUNBOOK §7a; a module-count
     guard (`test/discovery-load.test.js`) keeps heavyweight top-level
     imports from reintroducing the problem.

### Viewing Logs
```bash
# View all logs
firebase functions:log

# View logs for a specific function
firebase functions:log --only onFirestoreChange
```
