module.exports = {


  friendlyName: 'Create (record)',


  description: 'Create a new physical record in the database.',


  inputs: {
    query: require('../constants/query.input'),
    connection: require('../constants/connection.input'),
    dryOrm: require('../constants/dry-orm.input'),
  },


  exits: {

    success: {
      outputFriendlyName: 'Record (maybe)',
      outputDescription: 'Either `null` or (if `fetch:true`) a dictionary representing the new record that was created.',
      outputExample: '==='
    },

    notUnique: require('../constants/not-unique.exit'),

  },


  fn: function (inputs, exits) {
    // Dependencies
    var util = require('util');
    var _ = require('@sailshq/lodash');
    var processNativeRecord = require('./private/process-native-record');
    var processNativeError = require('./private/process-native-error');
    var reifyValuesToSet = require('./private/reify-values-to-set');

    // Local var for the stage 3 query, for easier access.
    var s3q = inputs.query;
    if (s3q.meta && s3q.meta.logMongoS3Qs) {
      console.log('* * * * * *\nADAPTER (CREATE RECORD):',require('util').inspect(s3q,{depth:5}),'\n');
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


    //  ╦═╗╔═╗╦╔═╗╦ ╦  ┬  ┬┌─┐┬  ┬ ┬┌─┐┌─┐  ┌┬┐┌─┐  ┌─┐┌─┐┌┬┐
    //  ╠╦╝║╣ ║╠╣ ╚╦╝  └┐┌┘├─┤│  │ │├┤ └─┐   │ │ │  └─┐├┤  │
    //  ╩╚═╚═╝╩╚   ╩    └┘ ┴ ┴┴─┘└─┘└─┘└─┘   ┴ └─┘  └─┘└─┘ ┴
    try {
      reifyValuesToSet(s3q.newRecord, WLModel, s3q.meta);
    } catch (e) { return exits.error(e); }


    //  ╔╦╗╔═╗╔╦╗╔═╗╦═╗╔╦╗╦╔╗╔╔═╗  ┬ ┬┬ ┬┌─┐┌┬┐┬ ┬┌─┐┬─┐  ┌┬┐┌─┐  ╔═╗╔═╗╔╦╗╔═╗╦ ╦  ┌─┐┬─┐  ┌┐┌┌─┐┌┬┐
    //   ║║║╣  ║ ║╣ ╠╦╝║║║║║║║║╣   │││├─┤├┤  │ ├─┤├┤ ├┬┘   │ │ │  ╠╣ ║╣  ║ ║  ╠═╣  │ │├┬┘  ││││ │ │
    //  ═╩╝╚═╝ ╩ ╚═╝╩╚═╩ ╩╩╝╚╝╚═╝  └┴┘┴ ┴└─┘ ┴ ┴ ┴└─┘┴└─   ┴ └─┘  ╚  ╚═╝ ╩ ╚═╝╩ ╩  └─┘┴└─  ┘└┘└─┘ ┴
    var isFetchEnabled;
    if (s3q.meta && s3q.meta.fetch) { isFetchEnabled = true; }
    else { isFetchEnabled = false; }

    // Determine whether or not to use object ids.
    // (This mirrors the logic used in `processNativeRecord()` / `reifyValuesToSet()`.)
    var useObjectIds = !s3q.meta || !s3q.meta.modelsNotUsingObjectIds || !_.contains(s3q.meta.modelsNotUsingObjectIds, WLModel.identity);

    //  ╦╔╗╔╔═╗╔═╗╦═╗╔╦╗  ┬─┐┌─┐┌─┐┌─┐┬─┐┌┬┐
    //  ║║║║╚═╗║╣ ╠╦╝ ║   ├┬┘├┤ │  │ │├┬┘ ││
    //  ╩╝╚╝╚═╝╚═╝╩╚═ ╩   ┴└─└─┘└─┘└─┘┴└──┴┘
    // Create this new record in the database by inserting a document in the appropriate Mongo collection.
    // - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - -
    // FUTURE: Carry through the `fetch: false` optimization all the way to Mongo here,
    // if possible (e.g. using Mongo's projections API)
    // - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - -
    var db = inputs.connection;
    var mongoCollection = db.collection(tableName);
    (async ()=>{
      var insertRes;
      try {
        insertRes = await mongoCollection.insertOne(s3q.newRecord);
      } catch (err) {
        err = processNativeError(err);
        if (err.footprint && err.footprint.identity === 'notUnique') {
          return exits.notUnique(err);
        }
        return exits.error(err);
      }

      // If `fetch` is NOT enabled, we're done.
      if (!isFetchEnabled) {
        // But first, make sure the in-memory values reflect the generated PK.
        // This is important for record-instance `.save()` patterns that may happen immediately after create.
        // (Some legacy Waterline / nxus code relies on the PK being present on the returned record instance.)
        try {
          var insertedIdMaybe = insertRes.insertedId;
          if (!_.isUndefined(insertedIdMaybe)) {
            // Ensure the Mongo `_id` exists.
            if (_.isUndefined(s3q.newRecord._id)) {
              s3q.newRecord._id = insertedIdMaybe;
            }
            // Ensure the model's PK column is present.
            if (_.isUndefined(s3q.newRecord[pkColumnName])) {
              s3q.newRecord[pkColumnName] = insertedIdMaybe;
            }
            // Ensure `id` exists for compatibility.
            if (_.isUndefined(s3q.newRecord.id)) {
              s3q.newRecord.id = insertedIdMaybe;
            }

            // Prefer strings for ObjectId-backed models.
            if (useObjectIds && _.isObject(insertedIdMaybe) && insertedIdMaybe.toString) {
              var hex = insertedIdMaybe.toString();
              s3q.newRecord._id = hex;
              s3q.newRecord[pkColumnName] = hex;
              s3q.newRecord.id = hex;
            }
          }
        } catch (unusedErr) { /* ignore */ }
        // Return the created physical record anyway. (Even if `fetch` is false.)
        // Waterline core will ignore this result when `fetch` is disabled, but other wrappers
        // (and legacy code paths) may rely on it.
        return exits.success(s3q.newRecord);
      }//-•

      // Otherwise, IWMIH we'll be sending back a record:
      // ============================================
      var insertedId = insertRes.insertedId;

      var criteria = {};
      criteria[pkColumnName] = insertedId;
      var phRecord = await mongoCollection.findOne(criteria);

      if (!phRecord) {
        return exits.error(new Error('Consistency violation: Insert succeeded, but could not refetch the inserted record.  Inserted id: '+util.inspect(insertedId)));
      }

      // Process record (mutate in-place) to wash away adapter-specific eccentricities.
      try {
        processNativeRecord(phRecord, WLModel, s3q.meta);
      } catch (e) { return exits.error(e); }

      // Then send it back.
      return exits.success(phRecord);
    })().catch(function (err){
      return exits.error(err);
    });
  }
};
