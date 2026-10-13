import utils from "../utils";
export default function () {
  /*
  EmitterEvents = {
    name: [event1, event2, ...]
  }
*/
  let EmitterEvents = {};
  let EmitterOnceEvent = {};
  let on = (name, event) => {
    let events = EmitterEvents[name] || [];
    events.push(event);
    let eventObj = {};
    eventObj[name] = events;
    utils.extend(EmitterEvents, eventObj);
  }

  let once = (name, event) => {
    EmitterOnceEvent[name] = event;
  }

  let off = (name) => {
    delete EmitterEvents[name];
    delete EmitterOnceEvent[name];
  }

  let emit = (name, data) => {
    let events = EmitterEvents[name] || [];
    data = utils.isArray(data) ? data : [data];
    utils.forEach(events, (event) => {
      event(...data);
    });
    let event = EmitterOnceEvent[name] || utils.noop;
    event(...data);
  }

  let clear = () => {
    utils.forEach(EmitterEvents, (event, name) => {
      delete EmitterEvents[name];
    });
  }
  return {
    on,
    off,
    emit,
    clear,
    once
  }
}