let fs = require('fs');
let path = require('path');
let { exec, execSync } = require('child_process');
let { version } = require('../package.json');

let pkg = `
{
  "name": "jugglechat-websdk",
  "version": "${version}",
  "description": "JuggleChat SDK, IM, Chat",
  "main": "index.js",
  "types": "index.d.ts",
  "scripts": { },
  "author": "sxiaomahou"
}
`;
let readme = `

### JuggleChat Web SDK

官网: [https://juggle.im/](https://juggle.im/)

`;

let dir = path.join(__dirname, '../', 'release');
if(!fs.existsSync(dir)){
  fs.mkdirSync(dir);
}

// 移动 SDK
let url = `dist/juggleim-es-min-${version}.js`;
let cmd = `cp ${url} ${dir}/index.js`;
execSync(cmd);

// 移动 d.ts
url = `src/index.d.ts`;
cmd = `cp ${url} ${dir}/index.d.ts`;
execSync(cmd);

// 写入 package.json
fs.writeFileSync(`${dir}/package.json`, pkg);

// 写入 README.md
fs.writeFileSync(`${dir}/README.md`, readme);