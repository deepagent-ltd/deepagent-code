import common from "../../common/common";
export default function($socket, { webAgent }){
  let funcs = [
    'connect',
    'disconnect',
    'getDevice',
    'isConnected',
    'isNeedConnect',
    'getCurrentUser',
    'setConnectParams',
    'getUserStatus',
    'subUserStatus',
  ];
  let invokes = common.formatProvider(funcs, $socket);
  invokes.setServerUrlProider = (callback) => {
    return webAgent.setServerUrlProider(callback)
  };
  return invokes;
}