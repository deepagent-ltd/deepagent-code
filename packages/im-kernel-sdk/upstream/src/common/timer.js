import utils from "../utils";
export default function (_config = {}) {
  let config = { timeout: 1 * 60 * 1000 };
  utils.extend(config, _config);

  let { timeout } = config;
  let interval = 0;
  let callback = utils.noop;
  
  let resume = (_callback) => {
    callback = _callback;
    interval = setInterval(() => {
      callback();
    }, timeout);
  };
  let pause = () => {
    clearInterval(interval);
  }; 
  let reset = () => {
    pause();
    resume(callback)
  };
  return {
    resume,
    pause,
    reset
  };
}