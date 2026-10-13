import utils from "../../utils";
import Consumer from "../../common/consumer";

import { SIGNAL_CMD, COMMAND_TOPICS, SIGNAL_NAME, ErrorType, CONVERSATION_TAG } from "../../enum";
export default function TagSyncer(send, emitter, io, { logger }) {
  let exec = ({ $conversation }) => {
    let { id: userId } = io.getCurrentUser();
    let data = { topic: COMMAND_TOPICS.TAG_QUERY, userId };
    io.sendCommand(SIGNAL_CMD.QUERY, data, (result) => {
      let { code, tags } = result;
      if(utils.isEqual(ErrorType.COMMAND_SUCCESS.code, code)){
        let _tags = utils.map(tags, (tag) => {
          let item = CONVERSATION_TAG[tag.id] || {};
          utils.extend(tag, item);
          return tag;
        })
        $conversation._batchInsertTags(tags).then((result) => {
          emitter.emit(SIGNAL_NAME.CMD_SYNC_TAG_FINISHED, result);
        });
      }
    });
  }
  return {
    exec
  };
}
