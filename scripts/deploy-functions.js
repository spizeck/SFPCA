const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

// Colors for console output
const colors = {
  reset: '\x1b[0m',
  bright: '\x1b[1m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  magenta: '\x1b[35m',
  cyan: '\x1b[36m',
};

function log(message, color = 'reset') {
  console.log(`${colors[color]}${message}${colors.reset}`);
}

function checkEnvFile() {
  const envPath = path.join(__dirname, '../functions/.env');
  if (!fs.existsSync(envPath)) {
    log('\n❌ Error: .env file not found in functions directory!', 'red');
    log('\nPlease create a .env file with the following variables:', 'yellow');
    log('  VERCEL_TOKEN=your_vercel_token_here', 'cyan');
    log('  VERCEL_PROJECT_ID=your_vercel_project_id_here', 'cyan');
    log('  GITHUB_TOKEN=your_github_token_here', 'cyan');
    log('\nSee functions/README.md for detailed instructions.', 'yellow');
    process.exit(1);
  }

  // Check if all required variables are set
  const envContent = fs.readFileSync(envPath, 'utf8');
  const requiredVars = ['VERCEL_TOKEN', 'VERCEL_PROJECT_ID', 'GITHUB_TOKEN'];
  
  for (const varName of requiredVars) {
    if (!envContent.includes(`${varName}=`) || envContent.includes(`${varName}=your_`)) {
      log(`\n❌ Error: ${varName} is not configured in functions/.env`, 'red');
      process.exit(1);
    }
  }
}

function deployFunctions() {
  log('\n🚀 Deploying Firebase Cloud Functions...', 'bright');
  
  try {
    // Check environment variables
    checkEnvFile();
    
    // Deploy functions
    log('\n📦 Installing dependencies...', 'blue');
    execSync('cd functions && npm install', { stdio: 'inherit' });
    
    log('\n🔥 Deploying functions to Firebase...', 'blue');
    execSync('firebase deploy --only functions', { stdio: 'inherit' });
    
    log('\n✅ Functions deployed successfully!', 'green');
    log('\n📝 Next steps:', 'yellow');
    log('1. Test the functions by updating any document in Firestore', 'cyan');
    log('2. Check the function logs with: firebase functions:log', 'cyan');
    log('3. Verify the Vercel rebuild and GitHub merge occur automatically', 'cyan');
    
  } catch (error) {
    log(`\n❌ Deployment failed: ${error.message}`, 'red');
    process.exit(1);
  }
}

// Run deployment
deployFunctions();
