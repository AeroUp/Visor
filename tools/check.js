'use strict';
// Pre-release checks (CI runs these): syntax, no HTML injection in the overlay UI,
// icons present, and the release tag matches package.json.
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const pkg = require('../package.json');
let failed = 0;
const fail = (msg) => {
  console.error(`✖ ${msg}`);
  failed++;
};

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (e.name.endsWith('.js')) out.push(p);
  }
  return out;
}

const files = [...walk(path.join(ROOT, 'src')), ...walk(path.join(ROOT, 'tools'))];
for (const f of files) {
  try {
    execFileSync(process.execPath, ['--check', f], { stdio: 'inherit' });
  } catch (e) {
    fail(`syntax check failed for ${path.relative(ROOT, f)}: ${e.code || e.message}`);
  }
}
if (!failed) console.log(`✔ syntax (${files.length} files)`);

// Chat messages, game names etc. come from other people: they must only ever reach the DOM as text.
for (const f of walk(path.join(ROOT, 'src', 'renderer'))) {
  fs.readFileSync(f, 'utf8').split('\n').forEach((line, i) => {
    if (/(innerHTML|outerHTML|insertAdjacentHTML)\s*=|insertAdjacentHTML\(|document\.write/.test(line) && !/FL\.svg\(/.test(line)) {
      fail(`${path.relative(ROOT, f)}:${i + 1} sets HTML from a non-icon value: ${line.trim()}`);
    }
  });
}
console.log('✔ renderer only inserts trusted icon markup as HTML');

for (const a of ['assets/icon.ico', 'assets/icon.png', 'assets/logo.svg']) {
  if (!fs.existsSync(path.join(ROOT, a))) fail(`missing ${a}`);
}
console.log('✔ icons present');

const tag = process.env.GITHUB_REF_TYPE === 'tag' ? process.env.GITHUB_REF_NAME : null;
if (tag && tag !== `v${pkg.version}`) fail(`tag ${tag} doesn't match package.json version ${pkg.version}`);

process.exitCode = failed ? 1 : 0;
if (!failed) console.log('all checks passed');
