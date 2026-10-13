import { STORAGE } from "../enum";
import utils from "../utils";
import Cacher from "./cache";
import StorageTool from "./storage";

let add = (messageId, content) => {
  let contentList = get(messageId);
  contentList = utils.isEmpty(contentList) ? [] : contentList;
  let index = utils.find(contentList, ({ seq }) => {
    return utils.isEqual(seq, content.seq);
  });
  if(utils.isEqual(index, -1)){
    contentList.push(content);
    StorageTool.set(messageId, contentList);
  }
};

let get = (messageId) => {
  let contentList = StorageTool.get(messageId);
  return utils.isEmpty(contentList) ? [] : contentList;
}

let remove = (messageId) => {
  StorageTool.remove(messageId);
}

let getAll = () => {
  return StorageTool.getAll();
};
export default {
  get,
  add,
  remove,
  getAll
}