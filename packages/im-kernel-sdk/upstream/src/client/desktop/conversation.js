import common from "../../common/common";
import tools from "./tools";
import utils from "../../utils";

export default function($conversation, { conversationUtils, webAgent }){
  let funcs = [
    'removeConversation',
    'clearUnreadcount',
    'getTotalUnreadcount',
    'clearTotalUnreadcount',
    'markUnread',
    'setDraft',
    'getDraft',
    'removeDraft',
    'insertConversation',
    'disturbConversation',
    'setTopConversation',
    'getTopConversations',
    'setAllDisturb',
    'getAllDisturb',
    'getAllDisturb',
    'createConversationTag',
    'destroyConversationTag',
    'getConversationTags',
    'addConversationsToTag',
    'removeConversationsFromTag',
    '_batchInsertConversations',
  ];
  let invokes = common.formatProvider(funcs, $conversation);

  invokes.getConversations = (params = {}) => {
    return $conversation.getConversations(params).then(({ conversations, groups, users, friends, isFinished }) => {
      let _conversations = tools.formatConversations({ conversations, users, groups, friends});
      // 不指定会话类型时向内存中插入数据
      if(utils.isUndefined(params.conversationType)){
        conversationUtils.add(_conversations);
      }
      return { isFinished, conversations: utils.clone(_conversations)};
    });
  };

  invokes.getConversation = (conversation) => {
    return $conversation.getConversation(conversation).then((result) => {
      let { conversation, groups, users } = result;
      let _conversation = {};
      if(!conversation.isNew){
        _conversation = tools.formatConversation({ conversation, users, groups });
      }
      return { conversation: _conversation };
    });
  };
  return invokes;
}