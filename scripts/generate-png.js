const sharp = require('sharp');
const path = require('path');

const inputPath = path.join(__dirname, '..', 'assets', 'icon.svg');
const outputPath = path.join(__dirname, '..', 'assets', 'icon.png');

sharp(inputPath)
  .resize(512, 512)
  .png()
  .toFile(outputPath)
  .then(() => console.log('Generated icon.png (512x512)'))
  .catch(err => console.error('Error:', err));
