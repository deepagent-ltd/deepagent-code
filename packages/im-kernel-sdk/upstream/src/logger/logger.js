import DB from '../provoider/database/index';
import { LOG_LEVEL } from '../enum';
import utils from "../utils";
import Storage from '../common/storage';
import common from "../common/common";
import jrequest from "../provoider/request/index";

export default function Logger(option = {}){
  let TABLE_NAME = 'LOGS';
  let INDEX = {
    TIME: 'time',
    LEVEL: 'level',
    T_L_GROUP: 'time_level'
  };
  let { isConsole = true, appkey, sessionId, getCurrentUser, getVersion, serverList } = option;

  let $db = DB({
    name: `_IMIIM_${appkey}`,
    tables: [
      { 
        name: TABLE_NAME, 
        indexs: [
          { name: INDEX.TIME, value: 'time' },
          { name: INDEX.LEVEL, value: 'level' },
          { name: INDEX.T_L_GROUP, value: ['time', 'level'] },
        ] 
      }
    ]
  });

  let kickDueLogs = () => {
    let day7 = 7 * 24 * 60 * 60 * 1000;
    let time = Date.now() - day7;
    $db.remove({ 
      name: TABLE_NAME, 
      index: { 
        name: INDEX.TIME,
        type: 'upperBound',
        values: [time, false]
      } 
    });
  };
  kickDueLogs();

  let write = (level, time, content) => {
    $db.insert({ name: TABLE_NAME, record: { sessionId, level, time, content } });
  };

  let log = (level, content) => {
    let time = Date.now();
    write(level, time, content);
    if(isConsole){
      let _time = utils.formatTime(time);
      let _content = utils.toJSON(content);
      console.log(`%cJG:LOG`, ``, `${_time} ${_content}`);
    }
  };
  let error = (content) => {
    log(LOG_LEVEL.ERROR, content);
  };
  let warn = (content) => {
    log(LOG_LEVEL.WARN, content);
  };
  let fatal = (content) => {
    log(LOG_LEVEL.FATAL, content);
  };
  let info = (content) => {
    log(LOG_LEVEL.INFO, content);
  };
  let report = ({ start, end, messageId }) => {
    let params = { 
      name: TABLE_NAME, 
      index: { 
        name: INDEX.TIME,
        type: 'bound',
        values: [start, end, false, false]
      }
    };
    let key = common.getNaviStorageKey();
    let navi = Storage.get(key);

    $db.search(params, (result) => {
      let user = getCurrentUser();
      let { token } = user;
      let api = serverList[0];
      let { http } = utils.getProtocol(api);
      let domain = api.replace(/http:\/\/|https:\/\/|file:\/\/|wss:\/\/|ws:\/\//g, '');
      let url = `${http}//${domain}/navigator/upload-log-plain`;
      jrequest.requestNormal(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-appkey': appkey,
          'x-token': token
        },
        body: utils.toJSON({ msg_id: messageId, log: utils.toJSON(result.list) })
      });
    });
  };
  return {
    log,
    error,
    warn,
    fatal,
    info,
    report
  }
}