import utils from "../utils";
import Cache from "./cache";

export default function(){
  let cache = Cache();
  
  let set = (id, info = {}) => {
    let _info = cache.get(id);
    if(utils.isEmpty(_info)){
      _info = { updatedTime: 0 };
    }
    if(info.updatedTime > _info.updatedTime){
      cache.set(id, info);
    }
  };

  let get = (id) => {
    let _info = cache.get(id) || {};
    return _info;
  };

  let clear = () => {
    cache.clear();
  };

  return {
    set,
    get,
    clear,
  }
}
