import utils from "../utils";
import Cache from "./cache";
import { CHATROOM_ATTR_OP_TYPE } from "../enum"
let cacher = Cache();
let heap = ({ chatroomId, attrs }) => {
  let dels = [], updates = [];
  let { attrs: list } = cacher.get(chatroomId);
  list = list || [];

  utils.forEach(attrs, (attr) => {
    let { key, value, updateTime, userId, type } = attr;
    let _attr = { key, value, updateTime, userId,  };
    let index = utils.find(list, (item) => {
      return utils.isEqual(item.key, key);
    });

    if(utils.isEqual(index, -1) && utils.isEqual(type, CHATROOM_ATTR_OP_TYPE.ADD)){
      list.push(_attr);
    }
    
    if(!utils.isEqual(index, -1) && utils.isEqual(type, CHATROOM_ATTR_OP_TYPE.ADD)){
      list.splice(index, 1, _attr);
    }

    if(utils.isEqual(type, CHATROOM_ATTR_OP_TYPE.DEL)){
      list.splice(index, 1);
      delete _attr.value;
      dels.push(_attr);
    }else{
      updates.push(_attr);
    }
  });

  cacher.set(chatroomId, { attrs: list });
  return { updates, dels }
};

let removeAll = (chatroomId) => {
  cacher.remove(chatroomId)
};

let getAll = (chatroom) => {
  let { id } = chatroom;
  let result = cacher.get(id);
  let { attrs = [] } = result;
  return { id, attributes: attrs };
};

let removeAttrs = (chatroom) => {
  let { id, attributes } = chatroom;
  let attrs = utils.map(attributes, (attr) => {
    return { ...attr, type: CHATROOM_ATTR_OP_TYPE.DEL }
  });
  heap({ chatroomId: id, attrs });
};

let getAttrs = (chatroom) => {
  let { id, attributes } = chatroom;
  let { attrs = [] } = cacher.get(id);
  let list = [];
  utils.forEach(attrs, (attr) => {
    utils.forEach(attributes, (item) => {
      if(utils.isEqual(item.key, attr.key)){
        list.push(attr);
      }
    });
  });
  return { id, attributes: list }
}

let setAttrs = (chatroom) => {
  let { id, attributes } = chatroom;
  let attrs = utils.map(attributes, (attr) => {
    return { ...attr, type: CHATROOM_ATTR_OP_TYPE.ADD }
  });
  heap({ chatroomId: id, attrs });
};

export default {
  heap,
  removeAll,
  getAll,
  getAttrs,
  removeAttrs,
}