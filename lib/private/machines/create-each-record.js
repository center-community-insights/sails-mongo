module.exports = {


  friendlyName: 'Create each (record)',


  description: 'Insert multiple records into a collection in the database.',


  inputs: {
    query: require('../constants/query.input'),
    connection: require('../constants/connection.input'),
    dryOrm: require('../constants/dry-orm.input'),
  },


  exits: {

    success: {
      outputFriendlyName: 'Records (maybe)',
      outputDescription: 'Either `null` or (if `fetch:true`) an array of new physical records that were created.',
      outputExample: '==='
    },

    notUnique: require('../constants/not-unique.exit'),

  },


  fn: function (inputs, exits) {
    // Dependencies
    var _ = require('@sailshq/lodash');
    var processNativeRecord = require('./private/process-native-record');
    var attachSaveShim = require('./private/attach-save-shim');
    var processNativeError = require('./private/process-native-error');
    var reifyValuesToSet = require('./private/reify-values-to-set');



    // Local var for the stage 3 query, for easier access.
    var s3q = inputs.query;
    if (s3q.meta && s3q.meta.logMongoS3Qs) {
      console.log('* * * * * *\nADAPTER (CREATE EACH RECORD):',require('util').inspect(s3q,{depth:5}),'\n');
    }

    // Local var for the `tableName`, for clarity.
    var tableName = s3q.using;

    // Grab the model definition
    var WLModel = _.find(inputs.dryOrm.models, {tableName: tableName});
    if (!WLModel) {
      return exits.error(new Error('No model with that tableName (`'+tableName+'`) has been registered with this adapter.  Were any unexpected modifications made to the stage 3 query?  Could the adapter\'s internal state have been corrupted?  (This error is usually due to a bug in this adapter\'s implementation.)'));
    }//-•

    // Grab the pk column name (for use below)
    var pkColumnName;
    try {
      pkColumnName = WLModel.attributes[WLModel.primaryKey].columnName;
    } catch (e) { return exits.error(e); }


    //  ╦═╗╔═╗╦╔═╗╦ ╦  ┌─┐┌─┐┌─┐┬ ┬  ┌┐┌┌─┐┬ ┬  ┬─┐┌─┐┌─┐┌─┐┬─┐┌┬┐
    //  ╠╦╝║╣ ║╠╣ ╚╦╝  ├┤ ├─┤│  ├─┤  │││├┤ │││  ├┬┘├┤ │  │ │├┬┘ ││
    //  ╩╚═╚═╝╩╚   ╩   └─┘┴ ┴└─┘┴ ┴  ┘└┘└─┘└┴┘  ┴└─└─┘└─┘└─┘┴└──┴┘
    try {
      _.each(s3q.newRecords, function (newRecord){
        reifyValuesToSet(newRecord, WLModel, s3q.meta);
      });
    } catch (e) { return exits.error(e); }


    //  ╔╦╗╔═╗╔╦╗╔═╗╦═╗╔╦╗╦╔╗╔╔═╗  ┬ ┬┬ ┬┌─┐┌┬┐┬ ┬┌─┐┬─┐  ┌┬┐┌─┐  ╔═╗╔═╗╔╦╗╔═╗╦ ╦  ┌─┐┬─┐  ┌┐┌┌─┐┌┬┐
    //   ║║║╣  ║ ║╣ ╠╦╝║║║║║║║║╣   │││├─┤├┤  │ ├─┤├┤ ├┬┘   │ │ │  ╠╣ ║╣  ║ ║  ╠═╣  │ │├┬┘  ││││ │ │
    //  ═╩╝╚═╝ ╩ ╚═╝╩╚═╩ ╩╩╝╚╝╚═╝  └┴┘┴ ┴└─┘ ┴ ┴ ┴└─┘┴└─   ┴ └─┘  ╚  ╚═╝ ╩ ╚═╝╩ ╩  └─┘┴└─  ┘└┘└─┘ ┴
    var isFetchEnabled;
    if (s3q.meta && s3q.meta.fetch) { isFetchEnabled = true; }
    else { isFetchEnabled = false; }

    // Determine whether or not to use object ids.
    // Check model-level flag (for legacy Waterline models with string PKs) or meta.modelsNotUsingObjectIds.
    var useObjectIds = !WLModel.dontUseObjectIds && (!s3q.meta || !s3q.meta.modelsNotUsingObjectIds || !_.contains(s3q.meta.modelsNotUsingObjectIds, WLModel.identity));

    //  ╔═╗╔═╗╔╦╗╔╦╗╦ ╦╔╗╔╦╔═╗╔═╗╔╦╗╔═╗  ┬ ┬┬┌┬┐┬ ┬  ┌┬┐┌┐
    //  ║  ║ ║║║║║║║║ ║║║║║║  ╠═╣ ║ ║╣   ││││ │ ├─┤   ││├┴┐
    //  ╚═╝╚═╝╩ ╩╩ ╩╚═╝╝╚╝╩╚═╝╩ ╩ ╩ ╚═╝  └┴┘┴ ┴ ┴ ┴  ─┴┘└─┘
    // Create these new records in the database by inserting documents in the appropriate Mongo collection.
    // - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - -
    // FUTURE: Carry through the `fetch: false` optimization all the way to Mongo here,
    // if possible (e.g. using Mongo's projections API)
    // - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - -
    var db = inputs.connection;
    var mongoCollection = db.collection(tableName);
    // if (s3q.meta && s3q.meta.logMongoS3Qs) {
    //   console.log('- - - - - - -  - - -CREATE EACH: s3q.newRecords:',require('util').inspect(s3q.newRecords,{depth:5}),'\n');
    // }
    (async ()=>{
      var insertRes;
      try {
        insertRes = await mongoCollection.insertMany(s3q.newRecords);
      } catch (err) {
        err = processNativeError(err);
        if (err.footprint && err.footprint.identity === 'notUnique') {
          return exits.notUnique(err);
        }
        return exits.error(err);
      }

      // If `fetch` is NOT enabled, we're done.
      if (!isFetchEnabled) {
        // Like in create-record, ensure generated PKs are applied back to the in-memory values
        // so any immediate `.save()` patterns won't fail due to missing primary keys.
        try {
          var insertedIdsByIndex = insertRes.insertedIds || {};
          _.each(_.keys(insertedIdsByIndex), function (idx) {
            var insertedIdMaybe = insertedIdsByIndex[idx];
            var rec = s3q.newRecords[idx];
            if (!rec || _.isUndefined(insertedIdMaybe)) { return; }

            if (_.isUndefined(rec._id)) { rec._id = insertedIdMaybe; }
            if (_.isUndefined(rec[pkColumnName])) { rec[pkColumnName] = insertedIdMaybe; }
            if (_.isUndefined(rec.id)) { rec.id = insertedIdMaybe; }

            if (useObjectIds && _.isObject(insertedIdMaybe) && insertedIdMaybe.toString) {
              var hex = insertedIdMaybe.toString();
              rec._id = hex;
              rec[pkColumnName] = hex;
              rec.id = hex;
            }
          });
        } catch (unusedErr) { /* ignore */ }
        // Return the created physical records anyway. (Even if `fetch` is false.)
        // Waterline core will ignore this result when `fetch` is disabled, but other wrappers
        // (and legacy code paths) may rely on it.
        try {
          _.each(s3q.newRecords, function (rec) { attachSaveShim(rec, mongoCollection, WLModel, s3q.meta); });
        } catch (unusedErr) { /* ignore */ }
        return exits.success(s3q.newRecords);
      }//-•

      // Otherwise, IWMIH we'll be sending back records:
      // ============================================
      var insertedIds = _.values(insertRes.insertedIds);

      var criteria = {};
      // Backwards compatibility:
      // If the model's PK is NOT `_id`, we must refetch based on the inserted PK values
      // (e.g. connect-waterline sessions uses `sid` as PK).  In that case, Mongo may still
      // generate `_id` ObjectIds, but those are not the primary key for the model.
      if (pkColumnName !== '_id') {
        criteria[pkColumnName] = { '$in': _.pluck(s3q.newRecords, pkColumnName) };
      } else {
        criteria[pkColumnName] = { '$in': insertedIds };
      }
      var phRecords = await mongoCollection.find(criteria).toArray();

      // Process record(s) (mutate in-place) to wash away adapter-specific eccentricities.
      try {
        _.each(phRecords, function (phRecord){
          processNativeRecord(phRecord, WLModel, s3q.meta);
          attachSaveShim(phRecord, mongoCollection, WLModel, s3q.meta);
        });
      } catch (e) { return exits.error(e); }

      return exits.success(phRecords);
    })().catch(function (err){
      return exits.error(err);
    });

  }
};
