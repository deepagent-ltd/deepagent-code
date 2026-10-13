export default function(){
  let encoder = (str) => {
    return new TextEncoder().encode(str);
  };

  let decoder = (buffer) => {
    return new TextDecoder().decode(buffer);
  };

  return {
    encoder,
    decoder
  }
}