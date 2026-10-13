const noop = () => { };
const isObject = (obj) => {
  return Object.prototype.toString.call(obj) === '[object Object]';
};
const isArray = (arr) => {
  return Object.prototype.toString.call(arr) === '[object Array]';
};
const isFunction = (arr) => {
  return Object.prototype.toString.call(arr) === '[object Function]';
};
const isAsyncFunction = (arr) => {
  return Object.prototype.toString.call(arr) === '[object AsyncFunction]';
};
const isString = (str) => {
  return Object.prototype.toString.call(str) === '[object String]';
};
const isBoolean = (str) => {
  return Object.prototype.toString.call(str) === '[object Boolean]';
};
const isFile = (str) => {
  return Object.prototype.toString.call(str) === '[object File]';
};
const isUndefined = (str) => {
  return Object.prototype.toString.call(str) === '[object Undefined]';
};
const isNull = (str) => {
  return Object.prototype.toString.call(str) === '[object Null]';
};
const isNumber = (str) => {
  return Object.prototype.toString.call(str) === '[object Number]';
};
const _isNaN = (str) => {
  return isNaN(Number(str));
};
const stringify = (obj) => {
  return JSON.stringify(obj);
};
const parse = (str) => {
  let obj = {};
  try{
    obj = JSON.parse(str); 
  }catch(e){
    obj = str;
  }
  return obj;
};
const forEach = (obj, callback) => {
  callback = callback || noop;
  let loopObj = () => {
    for (var key in obj) {
      callback(obj[key], key, obj);
    }
  };
  var loopArr = () => {
    for (var i = 0, len = obj.length; i < len; i++) {
      callback(obj[i], i, obj);
    }
  };
  if (isObject(obj)) {
    loopObj();
  }
  if (isArray(obj)) {
    loopArr();
  }
};
const isEmpty = (obj) => {
  let result = true;
  if (isObject(obj)) {
    forEach(obj, () => {
      result = false;
    });
  }
  if (isString(obj) || isArray(obj)) {
    result = obj.length === 0;
  }
  if (isNumber(obj)) {
    result = obj === -1;
  }
  return result;
};
const rename = (origin, newNames) => {
  var isObj = isObject(origin);
  if (isObj) {
    origin = [origin];
  }
  origin = parse(stringify(origin));
  var updateProperty = function (val, key, obj) {
    delete obj[key];
    key = newNames[key];
    obj[key] = val;
  };
  forEach(origin, (item) => {
    forEach(item, (val, key, obj) => {
      var isRename = (key in newNames);
      (isRename ? updateProperty : noop)(val, key, obj);
    });
  });
  return isObject ? origin[0] : origin;
};
const extend = (destination, sources) => {
  sources = isArray(sources) ? sources : [sources];
  forEach(sources, (source) => {
    for (let key in source) {
      let value = source[key];
      if (!isUndefined(value)) {
        destination[key] = value;
      }
    }
  });
  return destination;
};
const Defer = Promise;
const deferred = (callback) => {
  return new Defer(callback);
};
const templateFormat = (tpl, data, regexp) => {
  if (!(isArray(data))) {
    data = [data];
  }
  let ret = [];
  let replaceAction = (object) => {
    return tpl.replace(regexp || (/\\?\{([^}]+)\}/g), (match, name) => {
      if (match.charAt(0) === '\\') return match.slice(1);
      return (object[name] !== undefined) ? object[name] : '{' + name + '}';
    });
  };
  for (let i = 0, j = data.length; i < j; i++) {
    ret.push(replaceAction(data[i]));
  }
  return ret.join('');
};
// 暂时支持 String
const isContain = (str, keyword) => {
  return str.indexOf(keyword) > -1;
};
const isEqual = (source, target) => {
  return source === target;
};
const Cache = (cache) => {
  if (!isObject(cache)) {
    cache = {};
  }
  let set = (key, value) => {
    cache[key] = value;
  };
  let get = (key) => {
    return cache[key];
  };
  let remove = (key) => {
    delete cache[key];
  };
  let getKeys = () => {
    let keys = [];
    for (let key in cache) {
      keys.push(key);
    }
    return keys;
  };
  let clear = () => {
    cache = {};
  };
  return {
    set,
    get,
    remove,
    getKeys,
    clear
  };
};

const map = (arrs, callback) => {
  return arrs.map(callback);
};
const filter = (arrs, callback) => {
  return arrs.filter(callback);
};
const uniq = (arrs, callback) => {
  let newData = [], tempData = {};
  arrs.forEach(target => {
    let temp = callback(target);
    tempData[temp.key] = temp.value;
  });
  forEach(tempData, (val) => {
    newData.push(val);
  })
  return newData;
};
const some = (arrs, callback) => {
  return arrs.some(callback);
};
const toJSON = (value) => {
  return JSON.stringify(value);
}
const toArray = (obj) => {
  let arrs = [];
  forEach(obj, (v, k) => {
    arrs.push([k, v]);
  });
  return arrs;
};

