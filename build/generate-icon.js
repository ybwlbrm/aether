const fs = require('fs');
const path = require('path');

const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="256" height="256" viewBox="0 0 256 256">
  <defs>
    <linearGradient id="g" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#0071e3"/>
      <stop offset="100%" stop-color="#40a9ff"/>
    </linearGradient>
  </defs>
  <rect width="256" height="256" rx="52" fill="url(#g)"/>
  <text x="128" y="160" font-family="Arial" font-size="120" font-weight="bold" fill="white" text-anchor="middle">AI</text>
</svg>`;

const svgPath = path.join(__dirname, 'icon.svg');
fs.writeFileSync(svgPath, svg);
console.log('Icon SVG created:', svgPath);