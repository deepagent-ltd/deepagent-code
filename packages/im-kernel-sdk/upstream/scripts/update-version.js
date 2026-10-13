let fs = require('fs');
let path = require('path');
let { execSync } = require('child_process');
let { version } = require('../package.json');

let dir = path.join(__dirname, '../', 'src', 'socket', 'version.js');
let str = `
export let VERSION = '${version}';
`;
fs.writeFileSync(dir, str);