const isInclude = (str, match) => {
  return str.indexOf(match) > -1;
};
const clone = (source) => {
  return JSON.parse(JSON.stringify(source));
};
function Index() {
  let index = 0;
  this.add = () => {
    index += 1;
  };
  this.get = () => {
    return index;
  }
  this.reset = () => {
    index = 0;
  };
}
function Observer() {
  let observers = [];
  this.add = (observer, force) => {
    if (isFunction(observer)) {
      if (force) {
        return observers = [observer];
      }
      observers.push(observer);
    }
  };
  this.remove = (observer) => {
    observers = filter(observers, (_observer) => {
      return _observer !== observer
    });
  };
  this.emit = (data) => {
    forEach(observers, (observer) => {
      observer(data);
    });
  };
}
function Prosumer() {
  let data = [], isConsuming = false;
  this.produce = (res) => {
    data.push(res);
  };
  this.consume = (callback, finished) => {
    if (isConsuming) {
      return;
    }
    isConsuming = true;
    let next = () => {
      let res = data.shift();
      if (isUndefined(res)) {
        isConsuming = false;
        finished && finished();
        return;
      }
      callback(res, next);
    };
    next();
  };
  this.isExeuting = function () {
    return isConsuming;
  };
}

const getBrowser = () => {
  let userAgent = navigator.userAgent;
  let name = '', version = '';
  if (/(Msie|Firefox|Opera|Chrome|Netscape)\D+(\d[\d.]*)/.test(userAgent)) {
    name = RegExp.$1;
    version = RegExp.$2;
  }
  if (/Version\D+(\d[\d.]*).*Safari/.test(userAgent)) {
    name = 'Safari';
    version = RegExp.$1;
  }
  return {
    name,
    version
  };
};

const getUUID = () => {
  return 'j' + 'xxxx-xxxx-xxxx'.replace(/[xy]/g, function (c) {
    let r = Math.random() * 16 | 0, v = c == 'x' ? r : (r & 0x3 | 0x8);
    return v.toString(16);
  });
};

const getProtocol = (url = '') => {
  if(typeof location == 'undefined'){
    location = { protocol: 'https:' }
  }
  let http = location.protocol;
  if(isEqual(http, 'file:')){
    http = 'http:';
  }
  if(isInclude(url, 'https://') || isInclude(url, 'wss://')){
    http = 'https:';
  }
  let wsMap = {
    'http:': 'ws:',
    'https:': 'wss:'
  };
  let ws = wsMap[http];
  return { http, ws }
};

const sort = (arrs, callback) => {
  const len = arrs.length
	if(len < 2){
    return arrs;
  }
	for (let i = 0; i < len - 1; i++) {
		for (let j = i + 1; j < len; j++) {
			if (callback(arrs[j], arrs[i])) {
				[arrs[i], arrs[j]] = [arrs[j], arrs[i]]
			}
		}
	}
	return arrs
};
const quickSort = (arr, callback) => {
  if (arr.length < 2) {
      return arr;
  }
  let pivot = arr[0];
  let left = [];
  let right = [];
  for (let i = 1; i < arr.length; i++) {
      if (callback(arr[i], pivot)) {
        left.push(arr[i]);
      } else {
        right.push(arr[i]);
      }
  }
  return [...quickSort(left, callback), pivot, ...quickSort(right, callback)];
};
const find = (arrs, callback) => {
  let len = arrs.length;
  let index = -1;
  for(let i = 0; i < len; i++){
    let item = arrs[i];
    if(callback(item)){
      index = i;
      break;
    }
  }
  return index;
};
const toObject = (arrs) => {
  let objs = {};
  forEach(arrs, (item = {}) => {
    let key = item.key;
    let value = item.value;
    objs[key] = value;
  });
  return objs;
};
const decodeBase64 = function (input) {
  let _keyStr = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/=";
  let output = "";
  let chr1, chr2, chr3;
  let enc1, enc2, enc3, enc4;
  let i = 0;

  input = input.replace(/[^A-Za-z0-9\+\/\=]/g, "");

  while (i < input.length) {
    enc1 = _keyStr.indexOf(input.charAt(i++));
    enc2 = _keyStr.indexOf(input.charAt(i++));
    enc3 = _keyStr.indexOf(input.charAt(i++));
    enc4 = _keyStr.indexOf(input.charAt(i++));

    chr1 = (enc1 << 2) | (enc2 >> 4);
    chr2 = ((enc2 & 15) << 4) | (enc3 >> 2);
    chr3 = ((enc3 & 3) << 6) | enc4;

    output += String.fromCharCode(chr1);

    if (enc3 !== 64) {
      output += String.fromCharCode(chr2);
    }
    if (enc4 !== 64) {
      output += String.fromCharCode(chr3);
    }
  }
  output = decodeURIComponent(escape(output));
  return output;
};
const isContinuous = (numbers, key) => {
 numbers.sort((a, b) => {
  return a[key] - b[key];
 });
 for (let i = 0; i < numbers.length - 1; i++) {
    if(!isEmpty(numbers[i + 1][key])){
      if (numbers[i + 1][key] !== numbers[i][key] + 1) {
        return false;
      }
    }
 }
 return true;
};
const isBase64 = (str) => {
  var regex = /^([A-Za-z0-9+/]{4})*([A-Za-z0-9+/]{3}=|[A-Za-z0-9+/]{2}==)?$/;
  return regex.test(str);
};
function iterator(list, callback){
  let next = () => {
    let item = list.splice(0, 1);
    if(isEmpty(item)){
      return;
    }
    let isFinished = isEqual(list.length, 0);
    callback(item[0], next, isFinished);
  };
  next();
}
function formatTime(time, fmt = 'yyyy-MM-dd hh:mm:ss') {
  let date = new Date(time);
  var o = {
    "M+": date.getMonth() + 1, // 月份
    "d+": date.getDate(), // 日
    "h+": date.getHours(), // 小时
    "m+": date.getMinutes(), // 分
    "s+": date.getSeconds(), // 秒
    "q+": Math.floor((date.getMonth() + 3) / 3), // 季度
    "S": date.getMilliseconds() // 毫秒
  };
  if (/(y+)/.test(fmt))
    fmt = fmt.replace(RegExp.$1, (date.getFullYear() + "").substr(4 - RegExp.$1.length));
  for (var k in o)
    if (new RegExp("(" + k + ")").test(fmt)) fmt = fmt.replace(RegExp.$1, (RegExp.$1.length == 1) ? (o[k]) : (("00" + o[k]).substr(("" + o[k]).length)));
  return fmt;
}

