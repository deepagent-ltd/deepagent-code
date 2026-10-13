export default function(url){
  let SOCKET_READY_STATE = {
    CONNECTING: 0,
    OPEN: 1,
    CLOSING: 2,
    CLOSED: 3,
  };
  let wsInstance = {
    readyState: SOCKET_READY_STATE.CONNECTING,
    onopen: () => {},
    onclose: () => {},
    onerror: () => {},
    onmessage: () => {},
  };
  let socketTask = uni.connectSocket({
    url: url,
    complete: ()=> {}
  });
  socketTask.onOpen(() => {
    wsInstance.readyState = SOCKET_READY_STATE.OPEN;
    wsInstance.onopen();
  });
  socketTask.onClose(() => {
    wsInstance.readyState = SOCKET_READY_STATE.CLOSED;
    wsInstance.onclose();
  });
  socketTask.onError(() => {
    wsInstance.readyState = SOCKET_READY_STATE.CLOSED;
    wsInstance.onerror();
  });
  socketTask.onMessage((data) => {
    wsInstance.onmessage(data);
  });
  wsInstance.send = (data) => {
    socketTask.send({ data });
  };
  wsInstance.close = () => {
    socketTask.close();
  };
  return wsInstance;
};