/**
 * Module dependencies
 */

var _ = require('@sailshq/lodash');
var normalizeMongoObjectId = require('./normalize-mongo-object-id');
var reifyValuesToSet = require('./reify-values-to-set');
var processNativeRecord = require('./process-native-record');


/**
 * attachSaveShim()
 *
 * Attach a legacy `.save()` method to a "physical record" dictionary.
 *
 * Why?
 * - Older Waterline / nxus code expects record instances with `.save()`.
 * - Modern Waterline returns plain objects for update/create/find results.
 * - This adapter aims to be backwards compatible, so we provide a best-effort shim.
 *
 * Notes:
 * - The attached `.save` is non-enumerable to avoid interfering with JSON serialization.
 * - The shim performs an updateOne by primary key and then refetches the record.
 *
 * @param {Dictionary} record
 * @param {Ref} mongoCollection  (native driver collection)
 * @param {Ref} WLModel
 * @param {Dictionary?} meta
 */

module.exports = function attachSaveShim(record, mongoCollection, WLModel, meta) {
  if (!record || typeof record !== 'object' || Array.isArray(record)) { return; }
  if (!mongoCollection || typeof mongoCollection.updateOne !== 'function') { return; }
  if (!WLModel || !WLModel.attributes || !WLModel.primaryKey) { return; }
  if (typeof record.save === 'function') { return; }

  var pkColumnName = WLModel.attributes[WLModel.primaryKey] && WLModel.attributes[WLModel.primaryKey].columnName;
  if (!pkColumnName) { return; }

  // Determine whether or not to use object ids.
  // Check model-level flag (for legacy Waterline models with string PKs) or meta.modelsNotUsingObjectIds.
  var useObjectIds = !WLModel.dontUseObjectIds && (!meta || !meta.modelsNotUsingObjectIds || !_.contains(meta.modelsNotUsingObjectIds, WLModel.identity));

  Object.defineProperty(record, 'save', {
    enumerable: false,
    configurable: true,
    writable: true,
    value: function save(cb) {
      var _record = record; // closure reference

      var exec = async function () {
        // Identify PK value from common locations.
        var pkVal = _record[pkColumnName];
        if (_.isUndefined(pkVal) && !_.isUndefined(_record._id)) { pkVal = _record._id; }
        if (_.isUndefined(pkVal) && !_.isUndefined(_record.id)) { pkVal = _record.id; }
        if (_.isUndefined(pkVal)) {
          throw new Error('Cannot save record because primary key (`' + pkColumnName + '`) is missing.');
        }

        var mongoPkVal = pkVal;
        if (useObjectIds) {
          mongoPkVal = normalizeMongoObjectId(pkVal);
        }

        var criteria = {};
        criteria[pkColumnName] = mongoPkVal;

        // Build values-to-set from the current in-memory record.
        var valuesToSet = _.omit(_record, ['_id', pkColumnName, 'id']);
        // Drop function values (defensive, in case userland attached methods).
        _.each(_.keys(valuesToSet), function (k) {
          if (typeof valuesToSet[k] === 'function') { delete valuesToSet[k]; }
        });

        // Normalize FKs / refs / PKs just like normal updates.
        try {
          reifyValuesToSet(valuesToSet, WLModel, meta);
        } catch (e) {
          // If there are invalid ObjectId-like values, surface the same error style as normal writes.
          throw e;
        }

        // Persist.
        var res = await mongoCollection.updateOne(criteria, { '$set': valuesToSet }, { upsert: false });
        // If the record didn't exist, treat as a failure (helps legacy code surface a useful error).
        if (res && res.matchedCount === 0) {
          throw new Error('Cannot save record: no matching record found for primary key `' + pkColumnName + '`.');
        }

        // Refetch and re-process so `id`/`_id` are normalized the same as other adapter results.
        var refetched = await mongoCollection.findOne(criteria);
        if (refetched) {
          processNativeRecord(refetched, WLModel, meta);
          // Mutate the original object in-place.
          _.each(_.keys(_record), function (k) {
            // Preserve the non-enumerable save method.
            if (k === 'save') { return; }
            delete _record[k];
          });
          _.extend(_record, refetched);
        }

        return _record;
      };

      if (typeof cb !== 'function') {
        return exec();
      }

      exec().then(function () { return cb(); }).catch(function (err) { return cb(err); });
    }
  });
};

