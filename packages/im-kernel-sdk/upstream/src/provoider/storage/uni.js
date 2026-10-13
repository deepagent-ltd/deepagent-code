export default function(){

  let removeItem = (key) => {
    uni.removeStorageSync(key);
  };

  let getItem = (key) => {
    return uni.getStorageSync(key);
  };

  let setItem = (key, value) => {
    uni.setStorageSync(key, value);
  };

  return {
    removeItem,
    getItem,
    setItem,
  }
}