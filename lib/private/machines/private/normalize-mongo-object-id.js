/**
 * Module dependencies
 */

var _ = require('@sailshq/lodash');
var flaverr = require('flaverr');
var ObjectId = require('mongodb').ObjectID || require('mongodb').ObjectId;

/**
 * normalizeMongoObjectId()
 *
 * Ensure that the provided reference is either an Object Id instance;
 * or if it isn't, then attempt to construct one from it.
 * -----------------------------------------------------------------------------
 * @param  {Ref} supposedId [either a hex string or an ObjectId instance)
 * @returns {Ref}  [an ObjectId instance]
 * @throws {E_CANNOT_INTERPRET_AS_OBJECTID}
 * -----------------------------------------------------------------------------
 * - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - -
 * > WARNING: .toString() is inconsistent!  In the Node.js client, it
 * > returns the actual hex string, but beware: in the Mongo console,
 * > it returns a string like `ObjectId("asdgasdgasdgasgd")` instead!
 * > Similarly, the behavior of `.valueOf()` is different in the Node.js
 * > client, and there is no `str` property!  (For details, compare the
 * > example just below with the docs on the MongoDB website at e.g.
 * > https://docs.mongodb.com/manual/reference/method/ObjectId/)
 *
 * In Mongo shell:
 * ```
 * > o=new ObjectId()
 * ObjectId("58ab008e7707847e54dd28bb")
 * > o
 * ObjectId("58ab008e7707847e54dd28bb")
 * > o.toString()
 * ObjectId("58ab008e7707847e54dd28bb")
 * > o.toString() === '58ab008e7707847e54dd28bb'
 * false
 * 58ab008e7707847e54dd28bb
 * > o.valueOf()
 * 58ab008e7707847e54dd28bb
 * > o.str === o.valueOf()
 * true
 * >
 * ```
 *
 * In Node.js shell:
 * ```
 * > o = new require('mongodb').ObjectId('58ab07042797833afe5fd4c8')
 * 58ab07042797833afe5fd4c8
 * > typeof o
 * 'object'
 * > typeof o.toString()
 * 'string'
 * > typeof o.valueOf()
 * 'object'
 * > o.valueOf()
 * 58ab07042797833afe5fd4c8
 * > o.toString()
 * '58ab07042797833afe5fd4c8'
 * > o.str
 * undefined
 * >
 * ```
 * - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - -
 */
