/**
 * Module dependencies
 */

var util = require('util');
var _ = require('@sailshq/lodash');
var flaverr = require('flaverr');
var async = require('async');
var Machine = require('machine');
var mongodb = require('mongodb');
function isErrorLike(x) {
  return Object.prototype.toString.call(x) === '[object Error]' || x instanceof Error;
}
var normalizeDatastoreConfig = require('./private/normalize-datastore-config');
var buildStdAdapterMethod = require('./private/build-std-adapter-method');


/**
 * Module constants
 */

// Private var to cache dry machine definitions.
// > This is set up in a dictionary instead of as separate variables
// > just to allow the code below to be a bit easier to read)
var DRY_MACHINES = {
  verifyModelDef: require('./private/machines/verify-model-def'),
  createManager: require('./private/machines/create-manager'),
  destroyManager: require('./private/machines/destroy-manager'),
  getConnection: require('./private/machines/get-connection'),
  releaseConnection: require('./private/machines/release-connection'),
  definePhysicalModel: require('./private/machines/define-physical-model'),
  dropPhysicalModel: require('./private/machines/drop-physical-model'),
  setPhysicalSequence: require('./private/machines/set-physical-sequence'),
};


// Private var to cache pre-built machines for certain adapter methods.
// (This is an optimization for improved performance.)
var WET_MACHINES = {};
_.each(DRY_MACHINES, function(def, methodName) {
  WET_MACHINES[methodName] = Machine.build(def);
});


var CONFIG_WHITELIST = require('./private/constants/config-whitelist.constant');


var EXPECTED_URL_PROTOCOL_PFX = require('./private/constants/expected-url-protocol-pfx.constant');



/**
 * Module state
 */

// Private vars to track of all the datastores + model definitions registered with this adapter.
//
// IMPORTANT:
// In real apps (especially with `npm link`, monorepos, or transpiled wrappers), it is possible to end up
// with more than one copy of `sails-mongo` loaded in the same Node process.  Waterline will call
// `registerDatastore()` on one instance, but later route queries to another instance — which would
// otherwise have an empty in-module registry and fail with "no matching datastore entry".
//
// To make this robust, store the registry on `global` so all loaded copies share the same state.
var GLOBAL_STATE = global.__SAILS_MONGO_ADAPTER_STATE__;
if (!GLOBAL_STATE) {
  GLOBAL_STATE = global.__SAILS_MONGO_ADAPTER_STATE__ = {
    registeredDsEntries: {},
    registeredDryModels: {},
    datastoreWaiters: {}
  };
}

var registeredDsEntries = GLOBAL_STATE.registeredDsEntries;
var registeredDryModels = GLOBAL_STATE.registeredDryModels;
GLOBAL_STATE.numRegisterDatastoreCalls = GLOBAL_STATE.numRegisterDatastoreCalls || 0;

// Private helper for waiting on a datastore to be registered in this Node process.
function _getOrCreateDatastoreWaiter(datastoreName) {
  var existing = GLOBAL_STATE.datastoreWaiters[datastoreName];
  if (existing) { return existing; }
  var resolve;
  var reject;
  var promise = new Promise(function (res, rej) {
    resolve = res;
    reject = rej;
  });
  GLOBAL_STATE.datastoreWaiters[datastoreName] = { promise: promise, resolve: resolve, reject: reject };
  return GLOBAL_STATE.datastoreWaiters[datastoreName];
}



/**
 *  ███████╗ █████╗ ██╗██╗     ███████╗      ███╗   ███╗ ██████╗ ███╗   ██╗ ██████╗  ██████╗
 *  ██╔════╝██╔══██╗██║██║     ██╔════╝      ████╗ ████║██╔═══██╗████╗  ██║██╔════╝ ██╔═══██╗
 *  ███████╗███████║██║██║     ███████╗█████╗██╔████╔██║██║   ██║██╔██╗ ██║██║  ███╗██║   ██║
 *  ╚════██║██╔══██║██║██║     ╚════██║╚════╝██║╚██╔╝██║██║   ██║██║╚██╗██║██║   ██║██║   ██║
 *  ███████║██║  ██║██║███████╗███████║      ██║ ╚═╝ ██║╚██████╔╝██║ ╚████║╚██████╔╝╚██████╔╝
 *  ╚══════╝╚═╝  ╚═╝╚═╝╚══════╝╚══════╝      ╚═╝     ╚═╝ ╚═════╝ ╚═╝  ╚═══╝ ╚═════╝  ╚═════╝
 * (sails-mongo)
 *
 * Sails.js/Waterline adapter for the MongoDB database.
 *
 * > Most of the methods below are optional.
 * >
 * > If you don't need / can't get to every method, just implement
 * > what you have time for.  The other methods will only fail if
 * > you try to call them!
 * >
 * > For many adapters, this file is all you need.  For very complex adapters, you may need more flexiblity.
 * > In any case, it's probably a good idea to start with one file and refactor only if necessary.
 * > If you do go that route, it's conventional in Node to create a `./lib` directory for your private submodules
 * > and `require` them at the top of this file with other dependencies. e.g.:
 * > ```
 * > var updateMethod = require('./lib/update');
 * > ```
 *
 * @type {Dictionary}
 */


