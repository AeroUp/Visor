'use strict';
// Renders assets/logo.svg into every icon Visor ships with:
//   assets/icon.ico  (16-256 px, exe + shortcuts + tray)
//   assets/icon.png  (256 px, window icon)
//   assets/logo.png  (512 px, README)
//   docs/social.png  (1280x640, GitHub social preview / Discord embeds) if docs/screenshot.png exists
const fs = require('fs');
const path = require('path');
const { Resvg } = require('@resvg/resvg-js');

const ROOT = path.join(__dirname, '..');
const asset = (...p) => path.join(ROOT, ...p);
const logo = fs.readFileSync(asset('assets', 'logo.svg'), 'utf8');

const png = (svg, width) =>
  new Resvg(svg, { fitTo: { mode: 'width', value: width }, font: { loadSystemFonts: true, defaultFontFamily: 'Segoe UI' } }).render().asPng();

// ICO with PNG-compressed images (supported by Windows Vista and later).
function ico(images) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(images.length, 4);
  const dir = Buffer.alloc(16 * images.length);
  let offset = 6 + dir.length;
  images.forEach(({ size, data }, i) => {
    const o = i * 16;
    dir.writeUInt8(size >= 256 ? 0 : size, o);
    dir.writeUInt8(size >= 256 ? 0 : size, o + 1);
    dir.writeUInt16LE(1, o + 4); // planes
    dir.writeUInt16LE(32, o + 6); // bits per pixel
    dir.writeUInt32LE(data.length, o + 8);
    dir.writeUInt32LE(offset, o + 12);
    offset += data.length;
  });
  return Buffer.concat([header, dir, ...images.map((im) => im.data)]);
}

const sizes = [16, 20, 24, 32, 40, 48, 64, 128, 256];
fs.writeFileSync(asset('assets', 'icon.ico'), ico(sizes.map((size) => ({ size, data: png(logo, size) }))));
fs.writeFileSync(asset('assets', 'icon.png'), png(logo, 256));
fs.writeFileSync(asset('assets', 'logo.png'), png(logo, 512));
console.log('wrote assets/icon.ico, icon.png, logo.png');

const shot = asset('docs', 'screenshot.png');
if (fs.existsSync(shot)) {
  const inner = logo.replace(/^<svg[^>]*>/, '').replace(/<\/svg>\s*$/, '').replace(/<title>.*?<\/title>/, '');
  const b64 = fs.readFileSync(shot).toString('base64');
  const social = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1280 640" width="1280" height="640">
  <defs>
    <radialGradient id="sg" cx="0.22" cy="0.45" r="0.6"><stop offset="0" stop-color="#4ade80" stop-opacity="0.16"/><stop offset="1" stop-color="#4ade80" stop-opacity="0"/></radialGradient>
    <clipPath id="clip"><rect x="600" y="104" width="640" height="360" rx="18"/></clipPath>
  </defs>
  <rect width="1280" height="640" fill="#0b0d0c"/>
  <rect width="1280" height="640" fill="url(#sg)"/>
  <g transform="translate(72 150) scale(0.3125)">${inner}</g>
  <text x="72" y="388" font-family="Segoe UI" font-weight="700" font-size="96" fill="#f4f4f5">Visor</text>
  <text x="76" y="440" font-family="Segoe UI" font-size="30" fill="#a1a1aa">The in-game overlay for Roblox</text>
  <text x="76" y="512" font-family="Segoe UI" font-size="22" fill="#4ade80">server hop · badges · game history · multi-account</text>
  <rect x="596" y="100" width="648" height="368" rx="22" fill="#4ade80" fill-opacity="0.18"/>
  <image x="600" y="104" width="640" height="360" preserveAspectRatio="xMidYMid slice" clip-path="url(#clip)" href="data:image/png;base64,${b64}"/>
  <text x="600" y="540" font-family="Segoe UI" font-size="20" fill="#6b6b73">free · open source · github.com/AeroUp/Visor</text>
</svg>`;
  fs.writeFileSync(asset('docs', 'social.png'), png(social, 1280));
  console.log('wrote docs/social.png');
}
