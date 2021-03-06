/**
 * 2011 Peter 'Pita' Martischka
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *      http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS-IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

/**
This module is made for the case, you want to use a SQL-Based Databse or a KeyValue Database that can only save strings(and no objects), as a JSON KeyValue Store.

The idea of the dbWrapper is to provide following features:

* automatic JSON serialize/deserialize to abstract that away from the database driver and the module user. 
* cache reads. A amount of KeyValues are hold in the memory, so that reading is faster. 
* Buffer DB Writings. Sets and deletes should be buffered to make them in a setted interval with a bulk. This reduces the overhead of database transactions and makes the database faster. But there is also a danger to loose data integrity, to keep that, we should provide a flush function.  

All Features can be disabled or configured. The Wrapper provides default settings that can be overwriden by the driver and by the module user. 
*/

var async = require("async");

var defaultSettings =
{
  //the number of elements that should be cached. To Disable cache just set it to zero
  cache: 1000,
  //the interval in ms the wrapper writes to the database. To Disable interval writes just set it to zero
  writeInterval: 100,
  //a flag if the data sould be serialized/deserialized to json
  json:true
}

/**
 The constructor of the wrapper
 @param wrappedDB The Database that should be wrapped
 @param settings (optional) The settings that should be applied to the wrapper
*/
exports.database = function(wrappedDB, settings)
{
  //saved the wrappedDB
  this.wrappedDB=wrappedDB;
  
  //apply default settings
  this.settings               = {};
  this.settings.cache         = defaultSettings.cache;
  this.settings.writeInterval = defaultSettings.writeInterval;
  this.settings.json          = defaultSettings.json;

  //try to apply the settings of the driver
  if(wrappedDB.settings != null)
  {  
    if(wrappedDB.settings.cache         != null)  this.settings.cache         = wrappedDB.settings.cache;
    if(wrappedDB.settings.writeInterval != null)  this.settings.writeInterval = wrappedDB.settings.writeInterval;
    if(wrappedDB.settings.json          != null)  this.settings.json          = wrappedDB.settings.json;
  }

  //try to apply the settings given with the constructor
  if(settings != null)
  {
    if(settings.cache         != null)  this.settings.cache         = settings.cache;
    if(settings.writeInterval != null)  this.settings.writeInterval = settings.writeInterval;
    if(settings.json          != null)  this.settings.json          = settings.json;
  }
  
  //freeze the settings at this point
  this.settings = Object.freeze(this.settings);
  
  //start the write Interval
  if(this.settings.writeInterval > 0)
  {
    setInterval(flush, this.settings.writeInterval, this);
  }
  
  //ensure the buffer is flushed before the application ends
  process.on('exit', function () 
  {
    flush(this);
  });
};

/**
 key is the key of the keyValue Object
 value is a object
 {
   value: the value of the keyValue object, contains only deserialized data
   dirty: true or false, means if its already written to the database or not
   callback: (optional) a array of callbacks that should be called once this value is written
   timestamp: a timestamp that shows when this item was read or write the last time. 
              The Garbage collector needs this value
 }  
*/
exports.database.prototype.buffer = {};

//the length of the Buffer.
exports.database.prototype.bufferLength = 0;

/**
 wraps the init function of the original DB
*/
exports.database.prototype.init = function(callback)
{
  this.wrappedDB.init(callback);
}

/**
 wraps the close function of the original DB
*/
exports.database.prototype.close = function(callback)
{
  this.wrappedDB.close(callback);
}

/**
 Gets the value trough the wrapper. 
*/
exports.database.prototype.get = function(key, callback)
{
  //if cache is enabled and data is in the cache, get the value from the cache
  if(this.settings.cache > 0 && this.buffer[key])
  {
    this.buffer[key].timestamp = new Date().getTime();
    callback(null, this.buffer[key].value);
  }
  //caching is disabled but its still in a dirty writing cache, so we have to get the value out of the cache too
  else if(this.settings.cache == 0 && this.buffer[key] && this.buffer[key].dirty)
  {
    this.buffer[key].timestamp = new Date().getTime();
    callback(null, this.buffer[key].value);
  }
  //get it direct
  else
  {
    var self = this;
  
    this.wrappedDB.get(key, function(err,value)
    {  
      if(self.settings.json)
      {
        try
        {
          value = JSON.parse(value);
        }
        catch(e)
        {
          console.error("JSON-PROBLEM:" + value);
          callback(e);
          return;
        }
      }
    
      //cache the value if caching is enabled
      if(self.settings.cache > 0)
        self.buffer[key] = {"value":value, dirty:false, timestamp: new Date().getTime()};
      
      self.bufferLength++;
      
      //call the garbage collector
      self.gc();
      
      callback(err,value);
    });
  }
}

