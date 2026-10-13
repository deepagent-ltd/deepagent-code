import babel from 'rollup-plugin-babel';
import minify from 'rollup-plugin-babel-minify';
import json from '@rollup/plugin-json';
import utils from '../src/utils';
require("dotenv").config();

const {version} = require('../package.json');
const fullYear = new Date().getFullYear();

const banner = [
  '/*', 
  `* ${process.env.PACKAGE_NAME}.js v${version}`, 
  `* (c) 2022-${fullYear} ${process.env.PACKAGE_NAME}`,
  '* Released under the MIT License.',
  '*/'].join('\n');

const getTarget = function(type){
  type = type || '';
  return `dist/${process.env.PACKAGE_NAME.toLowerCase()}-${type}-${version}.js`;
};

const genConfig = function(type){
  return {
    input: 'src/index.js',
    output: {
      file: getTarget(type),
      format: 'umd',
      name: process.env.PACKAGE_NAME,
      globals: {
        "$protobuf": "protobufjs/minimal"
      }
    },
    plugins: [
      json(),
      babel({
        exclude: 'node_modules/**'
      })
    ]
  }
};

const configs = {
  min: () => {
    let config = genConfig('min');
    return utils.extend(config, {
      plugins: [ 
        minify({
          banner,
          removeConsole: true,
          simplifyComparisons: false
        }),
        babel({
          exclude: 'node_modules/**'
        })
      ]
    })
  },
  dev: () => {
    let config = genConfig('dev');
    utils.extend(config.output, {
      banner
    });
    return config;
  },
  es: () => {
    let config = genConfig('es');
    const format = 'es';
    utils.extend(config.output, {
      banner,
      format
    });
    return config;
  },
  es_min: () => {
    let config = genConfig('es-min');
    const format = 'es';
    utils.extend(config.output, {
      banner,
      format,
      plugins: [ 
        minify({
          removeConsole: true,
          simplifyComparisons: false
        }),
        babel({
          exclude: 'node_modules/**'
        })
      ]
    });
    return config;
  }
};

module.exports = configs[process.env.TAG]()