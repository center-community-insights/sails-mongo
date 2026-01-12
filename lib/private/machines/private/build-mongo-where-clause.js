/**
 * Module dependencies
 */

var util = require('util');
var assert = require('assert');
var _ = require('@sailshq/lodash');
var normalizeMongoObjectId = require('./normalize-mongo-object-id');
var ObjectId = require('mongodb').ObjectID || require('mongodb').ObjectId;


/**
 * buildMongoWhereClause()
 *
 * Build a Mongo "query filter" from the specified S3Q `where` clause.
 * > Note: The provided `where` clause is NOT mutated.
 *
 * @param  {Dictionary} whereClause [`where` clause from the criteria of a S3Q]
 * @param  {Ref} WLModel
 * @param  {Dictionary?} meta       [`meta` query key from the s3q]
 *
 * @returns {Dictionary}            [Mongo "query filter"]
 */
module.exports = function buildMongoWhereClause(whereClause, WLModel, meta) {

  // Backwards compatibility:
  // Some older wrappers / query builders (including legacy Waterline usage) may pass an array
  // in place of a `where` dictionary.  Interpret this as an implicit AND.
  // (e.g. `where: [ {foo: 1}, {bar: 2} ]` => `{ and: [...] }`)
  if (_.isArray(whereClause)) {
    whereClause = { and: whereClause };
  }

  // Handle empty `where` clause.
  if (_.keys(whereClause).length === 0) {
    return whereClause;
  }

  // Clone the where clause so we don't mutate the original query object.
  // Important: avoid _.cloneDeep() because it can clobber instances (notably ObjectId),
  // which can lead to criteria silently failing and/or "invalid modifier" errors.
  whereClause = (function cloneDeepPreservingInstances(x) {
    if (_.isNull(x) || _.isUndefined(x)) { return x; }
    if (!_.isObject(x)) { return x; }
    if (x instanceof ObjectId) { return x; }
    if (x instanceof Date) { return x; }
    if (x instanceof RegExp) { return x; }
    if (Buffer && Buffer.isBuffer && Buffer.isBuffer(x)) { return x; }
    if (_.isArray(x)) {
      return _.map(x, cloneDeepPreservingInstances);
    }
    var out = {};
    _.each(x, function (val, key) {
      out[key] = cloneDeepPreservingInstances(val);
    });
    return out;
  })(whereClause);

  // Recursively build and return a transformed `where` clause for use with Mongo.
  var mongoQueryFilter = (function recurse(branch) {
    // Backwards compatibility:
    // Some legacy query styles pass arrays in nested branches; treat as implicit AND.
    if (_.isArray(branch)) {
      return recurse({ and: branch });
    }

    // Backwards compatibility:
    // Older Waterline / wrappers sometimes provide multiple constraints in a single dictionary,
    // e.g. `{ sid: 'abc', or: [ ... ] }` (implicit AND).
    // Waterline stage-3 "where" is typically normalized so each branch has a single key.
    // If we see multiple keys here, normalize to `{ and: [ {k1:v1}, {k2:v2}, ... ] }`.
    if (_.isObject(branch) && !_.isFunction(branch) && !_.isNull(branch) && _.keys(branch).length > 1) {
      var keys = _.keys(branch);
      return recurse({ and: _.map(keys, function (k) {
        var sub = {};
        sub[k] = branch[k];
        return sub;
      }) });
    }

    var loneKey = _.first(_.keys(branch));

    //  ╔═╗╦═╗╔═╗╔╦╗╦╔═╗╔═╗╔╦╗╔═╗
    //  ╠═╝╠╦╝║╣  ║║║║  ╠═╣ ║ ║╣
    //  ╩  ╩╚═╚═╝═╩╝╩╚═╝╩ ╩ ╩ ╚═╝
    if (loneKey === 'and' || loneKey === 'or') {
      var conjunctsOrDisjuncts = branch[loneKey];
      branch['$' + loneKey] = _.map(conjunctsOrDisjuncts, function(conjunctOrDisjunct){
        return recurse(conjunctOrDisjunct);
      });
      delete branch[loneKey];
      return branch;
    }//-•

    // IWMIH, we're dealing with a constraint of some kind.
    var constraintColumnName = loneKey;
    var constraint = branch[constraintColumnName];

    // Backwards compatibility:
    // In older Waterline / legacy usage, it's common to see "array means IN":
    //   { id: [a,b,c] }  (rather than { id: { in: [a,b,c] } })
    // If we see an array constraint, normalize it into an `in` modifier dictionary.
    if (_.isArray(constraint)) {
      branch[constraintColumnName] = { in: constraint };
      constraint = branch[constraintColumnName];
    }


    // Determine whether we should compare as an object id.
    //
    // > i.e. determine if this constraint applies to either the primary key attribute
    // > or a foreign key attribute (singular assoc.)
    // >
    // > We'll use this below to apply the conventional behavior of searching
    // > by ObjectID.  That is, if this constraint applies to a PK or FK, then
    // > try to convert the eq constraint / relevant modifier into an ObjectId
    // > instance, if possible. (We still gracefully fall back to tolerate
    // > filtering by pk/fk vs. miscellaneous strings.)
    var doCompareAsObjectIdIfPossible;

    assert(_.isString(WLModel.primaryKey) && WLModel.primaryKey, 'Model def should always have a `primaryKey` setting by the time the model definition is handed down to the adapter (this should have already been taken care of in WL core)');
    var pkAttrDef = WLModel.attributes[WLModel.primaryKey];
    assert(_.isObject(pkAttrDef), 'PK attribute should always exist (this should have already been taken care of in WL core)');
    var pkColumnName = pkAttrDef.columnName;
    assert(_.isString(pkColumnName) && pkColumnName, 'PK attribute should always have a column name by the time the model definition is handed down to the adapter (this should have already been taken care of in WL core).  But actual pk attribute def on the model looks like this: '+util.inspect(pkAttrDef, {depth:5})+'');

    if (constraintColumnName === pkColumnName && !WLModel.dontUseObjectIds && (!meta || !meta.modelsNotUsingObjectIds || !_.contains(meta.modelsNotUsingObjectIds, WLModel.identity))) {
      doCompareAsObjectIdIfPossible = true;
      // Backwards compatibility:
      // Historically, some Waterline setups queried by `id` even though Mongo stored the PK in `_id`.
      // In those cases, remap `id` -> `_id`.
      //
      // IMPORTANT: Do NOT blindly remap non-`id` primary keys (e.g. connect-waterline sessions uses `sid`
      // as the primary key stored in a real `sid` column, while Mongo still maintains its own `_id`).
      if (pkColumnName !== '_id' && (WLModel.primaryKey === 'id' || pkColumnName === 'id')) {
        branch._id = branch[constraintColumnName];
        delete branch[constraintColumnName];
        constraintColumnName = '_id';
      }
    }
    else {
      _.each(WLModel.attributes, function (attrDef /*, attrName */) {
        var isForeignKey = !!attrDef.model;
        // Sanity checks - relaxed for Waterline 0.12 compatibility:
        // Waterline 0.12 may not set `foreignKey: true` on attributes with `model`.
        // We infer isForeignKey from the presence of `model` property instead.
        // (The original assertions are commented out to maintain backwards compatibility)
        // if (isForeignKey) {
        //   assert(attrDef.foreignKey, 'attribute has a `model` property, but wl-schema did not give it `foreignKey: true`!');
        // }
        // else {
        //   assert(!attrDef.foreignKey, 'wl-schema gave this attribute `foreignKey: true`, but it has no `model` property!');
        // }

        if (!isForeignKey) { return; }
        if (constraintColumnName === attrDef.columnName && (!meta || !meta.modelsNotUsingObjectIds || !_.contains(meta.modelsNotUsingObjectIds, attrDef.model))) {
          doCompareAsObjectIdIfPossible = true;
        }
      });
    }

    //  ╔═╗╔═╗   ╔═╗╔═╗╔╗╔╔═╗╔╦╗╦═╗╔═╗╦╔╗╔╔╦╗
    //  ║╣ ║═╬╗  ║  ║ ║║║║╚═╗ ║ ╠╦╝╠═╣║║║║ ║
    //  ╚═╝╚═╝╚  ╚═╝╚═╝╝╚╝╚═╝ ╩ ╩╚═╩ ╩╩╝╚╝ ╩
    // Treat certain object instances as scalar eq constraints (not modifier dictionaries).
    // (e.g. allow userland to pass an ObjectId instance directly)
    if (
      _.isString(constraint) ||
      _.isNumber(constraint) ||
      _.isBoolean(constraint) ||
      _.isNull(constraint) ||
      (constraint instanceof ObjectId) ||
      (constraint instanceof Date) ||
      (constraint instanceof RegExp)
    ) {

      if (doCompareAsObjectIdIfPossible && _.isString(constraint)) {
        try {
          // Backwards compatibility:
          // Some legacy systems store `_id` (or FK fields) as a STRING that *looks* like a 24-hex ObjectId.
          // If we always convert criteria to ObjectId, those records become unfindable and apps will
          // "create new records every request" (e.g. session stores).
          //
          // To remain compatible with both storage styles, match BOTH the ObjectId and the original string.
          var objectified = normalizeMongoObjectId(constraint);
          branch[constraintColumnName] = { '$in': [objectified, constraint] };
        } catch (e) {
          switch (e.code) {
            case 'E_CANNOT_INTERPRET_AS_OBJECTID': break;
            default: throw e;
          }
        }
      }//>-

      return branch;
    }//-•

    //  ╔═╗╔═╗╔╦╗╔═╗╦  ╔═╗═╗ ╦  ╔═╗╔═╗╔╗╔╔═╗╔╦╗╦═╗╔═╗╦╔╗╔╔╦╗
    //  ║  ║ ║║║║╠═╝║  ║╣ ╔╩╦╝  ║  ║ ║║║║╚═╗ ║ ╠╦╝╠═╣║║║║ ║
    //  ╚═╝╚═╝╩ ╩╩  ╩═╝╚═╝╩ ╚═  ╚═╝╚═╝╝╚╝╚═╝ ╩ ╩╚═╩ ╩╩╝╚╝ ╩
    var modifierKind = _.first(_.keys(constraint));
    var modifier = constraint[modifierKind];
    delete constraint[modifierKind];


    switch (modifierKind) {

      case '<':
        constraint['$lt'] = modifier;
        break;

      case '<=':
        constraint['$lte'] = modifier;
        break;

      case '>':
        constraint['$gt'] = modifier;
        break;

      case '>=':
        constraint['$gte'] = modifier;
        break;

      case '!=':

        // Same as above: Convert mongo id(s) to ObjectId instance(s) if appropriate/possible.
        if (doCompareAsObjectIdIfPossible && _.isString(modifier)) {
          try {
            var objNe = normalizeMongoObjectId(modifier);
            // Backwards compatibility: exclude both objectId and string forms.
            constraint['$nin'] = [objNe, modifier];
            break;
          } catch (e) {
            switch (e.code) {
              case 'E_CANNOT_INTERPRET_AS_OBJECTID': break;
              default: throw e;
            }
          }
        }//>-

        constraint['$ne'] = modifier;

        break;

      case 'nin':

        // Same as above: Convert mongo id(s) to ObjectId instance(s) if appropriate/possible.
        // Backwards compatibility: exclude both objectId and string forms where applicable.
        modifier = _.reduce(modifier, function (memo, item) {
          if (doCompareAsObjectIdIfPossible && _.isString(item)) {
            try {
              memo.push(normalizeMongoObjectId(item));
            } catch (e) {
              switch (e.code) {
                case 'E_CANNOT_INTERPRET_AS_OBJECTID': break;
                default: throw e;
              }
            }
          }//>-
          memo.push(item);
          return memo;
        }, []);

        constraint['$nin'] = modifier;
        break;

      case 'in':

        // console.log('original `in` modifier:', modifier);
        // console.log('typeof the first one:', typeof modifier[0]);
        // console.log('doCompareAsObjectIdIfPossible:', doCompareAsObjectIdIfPossible);

        // Same as above: Convert mongo id(s) to ObjectId instance(s) if appropriate/possible.
        // Backwards compatibility: include both objectId and string forms where applicable.
        modifier = _.reduce(modifier, function (memo, item) {
          if (doCompareAsObjectIdIfPossible && _.isString(item)) {
            try {
              memo.push(normalizeMongoObjectId(item));
            } catch (e) {
              switch (e.code) {
                case 'E_CANNOT_INTERPRET_AS_OBJECTID': break;
                default: throw e;
              }
            }
          }//>-
          memo.push(item);
          return memo;
        }, []);
        // console.log('Mongo-ified $in:', modifier);
        // console.log('typeof the first one:', typeof modifier[0]);

        constraint['$in'] = modifier;
        break;

      case 'like':
        // Allow multi-line matching (historical behavior in sails-mongo).
        // Use [\s\S]* instead of .* so newlines are included.
        constraint['$regex'] = new RegExp('^' + _.escapeRegExp(modifier).replace(/^%/, '[\\s\\S]*').replace(/([^\\])%/g, '$1[\\s\\S]*').replace(/\\%/g, '%') + '$');
        if (meta && meta.makeLikeModifierCaseInsensitive && _.isBoolean(meta.makeLikeModifierCaseInsensitive)) {
          constraint['$options'] = 'i';
        }
        break;

      case 'contains':
        // Backwards compatibility with legacy Waterline criteria:
        // - for strings, `contains` means substring match (including newlines)
        // - for arrays / non-strings, treat as membership (`$in`) / set containment (`$all`)
        if (_.isArray(modifier)) {
          constraint['$all'] = modifier;
        }
        else if (_.isString(modifier)) {
          constraint['$regex'] = new RegExp(_.escapeRegExp(modifier));
          if (meta && meta.makeContainsModifierCaseInsensitive && _.isBoolean(meta.makeContainsModifierCaseInsensitive)) {
            constraint['$options'] = 'i';
          }
        }
        else {
          constraint['$in'] = [modifier];
        }
        break;

      case 'startsWith':
        constraint['$regex'] = new RegExp('^' + _.escapeRegExp(modifier).replace(/\\n/g, '\n'));
        if (meta && meta.makeStartsWithModifierCaseInsensitive && _.isBoolean(meta.makeStartsWithModifierCaseInsensitive)) {
          constraint['$options'] = 'i';
        }
        break;

      case 'endsWith':
        constraint['$regex'] = new RegExp(_.escapeRegExp(modifier).replace(/\\n/g, '\n') + '$');
        if (meta && meta.makeEndsWithModifierCaseInsensitive && _.isBoolean(meta.makeEndsWithModifierCaseInsensitive)) {
          constraint['$options'] = 'i';
        }
        break;

      default:
        throw new Error('Consistency violation: `where` clause modifier `' + modifierKind + '` is not valid!  This should never happen-- a stage 3 query should have already been normalized in Waterline core.');

    }

    return branch;
  })(whereClause);

  // Return the "mongo query filter".
  // (see https://docs.mongodb.com/manual/core/document/#document-query-filter)
  return mongoQueryFilter;
};
