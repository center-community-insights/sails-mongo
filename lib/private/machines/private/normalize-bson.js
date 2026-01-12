/**
 * Module dependencies
 */

var _ = require('@sailshq/lodash');
var mongodb = require('mongodb');

var ObjectId = mongodb.ObjectID || mongodb.ObjectId;
var Binary = mongodb.Binary;
var Decimal128 = mongodb.Decimal128;
var Long = mongodb.Long;
var Int32 = mongodb.Int32;

var normalizeMongoObjectId = require('./normalize-mongo-object-id');


/**
 * normalizeBson()
 *
 * Convert "foreign" BSON instances (coming from a different version of `bson`)
 * into the BSON classes bundled with this adapter's `mongodb` dependency.
 *
 * This prevents MongoDB Node driver v6 from throwing:
 *   BSONVersionError: Unsupported BSON version, bson types must be from bson 6.x.x
 *
 * @param {Ref} x
 * @returns {Ref}
 */

module.exports = function normalizeBson(x) {
  if (!x || typeof x !== 'object') { return x; }

  // If this isn't a bson type, return as-is.
  if (!x._bsontype) { return x; }

  // ObjectId (most common)
  if (x._bsontype === 'ObjectId') {
    try { return normalizeMongoObjectId(x); } catch (unusedErr) { return x; }
  }

  // Binary
  if (x._bsontype === 'Binary') {
    // If it's already our Binary, keep it.
    if (Binary && x instanceof Binary) { return x; }
    // Otherwise attempt to extract bytes and rebuild.
    try {
      var buf = x.buffer || (typeof x.value === 'function' ? x.value(true) : undefined);
      if (buf && Buffer.isBuffer(buf)) {
        return new Binary(buf);
      }
      // Some older bson versions expose `buffer` as Uint8Array.
      if (buf && typeof Uint8Array !== 'undefined' && buf instanceof Uint8Array) {
        return new Binary(Buffer.from(buf));
      }
    } catch (unusedErr) { /* ignore */ }
    return x;
  }

  // Decimal128
  if (x._bsontype === 'Decimal128') {
    if (Decimal128 && x instanceof Decimal128) { return x; }
    try {
      var s = x.toString && x.toString();
      if (_.isString(s) && Decimal128 && typeof Decimal128.fromString === 'function') {
        return Decimal128.fromString(s);
      }
    } catch (unusedErr) { /* ignore */ }
    return x;
  }

  // Long / Int32
  if (x._bsontype === 'Long') {
    if (Long && x instanceof Long) { return x; }
    try {
      var ls = x.toString && x.toString();
      if (_.isString(ls) && Long && typeof Long.fromString === 'function') {
        return Long.fromString(ls);
      }
    } catch (unusedErr) { /* ignore */ }
    return x;
  }

  if (x._bsontype === 'Int32') {
    if (Int32 && x instanceof Int32) { return x; }
    try {
      var n = x.valueOf && x.valueOf();
      if (_.isNumber(n) && Int32) {
        return new Int32(n);
      }
    } catch (unusedErr) { /* ignore */ }
    return x;
  }

  // Unknown bson type; return as-is.
  return x;
};