// Build & expose the adapter definition.
module.exports = {


  // The identity of this adapter, to be referenced by datastore configurations in a Sails app.
  identity: 'sails-mongo',


  // Waterline Adapter API Version
  //
  // > Note that this is not necessarily tied to the major version release cycle of Sails/Waterline!
  // > For example, Sails v1.5.0 might generate apps which use sails-hook-orm@2.3.0, which might
  // > include Waterline v0.13.4.  And all those things might rely on version 1 of the adapter API.
  // > But Waterline v0.13.5 might support version 2 of the adapter API!!  And while you can generally
  // > trust semantic versioning to predict/understand userland API changes, be aware that the maximum
  // > and/or minimum _adapter API version_ supported by Waterline could be incremented between major
  // > version releases.  When possible, compatibility for past versions of the adapter spec will be
  // > maintained; just bear in mind that this is a _separate_ number, different from the NPM package
  // > version.  sails-hook-orm verifies this adapter API version when loading adapters to ensure
  // > compatibility, so you should be able to rely on it to provide a good error message to the Sails
  // > applications which use this adapter.
  adapterApiVersion: 1,


  // Default datastore configuration.
  defaults: {
    schema: false,
  },


  //  ╔═╗═╗ ╦╔═╗╔═╗╔═╗╔═╗  ┌─┐┬─┐┬┬  ┬┌─┐┌┬┐┌─┐
  //  ║╣ ╔╩╦╝╠═╝║ ║╚═╗║╣   ├─┘├┬┘│└┐┌┘├─┤ │ ├┤
  //  ╚═╝╩ ╚═╩  ╚═╝╚═╝╚═╝  ┴  ┴└─┴ └┘ ┴ ┴ ┴ └─┘
  //  ┌┬┐┌─┐┌┬┐┌─┐┌─┐┌┬┐┌─┐┬─┐┌─┐┌─┐
  //   ││├─┤ │ ├─┤└─┐ │ │ │├┬┘├┤ └─┐
  //  ─┴┘┴ ┴ ┴ ┴ ┴└─┘ ┴ └─┘┴└─└─┘└─┘
  // This allows outside access to this adapter's internal registry of datastore entries,
  // for use in datastore methods like `.leaseConnection()`.
  datastores: registeredDsEntries,


  // Also give the driver a `mongodb` property, so that it provides access
  // to the static Mongo library for Node.js. (See http://npmjs.com/package/mongodb)
  mongodb: mongodb,



  //////////////////////////////////////////////////////////////////////////////////////////////////
  //  ██╗     ██╗███████╗███████╗ ██████╗██╗   ██╗ ██████╗██╗     ███████╗                        //
  //  ██║     ██║██╔════╝██╔════╝██╔════╝╚██╗ ██╔╝██╔════╝██║     ██╔════╝                        //
  //  ██║     ██║█████╗  █████╗  ██║      ╚████╔╝ ██║     ██║     █████╗                          //
  //  ██║     ██║██╔══╝  ██╔══╝  ██║       ╚██╔╝  ██║     ██║     ██╔══╝                          //
  //  ███████╗██║██║     ███████╗╚██████╗   ██║   ╚██████╗███████╗███████╗                        //
  //  ╚══════╝╚═╝╚═╝     ╚══════╝ ╚═════╝   ╚═╝    ╚═════╝╚══════╝╚══════╝                        //
  //                                                                                              //
  // Lifecycle adapter methods:                                                                   //
  // Methods related to setting up and tearing down; registering/un-registering datastores.       //
  //////////////////////////////////////////////////////////////////////////////////////////////////

  /**
   *  ╦═╗╔═╗╔═╗╦╔═╗╔╦╗╔═╗╦═╗  ┌┬┐┌─┐┌┬┐┌─┐┌─┐┌┬┐┌─┐┬─┐┌─┐
   *  ╠╦╝║╣ ║ ╦║╚═╗ ║ ║╣ ╠╦╝   ││├─┤ │ ├─┤└─┐ │ │ │├┬┘├┤
   *  ╩╚═╚═╝╚═╝╩╚═╝ ╩ ╚═╝╩╚═  ─┴┘┴ ┴ ┴ ┴ ┴└─┘ ┴ └─┘┴└─└─┘
   *   ˙     ˙     ˙     ˙     ˙     ˙     ˙     ˙     ˙     ˙     ˙     ˙     ˙     ˙
   * Register a new datastore with this adapter.  This usually involves creating a new
   * connection manager (e.g. MongoDB client `db`) for the underlying database layer.
   *
   * > Waterline calls this method once for every datastore that is configured to use this adapter.
   * - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - -
   * @param  {Dictionary}   dsConfig              »-> Dictionary (plain JavaScript object) of configuration options for this datastore (e.g. host, port, etc.)
   * - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - -
   * @param  {Dictionary}   physicalModelsReport  »–> Experimental: The physical models using this datastore (keyed by "tableName"-- NOT by `identity`!).  This may change in a future release of the adapter spec.
   *         ˚¯¯¯¯¯¯¯¯¯¯¯¯¯¯¯¯¯¯¯¯\
   *         ˙ **: {Dictionary}   :: Info about a physical model using this datastore.  WARNING: This is in a bit of an unusual format.
   *               ˚¯¯¯¯¯¯¯¯¯¯¯¯¯¯¯¯¯¯¯¯¯¯¯¯¯¯\
   *               ˙ primaryKey: {String}      :: The name of the primary key attribute (NOT the column name-- the attribute name!)]
   *               ˙ identity: {String}        :: The model's `identity`.
   *               ˙ tableName: {String}       :: The model's `tableName` (same as the key this is under, just here for convenience)]
   *               ˙ definition: {Dictionary}  :: The report from waterline-schema.  NOTE THAT THIS IS NOT CURRENTLY A NORMAL `attributes` dictionary, exactly.  But it is close enough for most things.  (Remember: It is keyed by attribute name -- NOT by column name.)
   *                             ˚¯¯¯¯¯¯¯¯¯¯¯¯¯¯¯¯¯¯¯\
   *                             ˙ **: {Dictionary}  :: Info about an attribute.
   *                                   ˚¯¯¯¯¯¯¯¯¯¯¯¯¯¯¯¯¯¯¯¯¯¯¯\
   *                                   ˙ columnName: {String}  ::
   *                                   ˙ required: {Boolean?}  ::
   *                                   ˙ etc...
   * - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - -
   * @param  {Function}  done    »-> A callback function which should be triggered by this implementation after successfully registering this datastore, or if an error is encountered.
   *         @param {Error?} err   <-« An Error instance, if something went wrong.  (Otherwise `undefined`.)
   * - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - -
   */
  registerDatastore: function (dsConfig, physicalModelsReport, done) {

    GLOBAL_STATE.numRegisterDatastoreCalls++;

    // Grab the unique name for this datastore for easy access below.
    var datastoreName = dsConfig && dsConfig.identity;
    // Some wrappers / legacy config styles may omit `identity` on the datastore config object.
    // When that happens, infer a reasonable fallback so the adapter can still track it.
    if (!datastoreName && dsConfig) {
      datastoreName = dsConfig.datastoreName || dsConfig.datastore || dsConfig.connectionName || dsConfig.connection || dsConfig.name;
    }
    // Last-resort fallback (commonly used in apps that only have one configured connection).
    if (!datastoreName) {
      datastoreName = 'default';
    }
    // Ensure identity is set for downstream usage.
    dsConfig.identity = datastoreName;

    // Ensure there's a waiter for this datastore name (so queries can wait for registration).
    var waiter = _getOrCreateDatastoreWaiter(datastoreName);

    // Some sanity checks:
    if (!datastoreName) {
      return done(new Error('Consistency violation: A datastore should contain an "identity" property: a special identifier that uniquely identifies it across this app.  This should have been provided by Waterline core!  If you are seeing this message, there could be a bug in Waterline, or the datastore could have become corrupted by userland code, or other code in this adapter.  If you determine that this is a Waterline bug, please report this at http://sailsjs.com/bugs.'));
    }
    // If it's already registered, treat it as idempotent iff the URL matches (or is missing).
    // This is important in real apps where the adapter may bootstrap itself early (before Waterline init),
    // and then Waterline later calls `registerDatastore()` again during normal initialization.
    if (registeredDsEntries[datastoreName]) {
      var existing = registeredDsEntries[datastoreName];
      // If an earlier attempt failed, surface the underlying error.
      // (This avoids confusing downstream "no matching datastore entry" errors caused by clearing state.)
      if (existing && existing.managerInitError) {
        return done(existing.managerInitError);
      }
      // If an earlier attempt is still in flight, wait for it to settle before reporting success/failure.
      if (existing && !existing.manager && existing.managerPromise && typeof existing.managerPromise.then === 'function') {
        return existing.managerPromise.then(function () { return done(); }).catch(function (err) { return done(err); });
      }
      if (existing && existing.config && existing.config.url && dsConfig && dsConfig.url && existing.config.url !== dsConfig.url) {
        return done(new Error(
          'Consistency violation: Cannot register datastore: `'+datastoreName+'`, because it is already registered with this adapter (with a different `url`).\n'+
          'Existing url: '+existing.config.url+'\n'+
          'New url: '+dsConfig.url
        ));
      }
      return done();
    }


    //  ╔╗╔╔═╗╦═╗╔╦╗╔═╗╦  ╦╔═╗╔═╗  ┌┬┐┌─┐┌┬┐┌─┐┌─┐┌┬┐┌─┐┬─┐┌─┐  ┌─┐┌─┐┌┐┌┌─┐┬┌─┐
    //  ║║║║ ║╠╦╝║║║╠═╣║  ║╔═╝║╣    ││├─┤ │ ├─┤└─┐ │ │ │├┬┘├┤   │  │ ││││├┤ ││ ┬
    //  ╝╚╝╚═╝╩╚═╩ ╩╩ ╩╩═╝╩╚═╝╚═╝  ─┴┘┴ ┴ ┴ ┴ ┴└─┘ ┴ └─┘┴└─└─┘  └─┘└─┘┘└┘└  ┴└─┘
    try {
      normalizeDatastoreConfig(dsConfig, CONFIG_WHITELIST, EXPECTED_URL_PROTOCOL_PFX);
    } catch (e) {
      switch (e.code) {
        case 'E_BAD_CONFIG': return done(flaverr(e.code, new Error('Invalid configuration for datastore `' + datastoreName + '`:  '+e.message)));
        default: return done(e);
      }
    }


    //  ╔═╗╔═╗╦═╗╔╦╗╦╔═╗╦ ╦  ┌─┐┌─┐┌─┐┬┌┐┌┌─┐┌┬┐  ┌┬┐┌┐    ┌─┐┌─┐┌─┐┌─┐┬┌─┐┬┌─┐
    //  ║  ║╣ ╠╦╝ ║ ║╠╣ ╚╦╝  ├─┤│ ┬├─┤││││└─┐ │    ││├┴┐───└─┐├─┘├┤ │  │├┤ ││
    //  ╚═╝╚═╝╩╚═ ╩ ╩╚   ╩   ┴ ┴└─┘┴ ┴┴┘└┘└─┘ ┴   ─┴┘└─┘   └─┘┴  └─┘└─┘┴└  ┴└─┘┘
    //  ┌─┐┌┐┌┌┬┐┌─┐┬  ┌─┐┌─┐┬┌─┐┌─┐┬    ┬─┐┌─┐┌─┐┌┬┐┬─┐┬┌─┐┌┬┐┬┌─┐┌┐┌┌─┐
    //  │ ││││ │ │ ││  │ ││ ┬││  ├─┤│    ├┬┘├┤ └─┐ │ ├┬┘││   │ ││ ││││└─┐
    //  └─┘┘└┘ ┴ └─┘┴─┘└─┘└─┘┴└─┘┴ ┴┴─┘  ┴└─└─┘└─┘ ┴ ┴└─┴└─┘ ┴ ┴└─┘┘└┘└─┘

    // Validate models vs. adapter-specific restrictions (if relevant):
    // ============================================================================================
    if (WET_MACHINES.verifyModelDef) {

      var modelIncompatibilitiesMap = {};
      try {
        _.each(physicalModelsReport, function (phModelInfo){
          try {
            WET_MACHINES.verifyModelDef({ modelDef: phModelInfo }).execSync();
          } catch (e) {
            switch (e.exit) {
              case 'invalid': modelIncompatibilitiesMap[phModelInfo.identity] = e; break;
              default: throw e;
            }
          }
        });//</_.each()>
      } catch (e) { return done(e); }

      var numNotCompatible = _.keys(modelIncompatibilitiesMap).length;
      if (numNotCompatible > 0) {
        return done(flaverr('E_MODELS_NOT_COMPATIBLE', new Error(
          numNotCompatible+' model(s) are not compatible with this adapter:\n'+
          _.reduce(modelIncompatibilitiesMap, function(memo, incompatibility, modelIdentity) {
            return memo + '• `'+modelIdentity+'`  :: '+incompatibility+'\n';
          }, '')
        )));
      }//-•

    }//>-•   </verify model definitions, if relevant>



    //  ╔═╗╦═╗╔═╗╔═╗╔╦╗╔═╗  ┌┬┐┌─┐┌┐┌┌─┐┌─┐┌─┐┬─┐
    //  ║  ╠╦╝║╣ ╠═╣ ║ ║╣   │││├─┤│││├─┤│ ┬├┤ ├┬┘
    //  ╚═╝╩╚═╚═╝╩ ╩ ╩ ╚═╝  ┴ ┴┴ ┴┘└┘┴ ┴└─┘└─┘┴└─
    // Build a "connection manager" -- an object that contains all of the state for this datastore.
    // This might be a MySQL connection pool, a Mongo client instance (`db`), or something even simpler.
    // For example, in sails-postgresql, `manager` encapsulates a connection pool that the stateless
    // `machinepack-postgresql` driver uses to communicate with the database.  The actual form of the
    // manager is completely dependent on this adapter.  In other words, it is custom and database-specific.
    // This is where you should store any custom metadata specific to this datastore.
    //
    // IMPORTANT: Following the legacy sails-mongo pattern, we do NOT register the datastore entry
    // until the manager is successfully created.  This avoids race conditions where queries could
    // arrive before the manager is ready.
    WET_MACHINES.createManager({
      connectionString: dsConfig.url,
      meta: _.omit(dsConfig, ['adapter', 'url', 'identity', 'schema'])
    }).switch({
      error: function(err) {
        return done(new Error('Consistency violation: Unexpected error creating db connection manager:\n```\n'+err.stack+'\n```'));
      },
      malformed: function(report) {
        return done(flaverr({
          code: 'E_BAD_CONFIG',
          raw: report.error,
          meta: report.meta
        }, new Error('The given connection URL is not valid for this database adapter.  Details:\n```\n'+report.error.stack+'\n```')));
      },
      failed: function(report) {
        return done(flaverr({
          code: 'E_FAILED_TO_CONNECT',
          raw: report.error,
          meta: report.meta
        }, new Error('Failed to connect with the given datastore configuration.  Details:\n```\n'+report.error.stack+'\n```')));
      },
      success: function (report) {

        try {
          var manager = report.manager;

          //  ╔╦╗╦═╗╔═╗╔═╗╦╔═  ┌┬┐┌─┐  ┌─┐┌┐┌┌┬┐┬─┐┬ ┬
          //   ║ ╠╦╝╠═╣║  ╠╩╗   ││└─┐  ├┤ │││ │ ├┬┘└┬┘
          //   ╩ ╩╚═╩ ╩╚═╝╩ ╩  ─┴┘└─┘  └─┘┘└┘ ┴ ┴└─ ┴
          //  ┌─  ┌┬┐┌─┐┌┬┐┌─┐┌─┐┌┬┐┌─┐┬─┐┌─┐  ┌─┐┌┐┌┌┬┐┬─┐┬ ┬  ─┐
          //  │    ││├─┤ │ ├─┤└─┐ │ │ │├┬┘├┤   ├┤ │││ │ ├┬┘└┬┘   │
          //  └─  ─┴┘┴ ┴ ┴ ┴ ┴└─┘ ┴ └─┘┴└─└─┘  └─┘┘└┘ ┴ ┴└─ ┴   ─┘
          // Save information about the datastore to the `datastores` dictionary, keyed under
          // the datastore's unique name.  The information should itself be in the form of a
          // dictionary (plain JavaScript object), and have three keys:
          //
          //  `manager`: The database-specific "connection manager" that we just built above.
          //
          //  `config : Configuration options for the datastore.  Should be passed straight through
          //            from what was provided as the `dsConfig` argument to this method.
          //
          //  `driver` : Optional. A reference to a stateless, underlying Node-Machine driver.
          //             (For instance `machinepack-postgresql` for the `sails-postgresql` adapter.)
          //             Note that this stateless, standardized driver will be merged into the main
          //             concept of an adapter in future versions of the Waterline adapter spec.
          //             (See https://github.com/node-machine/driver-interface for more informaiton.)
          //
          registeredDsEntries[datastoreName] = {
            config: dsConfig,
            manager: manager,
            driver: {
              createManager: WET_MACHINES.createManager,
              destroyManager: WET_MACHINES.destroyManager,
              getConnection: WET_MACHINES.getConnection,
              releaseConnection: WET_MACHINES.releaseConnection,
              mongodb: mongodb
            }
            // - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - -
            // ^Note: In future releases, the driver and the adapter will simply become one thing.
            // - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - -
          };

          // Resolve any pending waiters now that the datastore entry exists with a real manager.
          try { waiter.resolve(registeredDsEntries[datastoreName]); } catch (unusedErr) { /* ignore */ }

          //  ╔╦╗╦═╗╔═╗╔═╗╦╔═  ┌─┐┬ ┬    ┌┬┐┌─┐┌┬┐┌─┐┬  ┌─┐
          //   ║ ╠╦╝╠═╣║  ╠╩╗  ├─┘├─┤     ││││ │ ││├┤ │  └─┐
          //   ╩ ╩╚═╩ ╩╚═╝╩ ╩  ┴  ┴ ┴    ┴ ┴└─┘─┴┘└─┘┴─┘└─┘
          // Also track physical models.
          // - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - -
          // FUTURE: Remove the need for this step by giving the adapter some kind of simpler access
          // to the orm instance, or an accessor function for models.
          // - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - -
          _.each(physicalModelsReport, function(phModelInfo){

            // console.log('in datastore: `%s`  ……tracking physical model:  `%s` (tableName: `%s`)',datastoreName, phModelInfo.identity, phModelInfo.tableName);
            if (registeredDryModels[phModelInfo.identity]) {
              throw new Error('Consistency violation: Cannot register model: `' + phModelInfo.identity + '`, because it is already registered with this adapter!  This could be due to an unexpected race condition in userland code (e.g. attempting to initialize multiple ORM instances at the same time), or it could be due to a bug in this adapter.  (If you get stumped, reach out at http://sailsjs.com/support.)');
            }

            registeredDryModels[phModelInfo.identity] = {
              datastore: datastoreName,
              primaryKey: phModelInfo.primaryKey,
              attributes: phModelInfo.definition,
              tableName: phModelInfo.tableName,
              identity: phModelInfo.identity,
              dontUseObjectIds: phModelInfo.dontUseObjectIds || false,
            };

            // console.log('\n\nphModelInfo:',util.inspect(phModelInfo,{depth:5}));

          });//</each phModel>

        } catch (e) { return done(e); }

        // Inform Waterline that the datastore was registered successfully.
        return done(undefined, report.meta);

      }//•-success>
    });//createManager()>

  },


  /**
   *  ╔╦╗╔═╗╔═╗╦═╗╔╦╗╔═╗╦ ╦╔╗╔
   *   ║ ║╣ ╠═╣╠╦╝ ║║║ ║║║║║║║
   *   ╩ ╚═╝╩ ╩╩╚══╩╝╚═╝╚╩╝╝╚╝
   * Tear down (un-register) a datastore.
   *
   * Fired when a datastore is unregistered.  Typically called once for
   * each relevant datastore when the server is killed, or when Waterline
   * is shut down after a series of tests.  Useful for destroying the manager
   * (i.e. terminating any remaining open connections, etc.).
   * - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - -
   * @param  {String} datastoreName   The unique name (identity) of the datastore to un-register.
   * - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - -
   * @param  {Function} done          Callback
   *               @param {Error?}
   * - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - -
   */
  teardown: function (datastoreName, done) {

    // Helper: remove all registry keys (including aliases) that point at this datastore entry.
    var _cleanupRegistryForEntry = function (entry) {
      var dsNames = [];
      try {
        _.each(_.keys(registeredDsEntries), function (dsKey) {
          if (registeredDsEntries[dsKey] === entry) {
            dsNames.push(dsKey);
            delete registeredDsEntries[dsKey];
          }
        });
      } catch (unusedErr) { /* ignore */ }

      // Also remove any model definitions registered for this datastore.
      try {
        _.each(_.keys(registeredDryModels), function(modelIdentity) {
          var m = registeredDryModels[modelIdentity];
          if (!m) { return; }
          if (dsNames.indexOf(m.datastore) !== -1) {
            delete registeredDryModels[modelIdentity];
          }
        });
      } catch (unusedErr) { /* ignore */ }

      // Finally, clear any waiters so future init can create fresh ones, and so any in-flight waits fail fast.
      try {
        if (GLOBAL_STATE && GLOBAL_STATE.datastoreWaiters) {
          _.each(dsNames, function (dsKey) {
            var waiter = GLOBAL_STATE.datastoreWaiters[dsKey];
            if (waiter && waiter.reject) {
              try { waiter.reject(new Error('Datastore (`'+dsKey+'`) was torn down.')); } catch (unusedErr) { /* ignore */ }
            }
            delete GLOBAL_STATE.datastoreWaiters[dsKey];
          });
        }
      } catch (unusedErr) { /* ignore */ }
    };

    // Helper: tear down a specific datastore entry (waiting briefly for in-flight ops).
    var _teardownEntry = function (entry, cb) {
      // Wait (briefly) for in-flight ops to finish, to avoid closing the client mid-query.
      var msToWait = (function () {
        var raw = process.env.SAILS_MONGO_TEARDOWN_WAIT_FOR_OPS_MS;
        if (!raw) { return 5000; } // default 5s
        var n = Number(raw);
        // Allow 0 to mean "wait forever".
        if (n === 0) { return 0; }
        if (!isFinite(n) || n < 0) { return 5000; }
        return n;
      })();

      var waitForNoOps = function (next) {
        try {
          entry._sailsMongoActiveOps = entry._sailsMongoActiveOps || 0;
          entry._sailsMongoActiveOpsWaiters = entry._sailsMongoActiveOpsWaiters || [];
          if (entry._sailsMongoActiveOps === 0) { return next(); }
          var resolved = false;
          var timeout;
          if (msToWait !== 0) {
            timeout = setTimeout(function () {
              if (resolved) { return; }
              resolved = true;
              return next();
            }, msToWait);
          }
          entry._sailsMongoActiveOpsWaiters.push(function () {
            if (resolved) { return; }
            resolved = true;
            if (timeout) { clearTimeout(timeout); }
            return next();
          });
          return;
        } catch (unusedErr) { return next(); }
      };

      return waitForNoOps(function () {
        // If initialization failed (or never produced a manager), just clean up.
        if (!entry.manager) {
          _cleanupRegistryForEntry(entry);
          return cb();
        }

        return WET_MACHINES.destroyManager({ manager: entry.manager }).switch({
          error: function (err) { return cb(err); },
          failed: function (report) { return cb(report && report.error || new Error('Failed to destroy manager')); },
          success: function () {
            _cleanupRegistryForEntry(entry);
            return cb();
          }
        });
      });
    };

    // If called with no datastore name, interpret this as "teardown everything" (common in nxus-storage).
    if (!datastoreName) {
      // Grab unique entries (aliases may point at same object).
      var uniqueEntries = [];
      _.each(_.values(registeredDsEntries), function (entry) {
        if (!entry) { return; }
        if (uniqueEntries.indexOf(entry) === -1) { uniqueEntries.push(entry); }
      });

      return async.eachSeries(uniqueEntries, function (entry, next) {
        return _teardownEntry(entry, next);
      }, function (err) {
        // Always attempt to fully clean registry even if one entry fails.
        try {
          _.each(uniqueEntries, function (entry) { _cleanupRegistryForEntry(entry); });
        } catch (unusedErr) { /* ignore */ }
        return done(err);
      });
    }

    // Look up the datastore entry (manager/driver/config).
    var dsEntry = registeredDsEntries[datastoreName];

    // Sanity checks:
    if (_.isUndefined(dsEntry)) {
      return done(new Error('Consistency violation: Attempting to tear down a datastore (`'+datastoreName+'`) which is not currently registered with this adapter.  This is usually due to a race condition in userland code (e.g. attempting to tear down the same ORM instance more than once), or it could be due to a bug in this adapter.  (If you get stumped, reach out at http://sailsjs.com/support.)'));
    }
    return _teardownEntry(dsEntry, function (err) {
      if (err) { return done(err); }
      return done();
    });

  },


  /**
   *  ╔═╗╦═╗╔═╗╔═╗╔╦╗╔═╗  ╔╦╗╔═╗╔╗╔╔═╗╔═╗╔═╗╦═╗
   *  ║  ╠╦╝║╣ ╠═╣ ║ ║╣   ║║║╠═╣║║║╠═╣║ ╦║╣ ╠╦╝
   *  ╚═╝╩╚═╚═╝╩ ╩ ╩ ╚═╝  ╩ ╩╩ ╩╝╚╝╩ ╩╚═╝╚═╝╩╚═
   *
   * > https://github.com/node-machine/driver-interface/blob/master/layers/connectable/create-manager.js
   */
  createManager: DRY_MACHINES.createManager,

  /**
   *  ╔╦╗╔═╗╔═╗╔╦╗╦═╗╔═╗╦ ╦  ╔╦╗╔═╗╔╗╔╔═╗╔═╗╔═╗╦═╗
   *   ║║║╣ ╚═╗ ║ ╠╦╝║ ║╚╦╝  ║║║╠═╣║║║╠═╣║ ╦║╣ ╠╦╝
   *  ═╩╝╚═╝╚═╝ ╩ ╩╚═╚═╝ ╩   ╩ ╩╩ ╩╝╚╝╩ ╩╚═╝╚═╝╩╚═
   *
   * > https://github.com/node-machine/driver-interface/blob/master/layers/connectable/destroy-manager.js
   */
  destroyManager: DRY_MACHINES.destroyManager,

  /**
   *  ╔═╗╔═╗╔╦╗  ╔═╗╔═╗╔╗╔╔╗╔╔═╗╔═╗╔╦╗╦╔═╗╔╗╔
   *  ║ ╦║╣  ║   ║  ║ ║║║║║║║║╣ ║   ║ ║║ ║║║║
   *  ╚═╝╚═╝ ╩   ╚═╝╚═╝╝╚╝╝╚╝╚═╝╚═╝ ╩ ╩╚═╝╝╚╝
   *
   * > https://github.com/node-machine/driver-interface/blob/master/layers/connectable/get-connection.js
   */
  getConnection: DRY_MACHINES.getConnection,

  /**
   *  ╦═╗╔═╗╦  ╔═╗╔═╗╔═╗╔═╗  ╔═╗╔═╗╔╗╔╔╗╔╔═╗╔═╗╔╦╗╦╔═╗╔╗╔
   *  ╠╦╝║╣ ║  ║╣ ╠═╣╚═╗║╣   ║  ║ ║║║║║║║║╣ ║   ║ ║║ ║║║║
   *  ╩╚═╚═╝╩═╝╚═╝╩ ╩╚═╝╚═╝  ╚═╝╚═╝╝╚╝╝╚╝╚═╝╚═╝ ╩ ╩╚═╝╝╚╝
   *
   * > https://github.com/node-machine/driver-interface/blob/master/layers/connectable/release-connection.js
   */
  releaseConnection: DRY_MACHINES.releaseConnection,


  ///////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////
  //  ██╗   ██╗███████╗██████╗ ██╗███████╗██╗   ██╗    ███╗   ███╗ ██████╗ ██████╗ ███████╗██╗         ██████╗ ███████╗███████╗    //
  //  ██║   ██║██╔════╝██╔══██╗██║██╔════╝╚██╗ ██╔╝    ████╗ ████║██╔═══██╗██╔══██╗██╔════╝██║         ██╔══██╗██╔════╝██╔════╝    //
  //  ██║   ██║█████╗  ██████╔╝██║█████╗   ╚████╔╝     ██╔████╔██║██║   ██║██║  ██║█████╗  ██║         ██║  ██║█████╗  █████╗      //
  //  ╚██╗ ██╔╝██╔══╝  ██╔══██╗██║██╔══╝    ╚██╔╝      ██║╚██╔╝██║██║   ██║██║  ██║██╔══╝  ██║         ██║  ██║██╔══╝  ██╔══╝      //
  //   ╚████╔╝ ███████╗██║  ██║██║██║        ██║       ██║ ╚═╝ ██║╚██████╔╝██████╔╝███████╗███████╗    ██████╔╝███████╗██║         //
  //    ╚═══╝  ╚══════╝╚═╝  ╚═╝╚═╝╚═╝        ╚═╝       ╚═╝     ╚═╝ ╚═════╝ ╚═════╝ ╚══════╝╚══════╝    ╚═════╝ ╚══════╝╚═╝         //
  ///////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////
  verifyModelDef: DRY_MACHINES.verifyModelDef,


  //////////////////////////////////////////////////////////////////////////////////////////////////
  //  ██████╗ ███╗   ███╗██╗                                                                      //
  //  ██╔══██╗████╗ ████║██║                                                                      //
  //  ██║  ██║██╔████╔██║██║                                                                      //
  //  ██║  ██║██║╚██╔╝██║██║                                                                      //
  //  ██████╔╝██║ ╚═╝ ██║███████╗                                                                 //
  //  ╚═════╝ ╚═╝     ╚═╝╚══════╝                                                                 //
  // (D)ata (M)anipulation (L)anguage                                                             //
  //                                                                                              //
  // DML adapter methods:                                                                         //
  // Methods related to manipulating records stored in the database.                              //
  //////////////////////////////////////////////////////////////////////////////////////////////////


  /**
   *  ╔═╗╦═╗╔═╗╔═╗╔╦╗╔═╗
   *  ║  ╠╦╝║╣ ╠═╣ ║ ║╣
   *  ╚═╝╩╚═╚═╝╩ ╩ ╩ ╚═╝
   * Create a new record.
   *
   * (e.g. add a new row to a SQL table, or a new document to a MongoDB collection.)
   *
   * > Note that depending on the value of `s3q.meta.fetch`,
   * > you may be expected to return the physical record that was
   * > created (a dictionary) as the second argument to the callback.
   * > (Otherwise, exclude the 2nd argument or send back `undefined`.)
   * - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - -
   * @param  {String}       datastoreName   The name of the datastore to perform the query on.
   * - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - -
   * @param  {Dictionary}   s3q             The stage-3 query to perform.
   * - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - -
   * @param  {Function}     done            Callback
   *               @param {Error?}
   *               @param {Dictionary?}
   * - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - -
   */
  create: buildStdAdapterMethod(require('./private/machines/create-record'), WET_MACHINES, registeredDsEntries, registeredDryModels),


  /**
   *  ╔═╗╦═╗╔═╗╔═╗╔╦╗╔═╗  ╔═╗╔═╗╔═╗╦ ╦
   *  ║  ╠╦╝║╣ ╠═╣ ║ ║╣   ║╣ ╠═╣║  ╠═╣
   *  ╚═╝╩╚═╚═╝╩ ╩ ╩ ╚═╝  ╚═╝╩ ╩╚═╝╩ ╩
   * Create multiple new records.
   *
   * > Note that depending on the value of `query.meta.fetch`,
   * > you may be expected to return the array of physical records
   * > that were created as the second argument to the callback.
   * > (Otherwise, exclude the 2nd argument or send back `undefined`.)
   * - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - -
   * @param  {String}       datastoreName   The name of the datastore to perform the query on.
   * - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - -
   * @param  {Dictionary}   query           The stage-3 query to perform.
   * - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - -
   * @param  {Function}     done            Callback
   *               @param {Error?}
   *               @param {Array?}
   * - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - -
   */
  createEach: buildStdAdapterMethod(require('./private/machines/create-each-record'), WET_MACHINES, registeredDsEntries, registeredDryModels),



  /**
   *  ╦ ╦╔═╗╔╦╗╔═╗╔╦╗╔═╗
   *  ║ ║╠═╝ ║║╠═╣ ║ ║╣
   *  ╚═╝╩  ═╩╝╩ ╩ ╩ ╚═╝
   * Update matching records.
   *
   * > Note that depending on the value of `query.meta.fetch`,
   * > you may be expected to return the array of physical records
   * > that were updated as the second argument to the callback.
   * > (Otherwise, exclude the 2nd argument or send back `undefined`.)
   * - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - -
   * @param  {String}       datastoreName   The name of the datastore to perform the query on.
   * - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - -
   * @param  {Dictionary}   query           The stage-3 query to perform.
   * - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - -
   * @param  {Function}     done            Callback
   *               @param {Error?}
   *               @param {Array?}
   * - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - -
   */
  update: buildStdAdapterMethod(require('./private/machines/update-records'), WET_MACHINES, registeredDsEntries, registeredDryModels),


  /**
   *  ╔╦╗╔═╗╔═╗╔╦╗╦═╗╔═╗╦ ╦
   *   ║║║╣ ╚═╗ ║ ╠╦╝║ ║╚╦╝
   *  ═╩╝╚═╝╚═╝ ╩ ╩╚═╚═╝ ╩
   * Destroy one or more records.
   *
   * > Note that depending on the value of `query.meta.fetch`,
   * > you may be expected to return the array of physical records
   * > that were destroyed as the second argument to the callback.
   * > (Otherwise, exclude the 2nd argument or send back `undefined`.)
   * - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - -
   * @param  {String}       datastoreName   The name of the datastore to perform the query on.
   * - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - -
   * @param  {Dictionary}   query           The stage-3 query to perform.
   * - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - -
   * @param  {Function}     done            Callback
   *               @param {Error?}
   *               @param {Array?}
   * - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - -
   */
  destroy: buildStdAdapterMethod(require('./private/machines/destroy-records'), WET_MACHINES, registeredDsEntries, registeredDryModels),



  //////////////////////////////////////////////////////////////////////////////////////////////////
  //  ██████╗  ██████╗ ██╗                                                                        //
  //  ██╔══██╗██╔═══██╗██║                                                                        //
  //  ██║  ██║██║   ██║██║                                                                        //
  //  ██║  ██║██║▄▄ ██║██║                                                                        //
  //  ██████╔╝╚██████╔╝███████╗                                                                   //
  //  ╚═════╝  ╚══▀▀═╝ ╚══════╝                                                                   //
  // (D)ata (Q)uery (L)anguage                                                                    //
  //                                                                                              //
  // DQL adapter methods:                                                                         //
  // Methods related to fetching information from the database (e.g. finding stored records).     //
  //////////////////////////////////////////////////////////////////////////////////////////////////


  /**
   *  ╔═╗╦╔╗╔╔╦╗
   *  ╠╣ ║║║║ ║║
   *  ╚  ╩╝╚╝═╩╝
   * Find matching records.
   * - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - -
   * @param  {String}       datastoreName   The name of the datastore to perform the query on.
   * - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - -
   * @param  {Dictionary}   query           The stage-3 query to perform.
   * - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - -
   * @param  {Function}     done            Callback
   *               @param {Error?}
   *               @param {Array}  [matching physical records]
   * - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - -
   */
  find: buildStdAdapterMethod(require('./private/machines/find-records'), WET_MACHINES, registeredDsEntries, registeredDryModels),


  /**
   *   ╦╔═╗╦╔╗╔
   *   ║║ ║║║║║
   *  ╚╝╚═╝╩╝╚╝
   *  ┌─    ┌─┐┌─┐┬─┐  ┌┐┌┌─┐┌┬┐┬┬  ┬┌─┐  ┌─┐┌─┐┌─┐┬ ┬┬  ┌─┐┌┬┐┌─┐    ─┐
   *  │───  ├┤ │ │├┬┘  │││├─┤ │ │└┐┌┘├┤   ├─┘│ │├─┘│ ││  ├─┤ │ ├┤   ───│
   *  └─    └  └─┘┴└─  ┘└┘┴ ┴ ┴ ┴ └┘ └─┘  ┴  └─┘┴  └─┘┴─┘┴ ┴ ┴ └─┘    ─┘
   * Perform a "find" query with one or more native joins.
   *
   * > NOTE: If you don't want to support native joins (or if your database does not
   * > support native joins, e.g. Mongo) remove this method completely!  Without this method,
   * > Waterline will handle `.populate()` using its built-in join polyfill (aka "polypopulate"),
   * > which sends multiple queries to the adapter and joins the results in-memory.
   * - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - -
   * @param  {String}       datastoreName   The name of the datastore to perform the query on.
   * - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - -
   * @param  {Dictionary}   query           The stage-3 query to perform.
   * - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - -
   * @param  {Function}     done            Callback
   *               @param {Error?}
   *               @param {Array}  [matching physical records, populated according to the join instructions]
   * - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - -
   */
  // -----------------------------------------------------
  // N/A
  // (sails-mongo does not implement an optimized `join`
  // method for use with .populate() -- thus the built-in
  // populate polyfill, "polypopulate", will be used
  // instead.)
  // -----------------------------------------------------


  /**
   *  ╔═╗╔═╗╦ ╦╔╗╔╔╦╗
   *  ║  ║ ║║ ║║║║ ║
   *  ╚═╝╚═╝╚═╝╝╚╝ ╩
   * Get the number of matching records.
   * - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - -
   * @param  {String}       datastoreName   The name of the datastore to perform the query on.
   * - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - -
   * @param  {Dictionary}   query           The stage-3 query to perform.
   * - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - -
   * @param  {Function}     done            Callback
   *               @param {Error?}
   *               @param {Number}  [the number of matching records]
   * - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - -
   */
  count: buildStdAdapterMethod(require('./private/machines/count-records'), WET_MACHINES, registeredDsEntries, registeredDryModels),


  /**
   *  ╔═╗╦ ╦╔╦╗
   *  ╚═╗║ ║║║║
   *  ╚═╝╚═╝╩ ╩
   * - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - -
   * @param  {String}       datastoreName   The name of the datastore to perform the query on.
   * - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - -
   * @param  {Dictionary}   query           The stage-3 query to perform.
   * - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - -
   * @param  {Function}     done            Callback
   *               @param {Error?}
   *               @param {Number}  [the sum]
   * - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - -
   */
  sum: buildStdAdapterMethod(require('./private/machines/sum-records'), WET_MACHINES, registeredDsEntries, registeredDryModels),


  /**
   *  ╔═╗╦  ╦╔═╗
   *  ╠═╣╚╗╔╝║ ╦
   *  ╩ ╩ ╚╝ ╚═╝
   * - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - -
   * @param  {String}       datastoreName   The name of the datastore to perform the query on.
   * - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - -
   * @param  {Dictionary}   query           The stage-3 query to perform.
   * - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - -
   * @param  {Function}     done            Callback
   *               @param {Error?}
   *               @param {Number}  [the average ("mean")]
   * - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - -
   */
  avg: buildStdAdapterMethod(require('./private/machines/avg-records'), WET_MACHINES, registeredDsEntries, registeredDryModels),



  //////////////////////////////////////////////////////////////////////////////////////////////////
  //  ██████╗ ██████╗ ██╗                                                                         //
  //  ██╔══██╗██╔══██╗██║                                                                         //
  //  ██║  ██║██║  ██║██║                                                                         //
  //  ██║  ██║██║  ██║██║                                                                         //
  //  ██████╔╝██████╔╝███████╗                                                                    //
  //  ╚═════╝ ╚═════╝ ╚══════╝                                                                    //
  // (D)ata (D)efinition (L)anguage                                                               //
  //                                                                                              //
  // DDL adapter methods:                                                                         //
  // Methods related to modifying the underlying structure of physical models in the database.    //
  //////////////////////////////////////////////////////////////////////////////////////////////////


  /**
   *  ╔╦╗╔═╗╔═╗╦╔╗╔╔═╗
   *   ║║║╣ ╠╣ ║║║║║╣
   *  ═╩╝╚═╝╚  ╩╝╚╝╚═╝
   * Build a new physical model (e.g. table/etc) to use for storing records in the database.
   *
   * (This is used for schema migrations.)
   * - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - -
   * @param  {String}       datastoreName   The name of the datastore containing the table to define.
   * - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - -
   * @param  {String}       tableName       The name of the table to define.
   * - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - -
   * @param  {Dictionary}   phmDef          The physical model definition (not a normal Sails/Waterline model-- log this for details.)
   * - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - -
   * @param  {Function}     done            Callback
   *               @param {Error?}
   * - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - -
   */
  define: function (datastoreName, tableName, phmDef, done) {

    // Look up the datastore entry (manager/driver/config).
    var dsEntry = registeredDsEntries[datastoreName];

    // Sanity check:
    if (_.isUndefined(dsEntry)) {
      return done(new Error('Consistency violation: Cannot do that with datastore (`'+datastoreName+'`) because no matching datastore entry is registered in this adapter!  This is usually due to a race condition (e.g. a lifecycle callback still running after the ORM has been torn down), or it could be due to a bug in this adapter.  (If you get stumped, reach out at http://sailsjs.com/support.)'));
    }


    // - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - -
    // NOTE:
    // In Mongo, we don't really have to do anything special to define the actual,
    // concrete physical model, per se.  But we do have to set up special indexes
    // to ensure uniqueness.
    // - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - -

    // Build an array of any UNIQUE indexes needed
    // > Go through each item in the definition to locate fields
    // > which demand a uniqueness constraint.
    var uniqueIndexesToCreate = [];
    _.each(phmDef, function (phmAttrDef, key) {
      if (_.has(phmAttrDef, 'unique') && phmAttrDef.unique) {
        uniqueIndexesToCreate.push(key);
      }
    });

    // "Clean" the list of unique indexes.
    // > Remove `_id`.
    _.remove(uniqueIndexesToCreate, function (val) {
      return val === '_id';
    });

    // If there are no indexes to create, bail out (we're done).
    if (uniqueIndexesToCreate.length === 0) {
      return done();
    }//-•
    // Otherwise we'll need to create some indexes....

    // eslint-disable-next-line no-console
    console.log('[sails-mongo] Need to create', uniqueIndexesToCreate.length, 'unique index(es) on', tableName + ':', uniqueIndexesToCreate.join(', '));

    // First, get a reference to the Mongo collection.
    var db = dsEntry.manager;
    var mongoCollection = db.collection(tableName);

    // Then simultaneously create all of the indexes:
    async.each(uniqueIndexesToCreate, function (key, next) {

      // Build up a special "keys" dictionary for Mongo.
      // (e.g. `{foo:1}`)
      //
      // > This is the definition for a "single-field index".
      // > (https://docs.mongodb.com/manual/indexes/#index-types)
      var mongoSingleFieldIdxKeys = {};
      mongoSingleFieldIdxKeys[key] = 1;
      // - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - -
      // ^^^NOTE:
      //
      // There's a one-liner for this (https://lodash.com/docs/3.10.1#zipObject).
      // Avoiding it for clarity, but just making note of the reason why.
      // Here's what it would look like, for reference:
      // ```
      // var mongoSingleFieldIdxKeys = _.zipObject([[key, 1]]);
      // ```
      // - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - -


      // Create the index on the Mongo collection.
      // (https://docs.mongodb.com/manual/reference/method/db.collection.createIndex)
      // Note: In MongoDB 4.2+, indexes are built in an optimized way that allows concurrent reads/writes.
      // In older versions, we used `background: true` but this is now deprecated.
      // eslint-disable-next-line no-console
      console.log('[sails-mongo] Creating unique index on', tableName + '.' + key);
      Promise.resolve()
      .then(function (){
        return mongoCollection.createIndex(mongoSingleFieldIdxKeys, { unique: true });
      })
      .then(function (){
        // eslint-disable-next-line no-console
        console.log('[sails-mongo] Index created on', tableName + '.' + key);
        return next();
      })
      .catch(function (err){
        // eslint-disable-next-line no-console
        console.error('[sails-mongo] Error creating index on', tableName + '.' + key, ':', err && err.message);
        if (err && !isErrorLike(err)) {
          err = flaverr({raw: err}, new Error('Consistency violation: Expecting Error instance, but instead got: '+util.inspect(err)));
          return next(err);
        }
        return next(err);
      });

    }, function (err) {
      if (err) {
        // eslint-disable-next-line no-console
        console.error('[sails-mongo] Error creating indexes on', tableName + ':', err && err.message);
        return done(err);
      }
      // eslint-disable-next-line no-console
      console.log('[sails-mongo] All indexes created successfully on', tableName);
      return done();
    });//</ async.each >

  },


  /**
   *  ╔╦╗╦═╗╔═╗╔═╗
   *   ║║╠╦╝║ ║╠═╝
   *  ═╩╝╩╚═╚═╝╩
   * Drop a physical model (table/etc.) from the database, including all of its records.
   *
   * > This is idempotent.
   *
   * (This is used for schema migrations.)
   * - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - -
   * @param  {String}       datastoreName   The name of the datastore containing the table to drop.
   * - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - -
   * @param  {String}       tableName       The name of the table to drop.
   * - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - -
   * @param  {Ref}          unused          Currently unused (do not use this argument.)
   * - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - -
   * @param  {Function}     done            Callback
   *               @param {Error?}
   * - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - -
   */
  drop: function (datastoreName, tableName, unused, done) {

    // Look up the datastore entry (manager/driver/config).
    var dsEntry = registeredDsEntries[datastoreName];

    // Sanity check:
    if (_.isUndefined(dsEntry)) {
      return done(new Error('Consistency violation: Cannot do that with datastore (`'+datastoreName+'`) because no matching datastore entry is registered in this adapter!  This is usually due to a race condition (e.g. a lifecycle callback still running after the ORM has been torn down), or it could be due to a bug in this adapter.  (If you get stumped, reach out at http://sailsjs.com/support.)'));
    }

    // Drop the physical model (e.g. table/etc.)
    var db = dsEntry.manager;
    (async ()=>{
      try {
        await db.collection(tableName).drop();
      } catch (err) {
        // Namespace not found => idempotent success
        if (err && (err.code === 26 || err.codeName === 'NamespaceNotFound' || err.errmsg === 'ns not found' || (err.message && err.message.match(/ns not found|namespace.*not.*found/i)))) {
          return;
        }
        throw err;
      }
    })()
    .then(function (){
      // IWMIH, then either the physical model was successfully dropped,
      // or it didn't exist in the first place.
      return done();
    })
    .catch(function (err){
      if (!isErrorLike(err)) {
        err = new Error('Consistency violation: Expecting Error instance, but instead got: '+util.inspect(err));
      }
      err.raw = err.raw || err;
      return done(err);
    });

  },


  /**
   *  ╔═╗╔═╗╔╦╗  ┌─┐┌─┐┌─┐ ┬ ┬┌─┐┌┐┌┌─┐┌─┐
   *  ╚═╗║╣  ║   └─┐├┤ │─┼┐│ │├┤ ││││  ├┤
   *  ╚═╝╚═╝ ╩   └─┘└─┘└─┘└└─┘└─┘┘└┘└─┘└─┘
   * Set a sequence in a physical model (specifically, the auto-incrementing
   * counter for the primary key) to the specified value.
   *
   * (This is used for schema migrations.)
   *
   * > NOTE - If your adapter doesn't support sequence entities (like PostgreSQL),
   * > you should remove this method.
   * - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - -
   * @param  {String}       datastoreName    The name of the datastore containing the table/etc.
   * - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - -
   * @param  {String}       sequenceName     The name of the sequence to update.
   * - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - -
   * @param  {Number}       sequenceValue    The new value for the sequence (e.g. 1)
   * - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - -
   * @param  {Function}     done             Callback
   *               @param {Error?}
   * - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - -
   */

  // -----------------------------------------------------
  // N/A
  // (sails-mongo does not currently implement setSequence.)
  // -----------------------------------------------------


  // - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - -
  // Replace the shim implementations above with the following three things instead:
  // - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - -

  /**
   *  ╔╦╗╔═╗╔═╗╦╔╗╔╔═╗  ╔═╗╦ ╦╦ ╦╔═╗╦╔═╗╔═╗╦    ╔╦╗╔═╗╔╦╗╔═╗╦
   *   ║║║╣ ╠╣ ║║║║║╣   ╠═╝╠═╣╚╦╝╚═╗║║  ╠═╣║    ║║║║ ║ ║║║╣ ║
   *  ═╩╝╚═╝╚  ╩╝╚╝╚═╝  ╩  ╩ ╩ ╩ ╚═╝╩╚═╝╩ ╩╩═╝  ╩ ╩╚═╝═╩╝╚═╝╩═╝
   *
   * > https://github.com/node-machine/driver-interface/blob/master/layers/migratable/define-physical-model.js
   */
  definePhysicalModel: DRY_MACHINES.definePhysicalModel,

  /**
   *  ╔╦╗╦═╗╔═╗╔═╗  ╔═╗╦ ╦╦ ╦╔═╗╦╔═╗╔═╗╦    ╔╦╗╔═╗╔╦╗╔═╗╦
   *   ║║╠╦╝║ ║╠═╝  ╠═╝╠═╣╚╦╝╚═╗║║  ╠═╣║    ║║║║ ║ ║║║╣ ║
   *  ═╩╝╩╚═╚═╝╩    ╩  ╩ ╩ ╩ ╚═╝╩╚═╝╩ ╩╩═╝  ╩ ╩╚═╝═╩╝╚═╝╩═╝
   *
   * > https://github.com/node-machine/driver-interface/blob/master/layers/migratable/drop-physical-model.js
   */
  dropPhysicalModel: DRY_MACHINES.dropPhysicalModel,

  /**
   *  ╔═╗╔═╗╔╦╗  ╔═╗╦ ╦╦ ╦╔═╗╦╔═╗╔═╗╦    ╔═╗╔═╗╔═╗ ╦ ╦╔═╗╔╗╔╔═╗╔═╗
   *  ╚═╗║╣  ║   ╠═╝╠═╣╚╦╝╚═╗║║  ╠═╣║    ╚═╗║╣ ║═╬╗║ ║║╣ ║║║║  ║╣
   *  ╚═╝╚═╝ ╩   ╩  ╩ ╩ ╩ ╚═╝╩╚═╝╩ ╩╩═╝  ╚═╝╚═╝╚═╝╚╚═╝╚═╝╝╚╝╚═╝╚═╝
   *
   * > https://github.com/node-machine/driver-interface/blob/master/layers/migratable/set-physical-sequence.js
   */
  setPhysicalSequence: DRY_MACHINES.setPhysicalSequence,


  //////////////////////////////////////////////////////////////////////////////////////////////////
  //  ███╗   ██╗ █████╗ ████████╗██╗██╗   ██╗███████╗                                              //
  //  ████╗  ██║██╔══██╗╚══██╔══╝██║██║   ██║██╔════╝                                              //
  //  ██╔██╗ ██║███████║   ██║   ██║██║   ██║█████╗                                                //
  //  ██║╚██╗██║██╔══██║   ██║   ██║╚██╗ ██╔╝██╔══╝                                                //
  //  ██║ ╚████║██║  ██║   ██║   ██║ ╚████╔╝ ███████╗                                              //
  //  ╚═╝  ╚═══╝╚═╝  ╚═╝   ╚═╝   ╚═╝  ╚═══╝  ╚══════╝                                              //
  // Provide access to the underlying native MongoDB collection                                    //
  //////////////////////////////////////////////////////////////////////////////////////////////////

  /**
   *  ╔╗╔╔═╗╔╦╗╦╦  ╦╔═╗
   *  ║║║╠═╣ ║ ║╚╗╔╝║╣
   *  ╝╚╝╩ ╩ ╩ ╩ ╚╝ ╚═╝
   *
   * Provide access to the underlying native MongoDB collection for raw queries.
   * This is a legacy method maintained for backwards compatibility with Waterline 0.12
   * and frameworks like nxus that rely on it.
   *
   * Usage:
   * ```
   * Model.native(function(err, collection) {
   *   collection.find({}).toArray(function(err, results) { ... });
   * });
   * ```
   *
   * @param  {String}   datastoreName   The name of the datastore (connection name)
   * @param  {String}   tableName       The table/collection name
   * @param  {Function} cb              Callback: function(err, nativeMongoCollection)
   */
  native: function (unusedDatastoreName, unusedTableName, unusedCb) {
    // Handle various calling conventions:
    // 1. (datastoreName, tableName, cb) - standard
    // 2. (tableName, cb) - when called via model wrapper that already knows datastore
    // 3. (cb) - when called via model wrapper that knows both
    var args = Array.prototype.slice.call(arguments);
    var done;
    var dsName;
    var tblName;

    // Find callback (last function arg)
    for (var i = args.length - 1; i >= 0; i--) {
      if (typeof args[i] === 'function') {
        done = args[i];
        break;
      }
    }
    if (!done) {
      throw new Error('Callback is required for native()');
    }

    // Find datastore name (first string that matches a registered datastore)
    for (var j = 0; j < args.length; j++) {
      if (typeof args[j] === 'string' && registeredDsEntries[args[j]]) {
        dsName = args[j];
        break;
      }
    }

    // Collect all string arguments for later use
    var stringArgs = [];
    for (var k = 0; k < args.length; k++) {
      if (typeof args[k] === 'string') {
        stringArgs.push(args[k]);
      }
    }

    // If no registered datastore matched, use the default/first registered datastore
    // (In Waterline 0.12, models may use a connection name like 'jobs' but the actual
    // datastore might be registered as 'default')
    if (!dsName) {
      var dsKeys = Object.keys(registeredDsEntries);
      if (dsKeys.length === 1) {
        dsName = dsKeys[0];
      } else if (dsKeys.length > 1) {
        // Try common default names
        if (registeredDsEntries.default) { dsName = 'default'; }
        else if (registeredDsEntries.localDiskDb) { dsName = 'localDiskDb'; }
        else { dsName = dsKeys[0]; }
      }
    }

    // Find table name - use the last string argument that isn't the dsName
    // (Waterline 0.12 passes: connectionName, tableName, callback)
    // So tableName is typically the second string argument
    for (var l = stringArgs.length - 1; l >= 0; l--) {
      if (stringArgs[l] !== dsName && !registeredDsEntries[stringArgs[l]]) {
        tblName = stringArgs[l];
        break;
      }
    }

    if (!dsName) {
      return done(new Error('Could not determine datastore for native(). Please specify a datastore name.'));
    }

    var dsEntry = registeredDsEntries[dsName];
    if (!dsEntry) {
      return done(new Error('Unknown datastore: ' + dsName));
    }

    if (!dsEntry.manager) {
      return done(new Error('Datastore manager not available. The datastore may not be fully initialized.'));
    }

    // Get the native MongoDB Db object from the manager
    var db = dsEntry.manager;

    if (!db) {
      return done(new Error('Database manager is null or undefined.'));
    }

    if (!tblName) {
      // Return the db itself if no table name specified
      return done(null, db);
    }

    // Return the native MongoDB collection
    if (typeof db.collection !== 'function') {
      return done(new Error('Database manager does not have a collection() method. Got: ' + typeof db.collection));
    }

    var collection = db.collection(tblName);
    if (!collection) {
      return done(new Error('Could not get collection: ' + tblName));
    }

    // Compatibility shim: ensureIndex was deprecated in MongoDB 3.x and removed in 5.x
    // Map it to createIndex for backwards compatibility with legacy code.
    if (!collection.ensureIndex && collection.createIndex) {
      collection.ensureIndex = function(keys, options, callback) {
        return collection.createIndex(keys, options, callback);
      };
    }

    // Compatibility shim: MongoDB driver v4+/v6 renamed `fields` option to `projection`.
    // Wrap collection.find() and collection.findOne() to convert the old API.
    var originalFind = collection.find.bind(collection);
    collection.find = function(query, options) {
      if (options && options.fields && !options.projection) {
        options = _.extend({}, options, { projection: options.fields });
        delete options.fields;
      }
      return originalFind(query, options);
    };

    var originalFindOne = collection.findOne.bind(collection);
    collection.findOne = function(query, options) {
      if (options && options.fields && !options.projection) {
        options = _.extend({}, options, { projection: options.fields });
        delete options.fields;
      }
      return originalFindOne(query, options);
    };

    return done(null, collection);
  },


};


