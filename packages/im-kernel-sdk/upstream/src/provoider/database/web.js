import utils from '../../utils';
/* 
  let option = {
    name: 'dbname',
    version: 'dbversion',
    tables: [
      {
        name: 'tableName',
        indexs: [{name, value}, {name, value}],
        autoIncrement: true
      }
    ]
  }
*/
export default function DB(option){
  let { name, version = 1, tables = {} } = option;
  let db = {};
  let isInitError = false;
  // 数据库初始化是移步的，如果初始化成功之前有请求，优先缓存，初始化成功后再执行 IO 操作
  let funcs = []


  let request = window.indexedDB.open(name, version);
  request.onerror = (e) => {
    console.log('logger database error', e);
    isInitError = true;
  };
  request.onsuccess = (e) => {
    db = request.result;
    consumer();
  };
  request.onupgradeneeded = (e) => {
    db = request.result;
    createTables();
  };

  let insert = (params) => {
    let { name, record } = params;
    if(utils.isUndefined(db.name)){
      return producer({ name: 'insert',  params: [params] });
    }
    return utils.deferred((resolve, reject) => {
      let request = db.transaction([name], 'readwrite')
      let store = request.objectStore(name);
      request.onsuccess = function () {
        resolve();
      };
      request.onerror = function (e) {
        reject(e);
      };
      record = utils.clone(record);
      store.add(record);
    });
  };

  /* 
    let params = {
      name: 'tableName',
      index: {
        name: '',
        values: [[], [], false, false]
      }
    };
  */
  let search = (params, callback) => {
    if(utils.isUndefined(db.name)){
      return producer({ name: 'search',  params: [params, callback] });
    }

    let { name, index = {} } = params;
    let { name: indexName, type, values = [] } = index;
    let keyRange = IDBKeyRange[type](...values);

    let transaction = db.transaction([name]);
    let store = transaction.objectStore(name);
    let sIdx = store.index(indexName);
    let request = sIdx.openCursor(keyRange);
    
    let list = [];
    request.onsuccess = function (event) {
      let cursor = event.target.result;
      if (cursor) {
        list.push(cursor.value);
        cursor.continue();
      } else {
        callback({ list });
      }
    };
    request.onerror = function (event) {
      callback({ list: [] }, event);
    };
  };

  /* 
    let params = {
      name: 'tableName',
      index: {
        name: '',
        values: [[], [], false, false]
      }
    };
  */
  let remove = (params) => {
    if(utils.isUndefined(db.name)){
      return producer({ name: 'remove',  params: [params] });
    }

    return utils.deferred((resolve, reject) => {
      let { name, index } = params;
        let transaction = db.transaction([name], 'readwrite');
        let store = transaction.objectStore(name);
        
        let { name: indexName, type, values = [] } = index;
        let keyRange = IDBKeyRange[type](...values);
        let sIdx = store.index(indexName);
        let request = sIdx.openCursor(keyRange);
        request.onsuccess = function() {
          var cursor = request.result;
          if (cursor) {
            cursor.delete();
            cursor.continue();
          }else{
            resolve();
          }
        };
        request.onerror = function (e) {
          reject(e);
        };
    });
  }
  let dbTools = {
    insert,
    search,
    remove,
  }
  
  function consumer(){
    utils.forEach(funcs, ({ name, params }) => {
      dbTools[name](...params);
    });
    funcs = [];
  };
  // option => { name: 'search',  params: [] }
  function producer(option){
    if(isInitError){
      funcs = [];
      return;
    }
    funcs.push(option)
  };

  function createTables(){
    utils.forEach(tables, (table) => {
      let { name, autoIncrement = true, indexs = [] } = table;
      if(!db.objectStoreNames.contains(name)){
        let store = db.createObjectStore(name, { autoIncrement });
        utils.forEach(indexs, (idx) => {
          store.createIndex(idx.name, idx.value);
        });
      }
    });
    setTimeout(() => {
      consumer();
    }, 100);
  };

  return dbTools;
}