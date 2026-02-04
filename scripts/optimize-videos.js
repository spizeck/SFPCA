const fs = require('fs');
const path = require('path');

// Video optimization recommendations based on current file sizes
const videos = [
  { name: 'adoption.mp4', currentSize: 49.6, recommended: '15-20MB' },
  { name: 'catbag.mp4', currentSize: 19.3, recommended: '8-12MB' },
  { name: 'herocat.mp4', currentSize: 9.5, recommended: '4-6MB' },
  { name: 'vetdog.mp4', currentSize: 23.4, recommended: '10-15MB' }
];

console.log('🎬 Video Optimization Recommendations\n');
console.log('Current file sizes and targets:\n');

videos.forEach(video => {
  const savings = video.currentSize - parseFloat(video.recommended.split('-')[1]);
  console.log(`${video.name}:`);
  console.log(`  Current: ${video.currentSize}MB`);
  console.log(`  Target: ${video.recommended}`);
  console.log(`  Potential savings: ~${savings.toFixed(1)}MB\n`);
});

console.log('📝 FFmpeg Commands:\n');

videos.forEach(video => {
  console.log(`# Optimize ${video.name}`);
  console.log(`ffmpeg -i videos/${video.name} \\`);
  console.log(`  -c:v libx264 -crf 30 -preset medium \\`);
  console.log(`  -c:a aac -b:a 96k \\`);
  console.log(`  -movflags +faststart \\`);
  console.log(`  videos/${video.name.replace('.mp4', '_optimized.mp4')}\n`);
});

console.log('💡 Additional Tips:');
console.log('- Use CRF 18-28 for good quality (lower = better quality)');
console.log('- Use -preset fast for faster encoding');
console.log('- Add -movflags +faststart for web streaming');
console.log('- Consider creating WebM versions for even smaller sizes');
console.log('- Test different CRF values to find the right balance');