// =====================================================================================
// LEGACY WATERLINE 0.10.x/0.12.x COMPATIBILITY
// =====================================================================================
// Older Waterline versions (used by nxus-storage, connect-waterline, etc.) call
// `registerConnection` instead of `registerDatastore`.
//
// Modern Waterline (0.13+) throws an error if `registerConnection` exists on the adapter.
//
// By default, we expose `registerConnection` for backward compatibility with older
// frameworks and libraries. If you're using ONLY modern Waterline (Sails 1.x) and
// encounter the "registerConnection must be renamed" error, set:
//   SAILS_MONGO_NO_LEGACY_WATERLINE=1
// - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - -
if (process.env.SAILS_MONGO_NO_LEGACY_WATERLINE !== '1' && process.env.SAILS_MONGO_NO_LEGACY_WATERLINE !== 'true') {
  module.exports.registerConnection = function registerConnection(connectionConfig, physicalModelsReport, done) {
    // Normalize older Waterline config to modern registerDatastore format.
    var dsConfig = _.extend({}, connectionConfig);

    if (!dsConfig.identity && dsConfig.name) {
      dsConfig.identity = dsConfig.name;
    }

    // eslint-disable-next-line no-console
    console.log('[sails-mongo] registerConnection (legacy) called for:', dsConfig.identity || '(unknown)');

    // Old Waterline (0.10.x/0.12.x) passes physicalModelsReport in a different format.
    // It's keyed by model identity and contains the schema definition directly,
    // rather than the modern format which is keyed by tableName and contains phModelInfo objects.
    //
    // Modern format:
    //   { tableName: { identity, tableName, primaryKey, definition: {...} } }
    //
    // Old format (0.10.x):
    //   { identity: { definition: {...}, tableName: '...', ... } }
    //
    // We need to normalize this.
    var normalizedModelsReport = {};
    if (physicalModelsReport && typeof physicalModelsReport === 'object') {
      _.each(physicalModelsReport, function (modelDef, key) {
        // Determine tableName and identity
        var tableName = modelDef.tableName || modelDef.table || key;
        var identity = modelDef.identity || key;
        var primaryKey = modelDef.primaryKey;
        var definition = modelDef.definition || modelDef.attributes || modelDef;

        // Check if autoPK is disabled (model uses a custom primary key, not ObjectId)
        var autoPK = modelDef.autoPK;
        var dontUseObjectIds = (autoPK === false);

        // If no primaryKey specified, try to find it from the definition
        if (!primaryKey && definition) {
          _.each(definition, function (attrDef, attrName) {
            if (attrDef && attrDef.primaryKey) {
              primaryKey = attrName;
              // If the PK attribute has type 'string', don't use ObjectIds
              if (attrDef.type === 'string') {
                dontUseObjectIds = true;
              }
            }
          });
        }
        // Default to 'id' if still not found
        if (!primaryKey) {
          primaryKey = 'id';
        }

        // Ensure each attribute has a columnName (old Waterline might not include this)
        var normalizedDefinition = {};
        _.each(definition, function (attrDef, attrName) {
          if (attrDef && typeof attrDef === 'object') {
            normalizedDefinition[attrName] = _.extend({}, attrDef, {
              columnName: attrDef.columnName || attrName
            });
          } else {
            // Simple type definition like { name: 'string' }
            normalizedDefinition[attrName] = {
              type: attrDef,
              columnName: attrName
            };
          }
        });

        normalizedModelsReport[tableName] = {
          identity: identity,
          tableName: tableName,
          primaryKey: primaryKey,
          definition: normalizedDefinition,
          dontUseObjectIds: dontUseObjectIds
        };

        // eslint-disable-next-line no-console
        console.log('[sails-mongo] registerConnection: normalized model', identity, '-> tableName:', tableName, dontUseObjectIds ? '(string PK, no ObjectIds)' : '');
      });
    }

    return module.exports.registerDatastore(dsConfig, normalizedModelsReport, done);
  };
}


// Support ESM / transpiler interop where consumers may do `require('sails-mongo').default`
// or `import sailsMongo from 'sails-mongo'` (depending on tooling).
// This is a no-op for standard CommonJS usage.
module.exports.default = module.exports;