function isValidHMTime(timeStr) {
  const regex = /^([01]?[0-9]|2[0-3]):[0-5][0-9]$/;
  return regex.test(timeStr);
}

function getRandoms(len){
  return Array(len).fill(0).map(() => Math.floor(Math.random()*10));
}
// input: groupBy([{a:1},{a:1}, {a:2}], ['a'])
// output: { 1: [{a:1},{a:1}], 2: [{a:2}] }
let groupBy = (arrs, keys) => {
  let obj = {};
  forEach(arrs, (item) => {
    let names = [];
    forEach(item, (v, k) => {
      if(isInclude(keys, k)){
        names.push(v);
      }
    });
    let name = names.join('_');
    let _list = obj[name] || [];
    _list.push(item);
    obj[name] = _list;
  });
  return obj;
};
const getDeviceID = () => {
  return 'xxxxxxxxxxxxxxxxxxxx'.replace(/[xy]/g, function (c) {
    let r = Math.random() * 16 | 0, v = c == 'x' ? r : (r & 0x3 | 0x8);
    return v.toString(16);
  });
};
function formatToQueryStr(obj) {
  return Object.entries(obj)
    .filter(([_, value]) => value !== undefined) // 过滤 undefined
    .map(([key, value]) => {
      // 对键和值进行 URL 编码，处理特殊字符
      const encodedKey = encodeURIComponent(key);
      const encodedValue = encodeURIComponent(value ?? ''); // null 转为空字符串
      return `${encodedKey}=${encodedValue}`;
    })
    .join('&');
}
function max(arr, key) {
  if (!isArray(arr) || arr.length === 0) {
    return arr;
  }
  if (arr.length === 1) {
    return arr[0];
  }
  return arr.reduce((maxItem, currentItem) => {
    const maxVal = Number(maxItem[key]) || 0;
    const currentVal = Number(currentItem[key]) || 0;
    return currentVal > maxVal ? currentItem : maxItem;
  }, arr[0]);
}
function getBrowserVersion(){
  return navigator.appVersion;
}
export default {
  Prosumer,
  Observer,
  isUndefined,
  isBoolean,
  isString,
  isObject,
  isArray,
  isFunction,
  isFile,
  stringify,
  parse,
  rename,
  extend,
  clone,
  deferred,
  Defer,
  forEach,
  templateFormat,
  isContain,
  noop,
  Cache,
  map,
  filter,
  uniq,
  some,
  isEqual,
  isEmpty,
  toJSON,
  isInclude,
  isNull,
  isNumber,
  toArray,
  Index,
  getBrowser,
  getUUID,
  getProtocol,
  sort,
  find,
  quickSort,
  toObject,
  decodeBase64,
  isContinuous,
  isBase64,
  iterator,
  formatTime,
  isValidHMTime,
  getRandoms,
  groupBy,
  isNaN: _isNaN,
  getDeviceID,
  formatToQueryStr,
  isAsyncFunction,
  max,
  getBrowserVersion
}