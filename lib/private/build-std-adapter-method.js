/**
 * Module dependencies
 */

var _ = require('@sailshq/lodash');
var Machine = require('machine');
var doWithConnection = require('./do-with-connection');


/**
 * buildStdAdapterMethod()
 *
 * Build a generic DQL/DML adapter method from a machine definition and available state.
 *
 * Example usage:
 * ```
 * create: buildStdAdapterMethod(helpCreate, WET_MACHINES, registeredDsEntries, registeredDryModels),
 * ```
 *
 * > NOTE:
 * > This is a stopgap.
 *
 * - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - -
 * @param  {Dictionary} machineDef  (dry)
 * @param  {Dictionary} WET_MACHINES  (for convenience)
 * @param  {Dictionary} registeredDsEntries
 * @param  {Dictionary} registeredDryModels
 * - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - -
 * @returns {Function}
 *          @param {String} datastoreName
 *          @param {Dictionary} s3q
 *          @param {Function} done
 * - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - -
 */
module.exports = function buildStdAdapterMethod (machineDef, WET_MACHINES, registeredDsEntries, registeredDryModels) {

  // Build wet machine.
  var performQuery = Machine.build(machineDef);

  // Return function that will be the adapter method.
  return function () {

    // Support a few calling conventions (some wrappers pass `meta` separately, or omit `done` and use promises).
    // The canonical Waterline v0.13 adapter signature is:
    //   (datastoreName, s3q, done)
    //
    // But in the wild we also see:
    //   (datastoreName, s3q, meta, done)
    //   (datastoreName, tableName, s3q, meta, done)   (older wrappers)
    //   (...args) with no `done` (promise-style)
    var args = Array.prototype.slice.call(arguments);

    // Find callback (if any).  Use the last function argument.
    var done;
    for (var i = args.length - 1; i >= 0; i--) {
      if (typeof args[i] === 'function') {
        done = args[i];
        break;
      }
    }

    // Attempt to locate the stage-3 query.
    var s3q;
    for (var j = 0; j < args.length; j++) {
      if (!args[j] || typeof args[j] !== 'object') { continue; }

      // A stage-3 Waterline query is a dictionary that always includes `using` (table/collection name),
      // and then includes *different* properties depending on method (e.g. `criteria` for find/update/destroy,
      // `newRecord` for create, `valuesToSet` for update, `numericAttrName` for sum/avg, etc.)
      if (typeof args[j].using === 'string' && (
        args[j].criteria ||
        args[j].newRecord ||
        args[j].valuesToSet ||
        args[j].numericAttrName ||
        args[j].method
      )) {
        s3q = args[j];
        break;
      }
    }

    // Attempt to locate datastore name.
    var datastoreName;
    // Prefer any string arg that matches a registered datastore entry.
    for (var k = 0; k < args.length; k++) {
      if (typeof args[k] === 'string' && registeredDsEntries[args[k]]) {
        datastoreName = args[k];
        break;
      }
    }
    // Otherwise, fall back to the first string argument.
    if (!datastoreName) {
      for (var kk = 0; kk < args.length; kk++) {
        if (typeof args[kk] === 'string') {
          datastoreName = args[kk];
          break;
        }
      }
    }
    // Or look for identity on a passed-in datastore config.
    if (!datastoreName) {
      for (var kkk = 0; kkk < args.length; kkk++) {
        if (args[kkk] && typeof args[kkk] === 'object' && typeof args[kkk].identity === 'string') {
          datastoreName = args[kkk].identity;
          break;
        }
      }
    }
    // Or try meta hints.
    if (!datastoreName && s3q && s3q.meta) {
      datastoreName = s3q.meta.datastore || s3q.meta.datastoreName || s3q.meta.connection || s3q.meta.connectionName;
    }

    // If no s3q was passed, attempt to adapt legacy calling conventions into an s3q.
    // This helps compatibility with wrappers (and older Waterline internals) that still call adapters like:
    //   (datastoreName, tableName, criteria, cb)
    //   (datastoreName, tableName, valuesToSet, criteria, cb)
    //   (datastoreName, tableName, records, cb)
    //
    // Note: We only do this if we didn't already find an s3q.
    if (!s3q) {
      // Try to find tableName (a string arg that is NOT the datastoreName).
      var tableName;
      for (var t = 0; t < args.length; t++) {
        if (typeof args[t] === 'string' && args[t] !== datastoreName) {
          tableName = args[t];
          break;
        }
      }

      // Try to find a criteria-like dictionary.
      var criteria;
      for (var c = 0; c < args.length; c++) {
        if (!args[c] || typeof args[c] !== 'object' || Array.isArray(args[c])) { continue; }
        if (args[c].where || args[c].limit !== undefined || args[c].skip !== undefined || args[c].sort || args[c].select) {
          criteria = args[c];
          break;
        }
      }

      // Try to find a record/values dictionary (for create/update).
      var values;
      for (var v = 0; v < args.length; v++) {
        if (!args[v] || typeof args[v] !== 'object' || Array.isArray(args[v])) { continue; }
        if (args[v] !== criteria && !args[v].where && !args[v].criteria && !args[v].using) {
          values = args[v];
          break;
        }
      }

      // Try to find an array of records (for createEach).
      var records;
      for (var r = 0; r < args.length; r++) {
        if (Array.isArray(args[r])) {
          records = args[r];
          break;
        }
      }

      // Try to find a numericAttrName (for sum/avg).
      var numericAttrName;
      for (var n = 0; n < args.length; n++) {
        if (typeof args[n] === 'string' && args[n] !== datastoreName && args[n] !== tableName) {
          numericAttrName = args[n];
          break;
        }
      }

      var friendly = (machineDef.friendlyName || '').toLowerCase();
      if (friendly.indexOf('find') !== -1) {
        criteria = criteria || {};
        if (!criteria.where) { criteria.where = {}; }
        if (criteria.limit === undefined) { criteria.limit = 2147483647; }
        if (criteria.skip === undefined) { criteria.skip = 0; }
        if (!criteria.sort) { criteria.sort = []; }
        s3q = { method: 'find', using: tableName, criteria: criteria, meta: {} };
      }
      else if (friendly.indexOf('count') !== -1) {
        criteria = criteria || {};
        if (!criteria.where) { criteria.where = {}; }
        s3q = { method: 'count', using: tableName, criteria: criteria, meta: {} };
      }
      else if (friendly.indexOf('sum') !== -1) {
        criteria = criteria || {};
        if (!criteria.where) { criteria.where = {}; }
        s3q = { method: 'sum', using: tableName, criteria: criteria, numericAttrName: numericAttrName, meta: {} };
      }
      else if (friendly.indexOf('avg') !== -1) {
        criteria = criteria || {};
        if (!criteria.where) { criteria.where = {}; }
        s3q = { method: 'avg', using: tableName, criteria: criteria, numericAttrName: numericAttrName, meta: {} };
      }
      else if (friendly.indexOf('update') !== -1) {
        criteria = criteria || {};
        if (!criteria.where) { criteria.where = {}; }
        s3q = { method: 'update', using: tableName, criteria: criteria, valuesToSet: values || {}, meta: {} };
      }
      else if (friendly.indexOf('destroy') !== -1) {
        criteria = criteria || {};
        if (!criteria.where) { criteria.where = {}; }
        s3q = { method: 'destroy', using: tableName, criteria: criteria, meta: {} };
      }
      else if (friendly.indexOf('create each') !== -1) {
        s3q = { method: 'createEach', using: tableName, newRecords: records || [], meta: {} };
      }
      else if (friendly.indexOf('create') !== -1) {
        s3q = { method: 'create', using: tableName, newRecord: values || {}, meta: {} };
      }
    }

    // Helper to run logic once args are normalized.
    var run = function (_datastoreName, _s3q, _done) {

      // Look up the datastore entry (to get the manager).
      var dsEntry = registeredDsEntries[_datastoreName];

      // Sanity checks:
      if (!_datastoreName) {
        return _done(new Error('Consistency violation: Missing datastore name when invoking adapter method.  (This may be due to a wrapper calling this adapter with an unexpected signature.)'));
      }
      if (!_s3q) {
        return _done(new Error('Consistency violation: Missing stage-3 query (s3q) when invoking adapter method.  (This may be due to a wrapper calling this adapter with an unexpected signature.)'));
      }
      if (_.isUndefined(dsEntry)) {
        return _done(new Error('Consistency violation: Cannot do that with datastore (`'+_datastoreName+'`) because no matching datastore entry is registered in this adapter!  This is usually due to a race condition (e.g. a lifecycle callback still running after the ORM has been torn down), or it could be due to a bug in this adapter.  (If you get stumped, reach out at http://sailsjs.com/support.)'));
      }

      // Obtain a connection.
      doWithConnection({
        WET_MACHINES: WET_MACHINES,
        manager: dsEntry.manager,
        connection: (_s3q.meta && _s3q.meta.leasedConnection) || undefined,
        meta: _s3q.meta,
        during: function (connection, proceed) {

          var handlers = {
            error: function (err) { return proceed(err); },
            success: function (result) { return proceed(undefined, result); }
          };
          // If this machine has a `notUnique` exit, then set up a `notUnique` handler.
          // > (Note that `err.footprint` should already be attached, so there's no need to mess w/ it.)
          if (machineDef.exits.notUnique) {
            handlers.notUnique = function (err) { return proceed(err); };
          }

          // Perform the query (and if relevant, send back a result.)
          performQuery({
            query: _s3q,
            connection: connection,
            dryOrm: { models: registeredDryModels }
          }).switch(handlers);

        }//</:during>
      }, _done);//</doWithConnection()>

    };//</run>

    // If `done` was not provided, return a promise.
    if (typeof done !== 'function') {
      return new Promise(function (resolve, reject) {
        return run(datastoreName, s3q, function (err, result) {
          if (err) { return reject(err); }
          return resolve(result);
        });
      });
    }

    return run(datastoreName, s3q, done);

  };//</returned function def>

};

