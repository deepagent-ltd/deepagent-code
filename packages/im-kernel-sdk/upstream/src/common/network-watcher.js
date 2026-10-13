import utils from "../utils";
export default function (callbacks) {
  let onlineEvent = () => {
    let event = callbacks.ononline || utils.noop;
    event()
  }
  let watch = () => {
    if(typeof window == 'object' && window.addEventListener){
      window.removeEventListener('online', onlineEvent);
      window.addEventListener('online', onlineEvent);
    }
  };
  return { watch };
}