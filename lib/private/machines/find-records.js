module.exports = {


  friendlyName: 'Find (records)',


  description: 'Find record(s) in the database.',


  inputs: {
    query: require('../constants/query.input'),
    connection: require('../constants/connection.input'),
    dryOrm: require('../constants/dry-orm.input'),
  },


  exits: {

    success: {
      outputFriendlyName: 'Records',
      outputDescription: 'An array of physical records.',
      outputExample: '===' //[ {===} ]
    },

  },


  fn: function (inputs, exits) {
    // Dependencies
    var assert = require('assert');
    var _ = require('@sailshq/lodash');
    var processNativeRecord = require('./private/process-native-record');
    var attachSaveShim = require('./private/attach-save-shim');
    var buildMongoWhereClause = require('./private/build-mongo-where-clause');

    // Pre-flight check: if the MongoClient has been closed (e.g., by userland calling .close()),
    // fail fast with a clear error instead of the cryptic "Cannot use a session that has ended".
    try {
      var mc = inputs.connection && (inputs.connection._mongoClient || inputs.connection.client);
      if (mc && mc.topology && mc.topology.isDestroyed && mc.topology.isDestroyed()) {
        return exits.error(new Error(
          'The MongoDB connection for this datastore has been closed (topology destroyed).\n'+
          'This usually happens when userland code incorrectly calls `.close()` on a manager or client.\n'+
          'sails-mongo uses a shared MongoClient per datastore; do not close it manually.'
        ));
      }
    } catch (unusedErr) { /* ignore – just a best-effort check */ }

    // Local var for the stage 3 query, for easier access.
    var s3q = inputs.query;
    if (s3q.meta && s3q.meta.logMongoS3Qs) {
      console.log('* * * * * *\nADAPTER (FIND RECORDS):',require('util').inspect(s3q,{depth:10}),'\n');
    }

    // Local var for the `tableName`, for clarity.
    var tableName = s3q.using;

    // Grab the model definition
    var WLModel = _.find(inputs.dryOrm.models, {tableName: tableName});
    if (!WLModel) {
      return exits.error(new Error('No model with that tableName (`'+tableName+'`) has been registered with this adapter.  Were any unexpected modifications made to the stage 3 query?  Could the adapter\'s internal state have been corrupted?  (This error is usually due to a bug in this adapter\'s implementation.)'));
    }//-•

    // Grab the pk column name (for use below, e.g. forcing it into projections)
    var pkColumnName;
    try {
      pkColumnName = WLModel.attributes[WLModel.primaryKey].columnName;
    } catch (e) { return exits.error(e); }


    //  ┌┬┐┌─┐┌┐┌┌─┐┌─┐┬┌─┐┬ ┬  ╔═╗╦═╗╦╔╦╗╔═╗╦═╗╦╔═╗
    //  ││││ │││││ ┬│ ││├┤ └┬┘  ║  ╠╦╝║ ║ ║╣ ╠╦╝║╠═╣
    //  ┴ ┴└─┘┘└┘└─┘└─┘┴└   ┴   ╚═╝╩╚═╩ ╩ ╚═╝╩╚═╩╩ ╩

    var db = inputs.connection;
    var mongoCollection = db.collection(tableName);

    // Build a Mongo-style WHERE from the `where` clause.
    var mongoWhere;
    try {
      mongoWhere = buildMongoWhereClause(s3q.criteria.where, WLModel, s3q.meta);
    } catch (e) { return exits.error(e); }

    // if (s3q.meta && s3q.meta.logMongoS3Qs) {
    //   console.log('mongoWhere',require('util').inspect(mongoWhere,{depth:10}));
    //   console.log('mongoWhere["$and"] && typeof mongoWhere["$and"][0].driver_taxis.in[0]',require('util').inspect(mongoWhere['$and'] && typeof mongoWhere['$and'][0].driver_taxis.$in[0],{depth:10}));
    // }


    // Transform the `sort` clause from a stage 3 query into a Mongo sort.
    // Backwards compatibility:
    // Older Waterline / wrapper layers can pass `sort` in odd forms, e.g.
    // - a string: 'name ASC'
    // - a dictionary: { name: 'ASC' }
    // - an array of strings / dictionaries
    // - (occasionally) nonsense like `sort: 1` or arrays containing numbers
    // Normalize to an array of dictionaries, then ignore anything we still can't parse.
    var normalizedSort = (function normalizeSort(sortVal) {
      if (_.isUndefined(sortVal) || _.isNull(sortVal)) { return []; }
      if (_.isNumber(sortVal) || _.isBoolean(sortVal)) { return []; }
      if (_.isString(sortVal)) {
        // Support "col ASC" / "col DESC" / "col 1" / "col -1"
        var parts = sortVal.trim().split(/\s+/);
        var col = parts[0];
        var dir = (parts[1] || 'ASC');
        var d = {};
        d[col] = dir;
        return [d];
      }
      if (_.isObject(sortVal) && !_.isArray(sortVal)) {
        return [sortVal];
      }
      if (_.isArray(sortVal)) {
        return _.reduce(sortVal, function (memo, item) {
          if (_.isString(item)) {
            var p = item.trim().split(/\s+/);
            var c = p[0];
            var di = (p[1] || 'ASC');
            var dd = {};
            dd[c] = di;
            memo.push(dd);
            return memo;
          }
          if (_.isObject(item) && !_.isArray(item)) {
            memo.push(item);
            return memo;
          }
          // Ignore anything else (numbers, arrays, etc.)
          return memo;
        }, []);
      }
      return [];
    })(s3q.criteria.sort);

    var mongoSort = _.reduce(normalizedSort, function mapSort(memo, s3qSortDirective) {

      var mongoSortDirective = [];

      var sortByKey = _.first(_.keys(s3qSortDirective));
      if (!sortByKey) { return memo; }
      mongoSortDirective.push(sortByKey);

      var sortDirection = s3qSortDirective[sortByKey];
      // Backwards compatibility:
      // Older Waterline / wrappers can pass sort directions like 'asc'/'desc' or numeric 1/-1.
      // Normalize those and only assert as a last resort.
      if (_.isString(sortDirection)) {
        sortDirection = sortDirection.toUpperCase();
        if (sortDirection === 'ASC' || sortDirection === 'ASCENDING') { sortDirection = 'ASC'; }
        if (sortDirection === 'DESC' || sortDirection === 'DESCENDING') { sortDirection = 'DESC'; }
        if (sortDirection === '1') { sortDirection = 'ASC'; }
        if (sortDirection === '-1') { sortDirection = 'DESC'; }
      }
      if (sortDirection === 1) { sortDirection = 'ASC'; }
      if (sortDirection === -1) { sortDirection = 'DESC'; }

      // If we still can't interpret it, ignore this sort directive (better than crashing userland).
      if (!(sortDirection === 'ASC' || sortDirection === 'DESC')) {
        return memo;
      }
      mongoSortDirective.push(sortDirection === 'ASC' ? 1 : -1);

      memo.push(mongoSortDirective);
      return memo;

    }, []);

    // Create the initial Mongo deferred, taking care of `where`, `limit`, and `sort`.
    var mongoDeferred;
    try {
      assert(_.isNumber(s3q.criteria.limit), 'At this point, the limit should always be a number, but instead it is `'+s3q.criteria.limit+'`.  If you are seeing this message, there is probably a bug somewhere in your version of Waterline core.');
      mongoDeferred = mongoCollection.find(mongoWhere).limit(s3q.criteria.limit);
      if (mongoSort.length) {
        mongoDeferred = mongoDeferred.sort(mongoSort);
      }
    } catch (err) { return exits.error(err); }

    // Add in `select` if necessary.
    // (note that `select` _could_ be undefined--i.e. when a model is `schema: false`)
    if (s3q.criteria.select) {

      // Transform the stage-3 query select array into a Mongo projection dictionary.
      var projection = _.reduce(s3q.criteria.select, function reduceProjection(memo, colName) {
        memo[colName] = 1;
        return memo;
      }, {});

      // Always include the primary key column, so Waterline can build record instances
      // that are safe to `.save()` later (even if userland selected a subset of fields).
      //
      // Note: Mongo includes `_id` by default in inclusion projections, but the PK column
      // for the model may be aliased, and older configs/wrappers can behave inconsistently.
      if (pkColumnName) {
        projection[pkColumnName] = 1;
      }
      projection._id = 1;
      mongoDeferred = mongoDeferred.project(projection);
    }

    // Add in skip if necessary.
    // (if it is zero, no reason to mess with mixing it in at all)
    if (s3q.criteria.skip) {
      mongoDeferred.skip(s3q.criteria.skip);
    }


    //  ╔═╗╔═╗╔╦╗╔╦╗╦ ╦╔╗╔╦╔═╗╔═╗╔╦╗╔═╗  ┬ ┬┬┌┬┐┬ ┬  ┌┬┐┌┐
    //  ║  ║ ║║║║║║║║ ║║║║║║  ╠═╣ ║ ║╣   ││││ │ ├─┤   ││├┴┐
    //  ╚═╝╚═╝╩ ╩╩ ╩╚═╝╝╚╝╩╚═╝╩ ╩ ╩ ╚═╝  └┴┘┴ ┴ ┴ ┴  ─┴┘└─┘
    // Find the documents in the db.
    (async ()=>{
      var nativeResult = await mongoDeferred.toArray();

      //  ╔═╗╦═╗╔═╗╔═╗╔═╗╔═╗╔═╗  ┌┐┌┌─┐┌┬┐┬┬  ┬┌─┐  ┬─┐┌─┐┌─┐┌─┐┬─┐┌┬┐┌─┌─┐─┐
      //  ╠═╝╠╦╝║ ║║  ║╣ ╚═╗╚═╗  │││├─┤ │ │└┐┌┘├┤   ├┬┘├┤ │  │ │├┬┘ │││ └─┐ │
      //  ╩  ╩╚═╚═╝╚═╝╚═╝╚═╝╚═╝  ┘└┘┴ ┴ ┴ ┴ └┘ └─┘  ┴└─└─┘└─┘└─┘┴└──┴┘└─└─┘─┘
      // Process records (mutate in-place) to wash away adapter-specific eccentricities.
      var phRecords = nativeResult;
      try {
        _.each(phRecords, function (phRecord){
          processNativeRecord(phRecord, WLModel, s3q.meta);
          attachSaveShim(phRecord, mongoCollection, WLModel, s3q.meta);
        });
      } catch (e) { return exits.error(e); }


      // if (s3q.meta && s3q.meta.logMongoS3Qs) {
      //   console.log('found %d records',phRecords.length, require('util').inspect(phRecords,{depth:10}),'\n');
      // }
      return exits.success(phRecords);
    })().catch(function (err){
      return exits.error(err);
    });
  }

};
