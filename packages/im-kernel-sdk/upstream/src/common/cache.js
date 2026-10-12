import utils from "../utils";
export default function () {
  let caches = {};
  let set = (key, value) => {
    caches[key] = value;
  };
  let get = (key) => {
    return caches[key] || {};
  };
  let remove = (key) => {
    delete caches[key];
  };
  let clear = () => {
    caches = {};
  };
  let getAll = () => {
    return caches;
  };
  return {
    set,
    get,
    remove,
    clear,
    getAll
  }
}