import common from "../../common/common";
import { MESSAGE_SENT_STATE, MESSAGE_ORDER } from "../../enum";
import tools from "./tools";
import utils from "../../utils";

export default function($message, { webAgent }){
  let funcs = [
    'sendMessage',
    'updateMessageAttr',
    'removeMessages',
    'sendMassMessage',
    'getMessagesByIds',
    'clearMessage',
    'readMessage',
    'getMessageReadDetails',
    'updateMessage',
    'insertMessage',
    'getMentionMessages',
    'getFileToken',
    'sendFileMessage',
    'sendImageMessage',
    'sendVoiceMessage',
    'sendVideoMessage',
    'sendMergeMessage',
    'getMergeMessages',
    'setSearchContent',
    'addMessageReaction',
    'removeMessageReaction',
    'getFirstUnreadMessage',
  ];
  let invokes = common.formatProvider(funcs, $message);

  invokes.recallMessage = (message) => {
    return webAgent.recallMessage(message);
  };
  invokes.subscribeMessage = (conversation) => {
    return webAgent.subscribeMessage(conversation);
  };
  invokes.unsubscribeMessage = (conversation) => {
    return webAgent.unsubscribeMessage(conversation);
  };
  invokes.translate = (params) => {
    return webAgent.translate(params);
  };
  invokes.setTopMessage = (params) => {
    return webAgent.setTopMessage(params);
  };
  invokes.getTopMessage = (params) => {
    return webAgent.getTopMessage(params);
  };
  invokes.addFavoriteMessages = (params) => {
    return webAgent.addFavoriteMessages(params);
  };
  invokes.removeFavoriteMessages = (params) => {
    return webAgent.removeFavoriteMessages(params);
  };
  invokes.getFavoriteMessages = (params) => {
    return webAgent.getFavoriteMessages(params);
  };
  invokes.getContextMessages = (params) => {
    return webAgent.getContextMessages(params);
  };
  invokes.getMessages = (conversation) => {
    return utils.deferred((resolve, reject) => {
      let { order = MESSAGE_ORDER.BACKWARD } = conversation;
      let params = {
        time: conversation.time || 0,
        order: order, 
        count: conversation.count || 20,
        names: conversation.names || [],
        conversationType: conversation.conversationType,
        conversationId: conversation.conversationId,
      };
      return $message.getMessages(params).then(({ messages = [], isFinished, groups, senders }) => {
        let list = utils.filter(messages, (msg) => {
          return utils.isEqual(msg.sentState, MESSAGE_SENT_STATE.SUCCESS)
        });
  
        let next = () => {
          let _msgs = tools.formatMsgs({ messages, senders, groups });
          resolve({ isFinished, messages: _msgs });
        };
        let isCon = utils.isContinuous(list, 'messageIndex');
        let len = messages.length;
        let isFetch = isFinished && params.count > len;
        let isUncomleted = tools.hasUncompletedStream(list);
        // 如果首次获取历史消息，从远端拉取历史消息
        if(isFetch || !isCon || utils.isEqual(params.time, 0) || isUncomleted){
          // 按类型获取历史消息，不再从远端获取，方式 index 断续
          if(!utils.isEmpty(params.names)){
            return next();
          }
          return webAgent.getMessages(conversation).then((result) => {
            let newMsgs = [], streamMsgs = [];
            utils.forEach(result.messages, (newMsg) => {
              let index = utils.find(messages, (msg) => {
                return utils.isEqual(msg.messageId, newMsg.messageId);
              });
              let _msg = messages[index];
              if(!_msg){
                newMsgs.push(newMsg)
              }

              let { streams } = newMsg;
              if(_msg){
                let _streams = _msg.streams || [];
                if(streams.length > _streams.length){
                  streamMsgs.push(newMsg)
                }
              }
            })
            $message.insertBatchMsgs({ msgs: utils.clone(newMsgs.concat(streamMsgs)) });
  
            let _msgs = tools.formatMsgs({ messages: messages, senders, groups });
            let list = newMsgs.concat(_msgs);

            utils.forEach(streamMsgs, (streamMsg) => {
              let { messageId, streams } = streamMsg;
              let index = utils.find(list, (item) => {
                return utils.isEqual(item.messageId, messageId);
              });
              if(index > -1){
                utils.extend(list[index], { streams });
              }
            });

            list = utils.quickSort(list, (a, b) => {
              return a.sentTime < b.sentTime;
            });
            resolve({ isFinished: result.isFinished, messages: list });    
          }, reject);
        }
        next();
      });
    });
  };

  invokes.searchMessages = (params) => {
    return $message.searchMessages(params).then((result) => {
      let { total, list, groups, senders, isFinished } = result;
      list = utils.map(list, (item) => {
        let { matchedList, matchedCount, conversationType, conversationId } = item;
        let _msgs = tools.formatMsgs({ messages: matchedList, senders, groups });
        let params = { 
          conversation: { 
            id: conversationId, type: conversationType 
          }, 
          users: senders, 
          groups 
        };
        let _conversation = tools.formatConversation(params);
        let { conversationTitle, conversationPortrait, conversationExts } = _conversation;
        return { matchedList: _msgs, matchedCount, conversationType, conversationId, conversationTitle, conversationPortrait, conversationExts };
      });
      return { total, list, isFinished };
    });
  };
  return invokes;
}