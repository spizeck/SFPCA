# Firebase Cloud Functions

This directory contains Firebase Cloud Functions that automate deployment tasks for the SFPCA website.

## Functions

### 1. onFirestoreWrite
- **Trigger**: Any document write/update/delete in Firestore
- **Actions**:
  - Triggers a rebuild on Vercel
  - Merges the `dev` branch to `main` on GitHub

### 2. triggerDeployment
- **Trigger**: HTTP request
- **URL**: `https://[region]-[project-id].cloudfunctions.net/triggerDeployment`
- **Actions**: Same as onFirestoreWrite but can be triggered manually

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

# GitHub Configuration
GITHUB_TOKEN=your_github_token_here
```

#### Getting Your Credentials

**Vercel Token:**
1. Go to [Vercel Account Settings](https://vercel.com/account/tokens)
2. Create a new token
3. Copy the token

**Vercel Project ID:**
1. Go to your project's dashboard on Vercel
2. Go to Settings → General
3. Copy the Project ID

**GitHub Token:**
1. Go to [GitHub Settings → Developer settings → Personal access tokens](https://github.com/settings/tokens)
2. Generate new token (classic)
3. Select `repo` permissions
4. Copy the token

### 3. Deploy Functions
```bash
firebase deploy --only functions
```

## Usage

### Automatic Trigger
The functions will automatically trigger whenever any document in Firestore is created, updated, or deleted.

### Manual Trigger
You can manually trigger the deployment by making a GET request to the triggerDeployment function:
```bash
curl https://[region]-[project-id].cloudfunctions.net/triggerDeployment
```

## Security Notes

- Never commit your `.env` file to version control
- Keep your tokens secure and rotate them regularly
- The GitHub token needs `repo` permissions to create and merge pull requests
- Consider using a separate GitHub account with limited permissions for automation

## Troubleshooting

### Common Issues

1. **Vercel rebuild not triggering**
   - Check that VERCEL_TOKEN and VERCEL_PROJECT_ID are correct
   - Ensure the Vercel token has the necessary permissions
   - Check the function logs: `firebase functions:log`

2. **GitHub merge failing**
   - Verify GITHUB_TOKEN is correct and has `repo` permissions
   - Check if there are merge conflicts preventing the merge
   - Ensure the GitHub repository allows automated merges

3. **Function deployment errors**
   - Run `npm install` in the functions directory
   - Check that all dependencies are installed
   - Review the Firebase console for detailed error messages

### Viewing Logs
```bash
# View all logs
firebase functions:log

# View logs for a specific function
firebase functions:log --only onFirestoreWrite
```
