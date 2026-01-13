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


// Enable debug logging with SAILS_MONGO_DEBUG_BSON=1
var DEBUG_BSON = process.env.SAILS_MONGO_DEBUG_BSON === '1' || process.env.SAILS_MONGO_DEBUG_BSON === 'true';

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

function normalizeBson(x) {
  if (!x || typeof x !== 'object') { return x; }

  // If this isn't a bson type, return as-is.
  if (!x._bsontype) { return x; }

  // ObjectId (most common)
  if (x._bsontype === 'ObjectId') {
    // If it's already from this adapter's mongodb package, return as-is.
    if (x instanceof ObjectId) { return x; }
    // Otherwise, try to convert the foreign ObjectId.
    try {
      return normalizeMongoObjectId(x);
    } catch (conversionErr) {
      // If normalization failed, we have a foreign ObjectId that can't be converted.
      // This will cause BSONVersionError if we return it. Try one last fallback:
      // extract any 24-char hex string we can find and create a new ObjectId.
      var fallbackHex = null;
      try {
        var jsonStr = JSON.stringify(x);
        var hexMatch = jsonStr && jsonStr.match(/[0-9a-fA-F]{24}/);
        if (hexMatch) { fallbackHex = hexMatch[0]; }
      } catch (jsonErr) { /* ignore */ }

      if (fallbackHex && ObjectId.isValid(fallbackHex)) {
        try { return new ObjectId(fallbackHex); } catch (ctorErr) { /* ignore */ }
      }

      // If we still can't convert, log a warning.
      // The caller will get the original foreign ObjectId which may cause BSONVersionError,
      // but at least they'll see this warning first.
      // eslint-disable-next-line no-console
      console.warn('[sails-mongo] ⚠️  Failed to normalize foreign ObjectId. This will likely cause BSONVersionError.');
      // eslint-disable-next-line no-console
      console.warn('[sails-mongo] ObjectId value:', x && x.toString ? x.toString() : x);
      // eslint-disable-next-line no-console
      console.warn('[sails-mongo] Error:', conversionErr && conversionErr.message);
      // eslint-disable-next-line no-console
      console.warn('[sails-mongo] To fix: use sails-mongo\'s ObjectId instead of importing from mongodb directly.');
      // eslint-disable-next-line no-console
      console.warn('[sails-mongo] Example: const { ObjectId } = require(\'sails-mongo\').mongodb;');
      
      // Return original - it will fail at serialization time with BSONVersionError
      return x;
    }
  }

  // Binary
  if (x._bsontype === 'Binary') {
    // If it's already our Binary, keep it.
    if (Binary && x instanceof Binary) { return x; }
    // Otherwise attempt to extract bytes and rebuild.
    var binaryBuf = null;
    try {
      binaryBuf = x.buffer || (typeof x.value === 'function' ? x.value(true) : undefined);
      if (binaryBuf && Buffer.isBuffer(binaryBuf)) {
        return new Binary(binaryBuf, x.sub_type || x.subtype || 0);
      }
      // Try to get buffer from different property names used in older bson versions
      if (!binaryBuf && x.data && Buffer.isBuffer(x.data)) {
        return new Binary(x.data, x.sub_type || x.subtype || 0);
      }
    } catch (unusedErr) { /* ignore */ }
    // Return original if we can't convert (Binary might still serialize OK in some cases)
    return x;
  }

  // Decimal128
  if (x._bsontype === 'Decimal128') {
    if (Decimal128 && x instanceof Decimal128) { return x; }
    try {
      var decStr = x.toString && x.toString();
      if (_.isString(decStr) && Decimal128 && typeof Decimal128.fromString === 'function') {
        return Decimal128.fromString(decStr);
      }
    } catch (unusedErr) { /* ignore */ }
    return x;
  }

  // Long
  if (x._bsontype === 'Long') {
    if (Long && x instanceof Long) { return x; }
    try {
      var longStr = x.toString && x.toString();
      if (_.isString(longStr) && Long && typeof Long.fromString === 'function') {
        return Long.fromString(longStr);
      }
    } catch (unusedErr) { /* ignore */ }
    return x;
  }

  // Int32
  if (x._bsontype === 'Int32') {
    if (Int32 && x instanceof Int32) { return x; }
    try {
      var intVal = x.valueOf && x.valueOf();
      if (_.isNumber(intVal) && Int32) {
        return new Int32(intVal);
      }
    } catch (unusedErr) { /* ignore */ }
    return x;
  }

  // Unknown bson type; return as-is.
  return x;
}

/**
 * deep()
 *
 * Deep-walk and normalize foreign bson instances anywhere inside the provided value.
 * Mutates plain objects/arrays in place where possible.
 *
 * @param {Ref} x
 * @param {String?} path
 * @returns {Ref}
 */
normalizeBson.deep = function deepNormalizeBson(x, path) {
  path = path || '';

  if (_.isNull(x) || _.isUndefined(x)) { return x; }
  if (!_.isObject(x)) { return x; }

  // Preserve scalar instances.
  if (Buffer && Buffer.isBuffer && Buffer.isBuffer(x)) { return x; }
  if (x instanceof Date) { return x; }
  if (x instanceof RegExp) { return x; }

  // Normalize foreign bson instances.
  if (x && x._bsontype) {
    var beforeCtor = (x && x.constructor && x.constructor.name) || typeof x;
    var bt = x._bsontype;
    var isForeign = !(x instanceof ObjectId) && !(Binary && x instanceof Binary) &&
                    !(Decimal128 && x instanceof Decimal128) && !(Long && x instanceof Long) &&
                    !(Int32 && x instanceof Int32);

    if (DEBUG_BSON && isForeign) {
      // eslint-disable-next-line no-console
      console.log('[sails-mongo] Found foreign BSON at ' + (path || '(root)') + '  _bsontype=' + bt + '  ctor=' + beforeCtor);
    }

    var normalized = x;
    try {
      normalized = normalizeBson(x);
    } catch (normErr) {
      // eslint-disable-next-line no-console
      console.error('[sails-mongo] Failed to normalize BSON at ' + (path || '(root)') + ':', normErr.message);
      // Return original - normalizeBson already logged warnings for ObjectId failures
    }

    if ((DEBUG_BSON || process.env.SAILS_MONGO_DEBUG_FOREIGN_BSON) && normalized !== x) {
      // eslint-disable-next-line no-console
      console.log('[sails-mongo] Normalized foreign BSON at ' + (path || '(root)') + '  _bsontype=' + bt + '  from=' + beforeCtor + '  to=' + (normalized && normalized.constructor && normalized.constructor.name));
    }

    return normalized;
  }

  if (_.isArray(x)) {
    for (var i = 0; i < x.length; i++) {
      x[i] = deepNormalizeBson(x[i], path + '[' + i + ']');
    }
    return x;
  }

  _.each(_.keys(x), function (k) {
    var nextPath = path ? (path + '.' + k) : k;
    x[k] = deepNormalizeBson(x[k], nextPath);
  });
  return x;
};

module.exports = normalizeBson;
