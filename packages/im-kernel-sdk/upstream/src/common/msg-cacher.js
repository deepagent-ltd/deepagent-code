import utils from "../utils";
import Cache from "../common/cache";

export default function(){
  let cache = Cache();
  let getConversationId = ({ conversationType, conversationId }) => {
    return `${conversationType}_${conversationId}`;
  };

  let add = (conversation, message) => {
    let list = utils.isArray(message) ? message : [message];
    let key = getConversationId(conversation);
    let messages = cache.get(key);
    if(utils.isEmpty(messages)){
      messages = [];
    }
    messages = messages.concat(list);
    messages = utils.quickSort(messages, (a, b) => {
      return a.sentTime > b.sentTime;
    });
    if(messages.length > 10){
      messages.length = 10;
    }
    cache.set(key, messages);
  };
  let isInclude = (message) => {
    let key = getConversationId(message);
    let messages = cache.get(key);
    if(utils.isEmpty(messages)){
      messages = [];
    }
    let cacheMsgs = utils.filter(messages, (item) => {
      return utils.isEqual(item.messageId, message.messageId);
    });
    return cacheMsgs.length > 0;
  };
  let clear = () => {
    cache.clear();
  };

  return {
    add,
    isInclude,
    clear,
  }
}