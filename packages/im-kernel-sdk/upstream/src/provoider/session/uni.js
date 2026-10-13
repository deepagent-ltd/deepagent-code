export default function(){
  let result = {};
  let removeItem = (key) => {
    delete result[key];
  };

  let getItem = (key) => {
    return result[key]
  };

  let setItem = (key, value) => {
    result[key] = value;
  };

  return {
    removeItem,
    getItem,
    setItem,
  }
}