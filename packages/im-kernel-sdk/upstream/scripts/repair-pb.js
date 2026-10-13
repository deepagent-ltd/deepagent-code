let fs = require('fs');
let path = require('path');

let url = path.resolve(__dirname, '../src/socket/proto.js');
let content = fs.readFileSync(url, 'utf-8');
content = content.replace('import * as $protobuf from "protobufjs/light";', 'import $protobuf from "../3rd/protobuf";');
fs.writeFileSync(url, content);
console.log('build protobuf successfully.')