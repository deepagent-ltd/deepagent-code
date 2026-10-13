import utils from "../../utils";
export default function(){
  let encoder = (str) => {
    var binstr = unescape(encodeURIComponent(str)),
      arr = new Uint8Array(binstr.length);
    binstr.split('').forEach(function(char, i) {
      arr[i] = char.charCodeAt(0);
    });
    return arr;
  };

  let decoder = (view) => {
    var arr = new Uint8Array(view.buffer, view.byteOffset, view.byteLength),
      charArr = new Array(arr.length);
    arr.forEach(function(charcode, i) {
      charArr[i] = String.fromCharCode(charcode);
    });
    return decodeURIComponent(escape(charArr.join('')));
  };

  return {
    encoder,
    decoder
  }
}