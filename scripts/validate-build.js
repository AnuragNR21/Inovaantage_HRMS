const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const roots = ['server', path.join('public', 'js'), 'scripts', 'test'];
const files = [];

function walk(directory) {
  if (!fs.existsSync(directory)) return;
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) walk(fullPath);
    else if (entry.isFile() && fullPath.endsWith('.js')) files.push(fullPath);
  }
}

roots.forEach(walk);
files.forEach((file) => execFileSync(process.execPath, ['--check', file], { stdio: 'inherit' }));
console.log(`Validated ${files.length} JavaScript files. No frontend compilation is required.`);
