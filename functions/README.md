# Firebase Cloud Functions

This directory contains Firebase Cloud Functions that trigger Vercel rebuilds when Firestore data is updated.

## Functions

### 1. onFirestoreChange
- **Trigger**: Any document write/update/delete in Firestore
- **Action**: Triggers a rebuild on Vercel
- **Smart Detection**: Skips rebuild if no actual data change occurred

### 2. triggerRebuild
- **Trigger**: HTTP request
- **URL**: `https://[region]-[project-id].cloudfunctions.net/triggerRebuild`
- **Action**: Manually triggers a Vercel rebuild

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
firebase deploy --only functions
```

Or use the deployment script:
```bash
npm run deploy:functions
```

## Usage

### Automatic Trigger
The function will automatically trigger a Vercel rebuild whenever any document in Firestore is created, updated, or deleted (with actual data changes).

### Manual Trigger
You can manually trigger a rebuild by making a GET request to the triggerRebuild function:
```bash
curl https://[region]-[project-id].cloudfunctions.net/triggerRebuild
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

### Viewing Logs
```bash
# View all logs
firebase functions:log

# View logs for a specific function
firebase functions:log --only onFirestoreChange
```
