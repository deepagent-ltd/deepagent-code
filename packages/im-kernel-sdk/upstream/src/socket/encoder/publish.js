import common from "../../common/common";
import { CONVERATION_TYPE, COMMAND_TOPICS } from "../../enum";
import utils from "../../utils";
import Proto from "../proto";
import JTextEncoder from "../../provoider/textencoder/index";

export default async function({ data, callback, index }, io){
  let { conversationId: targetId, conversationType, topic } = data;
  let buffer = [];
  
  let { msgEncryptHook } = io.getConfig();
  msgEncryptHook = msgEncryptHook || {};
  if(!utils.isAsyncFunction(msgEncryptHook.onEncrypt) && !utils.isFunction(msgEncryptHook.onEncrypt)){
    msgEncryptHook = {
      onEncrypt: async (data) => {
        return data.buffer;
      }
    };
  }

  if(utils.isInclude([COMMAND_TOPICS.SEND_GROUP, COMMAND_TOPICS.SEND_PRIVATE, COMMAND_TOPICS.SEND_CHATROOM], topic)){
    let { name, content, mentionInfo, flag, mergeMsg, referMsg, push, clientMsgId, lifeTime, lifeTimeAfterRead } = data;
    content  = utils.toJSON(content);
    let codec = Proto.lookup('codec.UpMsg');
    let mention = { };
    if(mentionInfo){
      let { members = [], mentionType } = mentionInfo;
      members = utils.map(members, (member) => {
        return { userId: member.id };
      });
      utils.extend(mention, {
        mentionType: mentionType,
        targetUsers: members
      }) 
    }

    if(!utils.isEmpty(referMsg)){
      let { messageIndex, sentTime, messageId, sender = { exts: {} } } = referMsg;
      let referContent = utils.toJSON(referMsg.content);
      // let referTarget = {
      //   userId: sender.id,
      //   nickname: sender.name,
      //   userPortrait: sender.portrait,
      //   extFields: common.toKVs(sender.exts)
      // };
      var referBuffer = JTextEncoder.encoder(referContent);
      var referMsgContent = await msgEncryptHook.onEncrypt({
        buffer: referBuffer, 
        name: referMsg.name,
        conversationType: referMsg.conversationType,
        conversationId: referMsg.conversationId,
      });
      referMsg = {
        msgIndex: messageIndex,
        msgTime: sentTime,
        msgId: messageId,
        msgContent: referMsgContent,
        msgType: referMsg.name,
        type: referMsg.conversationType,
        senderId: sender.id
        // targetUserInfo: referTarget
      };
    }

    var bufferContent = JTextEncoder.encoder(content);
    bufferContent = await msgEncryptHook.onEncrypt({
      buffer: bufferContent, 
      name: name,
      conversationType: conversationType,
      conversationId: targetId,
    });
    let _msg = {
      msgType: name,
      mentionInfo: mention,
      flags: flag,
      referMsg: referMsg,
      mergedMsgs: mergeMsg,
      clientUid: clientMsgId,
      msgContent: bufferContent
    };

    if(push){
      let { text, title, jPushOptions } = push;
      let pushData = { title, pushText: text, jPushOptions };
      pushData = utils.clone(pushData);
      if(!utils.isEmpty(pushData)){
        _msg = utils.extend(_msg, { pushData });
      }
    }

    if(utils.isNumber(lifeTime)){
      _msg.lifeTime = lifeTime;
    }
    
    if(utils.isNumber(lifeTimeAfterRead)){
      _msg.lifeTimeAfterRead = lifeTimeAfterRead;
    }

    if (data.deliveryVersion === 1) {
      delete _msg.mentionInfo;
      delete _msg.lifeTime;
      delete _msg.lifeTimeAfterRead;
      _msg.deliveryVersion = 1;
      _msg.deliveryExpiresAt = data.deliveryExpiresAt;
    }
    let message = codec.create(_msg);
    buffer = codec.encode(message).finish();
  }

  let codec = Proto.lookup('codec.PublishMsgBody');
  let message = codec.create({ index, targetId, topic, data: buffer });
  let _buffer = codec.encode(message).finish();
  return { buffer: _buffer };
}