module.exports = function normalizeMongoObjectId(supposedId) {

  // First of all, if the supposed id is a Mongo ObjectId instance,
  // then just return it, straight away.
  if (_.isObject(supposedId) && supposedId instanceof ObjectId){
    return supposedId;
  }
  // Backwards compatibility:
  // In real apps (especially nxus / older deps), it is common to receive an ObjectId instance
  // constructed by a DIFFERENT version of the `bson` package (e.g. from mongodb@3.x).
  // MongoDB Node driver v6 throws `BSONVersionError` if you pass those foreign bson types into queries.
  //
  // Detect ObjectId-like objects and convert them into *this adapter's* ObjectId implementation.
  else if (_.isObject(supposedId) && supposedId && supposedId._bsontype === 'ObjectId' && !(supposedId instanceof ObjectId)) {
    var hex;
    // Try multiple approaches to extract the hex string from the foreign ObjectId.
    // Different bson versions store ObjectId data differently.

    // Approach 1: toHexString() - standard method in all modern bson versions
    if (!hex || !_.isString(hex) || hex.length !== 24) {
      try {
        if (typeof supposedId.toHexString === 'function') {
          hex = supposedId.toHexString();
        }
      } catch (unusedErr) { /* ignore */ }
    }

    // Approach 2: toString() - might return "ObjectId(...)" or plain hex
    if (!hex || !_.isString(hex) || hex.length !== 24) {
      try {
        if (typeof supposedId.toString === 'function') {
          var str = supposedId.toString();
          // Some implementations stringify like: ObjectId("...") – extract the hex if so.
          var m = str && str.match && str.match(/^[Oo]bject[Ii]d\(["']?([0-9a-fA-F]{24})["']?\)$/);
          if (m) {
            hex = m[1];
          } else if (str && str.length === 24 && /^[0-9a-fA-F]{24}$/.test(str)) {
            hex = str;
          }
        }
      } catch (unusedErr) { /* ignore */ }
    }

    // Approach 3: .id property (older bson versions stored Buffer here)
    if (!hex || !_.isString(hex) || hex.length !== 24) {
      try {
        if (supposedId.id) {
          if (Buffer.isBuffer(supposedId.id) && supposedId.id.length === 12) {
            hex = supposedId.id.toString('hex');
          } else if (typeof supposedId.id === 'string' && supposedId.id.length === 24) {
            hex = supposedId.id;
          }
        }
      } catch (unusedErr) { /* ignore */ }
    }

    // Approach 4: .str property (very old bson versions)
    if (!hex || !_.isString(hex) || hex.length !== 24) {
      try {
        if (typeof supposedId.str === 'string' && supposedId.str.length === 24) {
          hex = supposedId.str;
        }
      } catch (unusedErr) { /* ignore */ }
    }

    // Approach 5: valueOf() - might return useful data
    if (!hex || !_.isString(hex) || hex.length !== 24) {
      try {
        if (typeof supposedId.valueOf === 'function') {
          var val = supposedId.valueOf();
          if (typeof val === 'string' && val.length === 24 && /^[0-9a-fA-F]{24}$/.test(val)) {
            hex = val;
          }
        }
      } catch (unusedErr) { /* ignore */ }
    }

    // Approach 6: JSON.stringify may yield usable hex
    if (!hex || !_.isString(hex) || hex.length !== 24) {
      try {
        var json = JSON.stringify(supposedId);
        // Could be "5f50c31..." or {"$oid":"5f50c31..."}
        var oidMatch = json && json.match(/[0-9a-fA-F]{24}/);
        if (oidMatch) {
          hex = oidMatch[0];
        }
      } catch (unusedErr) { /* ignore */ }
    }

    if (_.isString(hex) && hex.length === 24 && /^[0-9a-fA-F]{24}$/.test(hex)) {
      try {
        return new ObjectId(hex);
      } catch (constructErr) {
        // ObjectId construction failed - fall through to error
      }
    }
    // Fall through to error below.
  }
  // Otherwise try to interpret the supposed mongo id as a hex string.
  // (note that we also implement a failsafe)
  else if (_.isString(supposedId) && ObjectId.isValid(supposedId)) {
    var objectified = new ObjectId(supposedId);

    // Sanity check:
    if (objectified.toString() !== supposedId) {
      throw new Error(
        'Consistency violation: Unexpected result interpreting `'+supposedId+'` as a Mongo ObjectId.  '+
        'After instantiating the provided value as an ObjectId instance, then calling .toString() '+
        'on it, the result (`'+objectified.toString()+'`) is somehow DIFFERENT than the originally-provided '+
        'value (`'+supposedId+'`)... even though the mongo lib said it was `.isValid()`.  (This is likely '+
        'due to a bug in the Mongo adapter, or somewhere else along the way.  Please report at http://sailsjs.com/bugs)'
      );
    }//-•

    return objectified;
  }
  // Otherwise, give up.
  else {
    throw flaverr('E_CANNOT_INTERPRET_AS_OBJECTID', new Error(
      'Cannot interpret `'+supposedId+'` as a Mongo id.\n'+
      '(Usually, this is the result of a bug in application logic.)\n'+
      'For more info on Mongo ids, see:\n'+
      '• https://docs.mongodb.com/manual/reference/bson-types/#objectid\n'+
      '• http://sailsjs.com/support'
    ));
  }

};
