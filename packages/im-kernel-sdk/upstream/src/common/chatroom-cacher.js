import ChatRoomCacher from "./cache";
import utils from "../utils";
let chatroomCacher = ChatRoomCacher();

export default {
  set: (id, value) => {
    let result = chatroomCacher.get(id);
    let { msgs = [] } = value;
    if(msgs.length >= 200){
      msgs.shift(0);
      value = utils.extend(value, { msgs });
    }
    result = utils.extend(result, value);
    chatroomCacher.set(id, result);
  },
  get: (id) => {
    let result = chatroomCacher.get(id);
    return result;
  },
  remove: (id) => {
    chatroomCacher.remove(id);
  },
  getAll: () => {
    return chatroomCacher.getAll();
  },
}