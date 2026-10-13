let path = require('path');
let { execSync } = require('child_process');
let { version } = require('../package.json');

let cmd = `cd dist && zip juggleim-web-${version}.zip -r ./`;
execSync(cmd);