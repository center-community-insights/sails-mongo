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