/**
 Sets the value trough the wrapper
*/
exports.database.prototype.set = function(key, value, callback)
{
  //writing cache is enabled, so simply write it into the buffer
  if(this.settings.writeInterval > 0)
  {
    //initalize the buffer object if it not exists
    if(!this.buffer[key]) 
    {
      this.buffer[key] = {};
      this.bufferLength++;
    }
    
    //set the new values
    this.buffer[key].value = value;
    this.buffer[key].dirty = true;
    this.buffer[key].timestamp = new Date().getTime();
    
    //call the garbage collector
    this.gc();
    
    //initalize the callback array in the buffer object if it not exists.
    //we need this as an array, cause the value may be many times overwritten bevors its finally written to the database, 
    //but all callbacks must be called
    if(!this.buffer[key].callbacks) 
      this.buffer[key].callbacks=[];
    
    //add this callback to the array
    if(callback) this.buffer[key].callbacks.push(callback);
    else
    {
      this.buffer[key].callbacks.push(function(err)
      {
        if(err) throw err;
      });
    }
  }
  //writecache is disabled, so we write directly to the database
  else
  {
    //The value is null, means this no set operation, this is a remove operation
    if(value==null)
    {
      this.wrappedDB.remove(key,callback);
    }
    //thats a correct value
    else
    {
      //stringify the value if stringifying is enabled
      if(this.settings.json == true)
        value = JSON.stringify(value);
    
      this.wrappedDB.set(key,value,callback);
    }
  }
}

/**
 Sets a subvalue
*/
exports.database.prototype.setSub = function(key, sub, value, callback)
{
  var _this = this;

  async.waterfall([
    //get the full value
    function(callback)
    {
      _this.get(key, callback);
    },
    //set the sub value and set the full value again 
    function(fullValue, callback)
    {
      //get the subvalue parent
      var subvalueParent = fullValue;
      for (var i=0 ; i < (sub.length-1) ; i++)
      {
        //test if the subvalue exist
        if(subvalue != null && subvalue[sub[i]] !== undefined)
        {
          subvalueParent = subvalueParent[sub[i]];
        }
        //the subvalue doesn't exist, throw error
        else
        {
          callback("Not able to find the subvalue '" + sub.join(".") + "' in " + JSON.stringify(value));
          return;
        }
      }
      
      //set the subvalue, we're doing that with the parent element
      subvalueParent[sub[sub.length-1]] = value;
      
      _this.set(key, fullValue, callback);
    }
  ],function(err)
  {
    if(callback) callback(err);
    else if(err != null) throw err;
  })
}

/**
 Returns a sub value of the object
 @param sub is a array, for example if you want to access object.test.bla, the array is ["test", "bla"]
*/
exports.database.prototype.getSub = function(key, sub, callback)
{
  //get the full value
  this.get(key, function (err, value)
  {
    //there happens an errror while getting this value, call callback
    if(err)
    {
      callback(err);
    }
    //everything is correct, navigate to the subvalue and return it
    else
    {
      var subvalue = value;
      
      for (var i=0 ; i<sub.length ; i++)
      {
        //test if the subvalue exist
        if(subvalue != null && subvalue[sub[i]] !== undefined)
        {
          subvalue = subvalue[sub[i]];
        }
        //the subvalue doesn't exist, throw error
        else
        {
          callback("Not able to find the subvalue " + sub.join(".") + " in " + JSON.stringify(value));
          return;
        }
      }
      
      callback(err, subvalue);
    }
  });
}

/**
 Removes the value trough the wrapper
*/
exports.database.prototype.remove = function(key, callback)
{
  //make a set to null out of it
  this.set(key, null, callback);
}

/**
 Garbage Collector of the cache
*/
exports.database.prototype.gc = function()
{
  //If the buffer size is under the settings size or cache is disabled -> return cause there is nothing to do
  if(this.bufferLength < this.settings.cache || this.settings.cache == 0)
  {
    return;
  }
  
  //collect all values that are not dirty
  var deleteCandidates = [];
  for(var i in this.buffer)
  {
    if(this.buffer[i].dirty == false)
    {
      deleteCandidates.push({key: i, timestamp: this.buffer[i].timestamp});
    }
  }
  
  if(deleteCandidates.length > 0)
  {
    //sort them based on the timestamp
    deleteCandidates.sort(function(a,b){
      return a.timestamp-b.timestamp;
    });
    
    //delete the half buffer
    for(var i=0; i<(this.settings.cache/2) && i<deleteCandidates.length;i++)
    {
      delete this.buffer[deleteCandidates[i].key];
      this.bufferLength--;
    }
  }
  //There are no undirty values to delete, means we have to flush the cache
  else
  {
    var self = this;
  
    setTimeout(flush,0,this,function(err){
      self.gc();
    });
  }
}

/**
 Wrapes the flush function
*/
exports.database.prototype.flush = function(callback)
{
  flush(this,callback);
}

var transmissionNum = 0;

/**
 Writes all dirty values to the database
*/
function flush (db, callback)
{
  var operations = [];
  var callbacks = [];

  //run trough the buffer and search for dirty values
  for(var i in db.buffer)
  {
    if(db.buffer[i].dirty == true)
    {
      //collect all data for the operation
      var type  = db.buffer[i].value == null ? "remove" : "set";
      var key   = i;
      var value = db.buffer[i].value;
      
      //stringify the value if stringifying is enabled
      if(db.settings.json == true && value != null)
        value = JSON.stringify(value);
      
      //add the operation to the operations array
      operations.push({"type":type, "key":key, "value":value});
      
      //collect callbacks
      callbacks = callbacks.concat(db.buffer[i].callbacks);
      
      //clean callbacks
      db.buffer[i].callbacks = [];
      //set the dirty flag to false
      db.buffer[i].dirty = false;
    }
  }
  
  //send the bulk to the database driver and call the callbacks with the results  
  if(operations.length > 0)
  {
    var thistransmissionNum = transmissionNum;
  
    transmissionNum++;
    
    db.wrappedDB.doBulk(operations, function(err)
    {
      for(var i in callbacks)
      {
        callbacks[i](err);
      }
      
      if(callback) callback();
    });
    
  }
}

