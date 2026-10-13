import { STORAGE } from "../enum";
import utils from "../utils";
import Cacher from "./cache";
import JStorage from "../provoider/storage/index";

let storageCacher = Cacher();
// 动态设置 storage key 前缀，例如 _appkey_userid_
let _storage_private_prefix_ = '';
let getKey = (key) => {
  return `${STORAGE.PREFIX}_${_storage_private_prefix_}_${key}`;
};

let set = (key, value) => {
  let _key = getKey(key);
  let storage = { data: value};
  storageCacher.set(_key, storage);
  JStorage.setItem(_key, utils.toJSON(storage));
};

let get = (key) => {
  let _key = getKey(key);

  let _storage = storageCacher.get(_key);
  let _value = _storage.data;
  if(!utils.isUndefined(_value)){
    return _value;
  }
  let storage = JStorage.getItem(_key);
  storage = utils.parse(storage) || { data: {}};

  storageCacher.set(_key, storage);

  let value = storage.data;
  return value;
}

let remove = (key) => {
  let _key = getKey(key);
  storageCacher.remove(key);
  JStorage.removeItem(_key);
}

let setPrefix = (str) => {
  _storage_private_prefix_ = str;
};
let getAll = () => {
  return storageCacher.getAll();
};
export default {
  get,
  set,
  remove,
  setPrefix,
  getAll
}