module.exports = {


  friendlyName: 'Create manager',


  description: 'Build and initialize a connection manager instance (in Mongo, this is `db`).',


  moreInfoUrl: 'https://github.com/node-machine/driver-interface/blob/master/machines/create-manager.js',


  inputs: {

    connectionString: {
      description: 'The Mongo connection URL containing the configuration/credentials necessary for connecting to the database.',
      moreInfoUrl: 'http://sailsjs.com/documentation/reference/configuration/sails-config-datastores#?the-connection-url',
      // example: 'mongodb://foo:bar@localhost:27017/thedatabase',
      example: '===',
      required: true
    },

    onUnexpectedFailure: {
      friendlyName: 'On unxpected failure (unused)',
      description: 'A notifier function for otherwise-unhandled error events. (WARNING: Currently, this is ignored by mp-mongo!)',
      moreInfoUrl: 'https://github.com/node-machine/driver-interface/blob/3f3a150ef4ece40dc0d105006e2766e81af23719/machines/create-manager.js#L37-L49',
      // example: '->',
      example: '==='
    },

    meta: {
      friendlyName: 'Meta (custom)',
      description: 'A dictionary of additional options to pass in when instantiating the Mongo client instance. (e.g. `{ssl: true}`)',
      moreInfoUrl: 'https://github.com/node-machine/driver-interface/blob/3f3a150ef4ece40dc0d105006e2766e81af23719/constants/meta.input.js',
      example: '==='
    }

  },


  exits: {

    success: {
      description: 'Connected to Mongo successfully.',
      outputFriendlyName: 'Report',
      outputDescription: 'The `manager` property is a Mongo client instance.  The `meta` property is unused.',
      // outputExample: {
      //   manager: '===',
      //   meta: '==='
      // }
      outputExample: '==='
    },

    malformed: {
      description: 'The provided connection string is malformed.',
      extendedDescription: 'The format of connection strings varies across different databases and their drivers. This exit indicates that the provided string is not valid as per the custom rules of this driver. Note that if this exit is traversed, it means the driver DID NOT ATTEMPT to create a manager-- instead the invalid connection string was discovered during a check performed beforehand.',
      outputFriendlyName: 'Report',
      outputDescription: 'The `error` property is a JavaScript Error instance explaining that (and preferably "why") the provided connection string is invalid. The `meta` property is reserved for custom driver-specific extensions.',
      outputExample: {
        error: '===',
        meta: '==='
      }
    },

    failed: {
      description: 'Could not connect to Mongo using the specified connection URL.',
      extendedDescription:
        'If this exit is called, it might mean any of the following:\n' +
        ' + the credentials encoded in the connection string are incorrect\n' +
        ' + there is no database server running at the provided host (i.e. even if it is just that the database process needs to be started)\n' +
        ' + there is no software "database" with the specified name running on the server\n' +
        ' + the provided connection string does not have necessary access rights for the specified software "database"\n' +
        ' + this Node.js process could not connect to the database, perhaps because of firewall/proxy settings\n' +
        ' + any other miscellaneous connection error\n' +
        '\n' +
        'Note that even if the database is unreachable, bad credentials are being used, etc, ' +
        'this exit will not necessarily be called-- that depends on the implementation of the driver ' +
        'and any special configuration passed to the `meta` input. e.g. if a pool is being used that spins up ' +
        'multiple connections immediately when the manager is created, then this exit will be called if any of ' +
        'those initial attempts fail. On the other hand, if the manager is designed to produce adhoc connections, ' +
        'any errors related to bad credentials, connectivity, etc. will not be caught until `getConnection()` is called.',
      outputFriendlyName: 'Report',
      outputDescription: 'The `error` property is a JavaScript Error instance with more information and a stack trace. The `meta` property is reserved for custom driver-specific extensions.',
      outputExample: {
        error: '===',
        meta: '==='
      }
    }

  },

  fn: function (inputs, exits) {

    var _ = require('@sailshq/lodash');
    var url = require('url');
    var NodeMongoDBNativeLib = require('mongodb');
    var CONFIG_WHITELIST = require('../constants/config-whitelist.constant');
    var EXPECTED_URL_PROTOCOL_PFX = require('../constants/expected-url-protocol-pfx.constant');
    var normalizeDatastoreConfig = require('../normalize-datastore-config');

    // Note:
    // Support for different types of managers is database-specific, and is not
    // built into the Waterline driver spec-- however this type of configurability
    // can be instrumented using `meta`.
    //
    // Feel free to fork this adapter and customize as you see fit.  Also note that
    // contributions to the core adapter in this area are welcome and greatly appreciated!

    // Normalize datastore.
    var _clientConfig = _.extend({
      url: inputs.connectionString
    }, inputs.meta);

    try {
      normalizeDatastoreConfig(_clientConfig, CONFIG_WHITELIST, EXPECTED_URL_PROTOCOL_PFX);
    } catch (e) {
      switch (e.code) {
        case 'E_BAD_CONFIG': return exits.malformed({ error: e, meta: undefined });
        default: return exits.error(e);
      }
    }

    // Mongo doesn't like some of our standard properties, so we'll remove them
    // (we don't need any of them now anyway, since we know at this point that
    // they'll have been baked into the URL)
    var mongoUrl = _clientConfig.url;

    // Strip legacy, no-longer-supported URL query params (e.g. from old sails-mongo / old node driver docs).
    // MongoDB Node driver v4+ (and especially v6+) will throw on unknown URL options.
    //
    // Common offenders seen in the wild:
    // - reconnectTries / reconnectInterval (removed; modern driver handles reconnect internally)
    // - autoReconnect (removed)
    try {
      var u = new URL(mongoUrl);
      var UNSUPPORTED_URL_OPTS = {
        reconnecttries: true,
        reconnectinterval: true,
        autoreconnect: true
      };
      // Collect first to avoid iterator weirdness during deletion.
      var keysToDelete = [];
      u.searchParams.forEach(function (unusedVal, key) {
        if (UNSUPPORTED_URL_OPTS[String(key).toLowerCase()]) {
          keysToDelete.push(key);
        }
      });
      keysToDelete.forEach(function (k) { u.searchParams.delete(k); });
      mongoUrl = u.toString();
    } catch (unusedErr) { /* ignore */ }
    _clientConfig = _.omit(_clientConfig, ['url', 'user', 'password', 'host', 'port', 'database']);

    // Strip legacy options that the modern MongoDB driver does not support.
    // These can show up here because `normalizeDatastoreConfig()` copies URL querystring opts
    // onto the top-level config object, and we merge those into `_clientConfig` above.
    _.each([
      'reconnectTries',
      'reconnectInterval',
      'autoReconnect',
      'reconnecttries',
      'reconnectinterval',
      'autoreconnect'
    ], function (legacyKey) {
      if (!_.isUndefined(_clientConfig[legacyKey])) {
        delete _clientConfig[legacyKey];
      }
    });

    // Legacy option mapping (for compatibility with older sails-mongo configs).
    // Note: Most of these legacy options are no-ops or removed in modern drivers; we translate the
    // common ones into their modern equivalents when possible.
    if (!_.isUndefined(_clientConfig.poolSize) && _.isUndefined(_clientConfig.maxPoolSize)) {
      _clientConfig.maxPoolSize = _clientConfig.poolSize;
    }
    if (!_.isUndefined(_clientConfig.ssl) && _.isUndefined(_clientConfig.tls)) {
      _clientConfig.tls = _clientConfig.ssl;
    }
    // sslValidate=false historically meant "do not validate" -> tlsInsecure=true
    if (!_.isUndefined(_clientConfig.sslValidate) && _.isUndefined(_clientConfig.tlsInsecure)) {
      _clientConfig.tlsInsecure = (_clientConfig.sslValidate === false || _clientConfig.sslValidate === 'false');
    }

    // Connect using the modern MongoDB Node driver API (promise-based).
    (async ()=>{

      var client = new NodeMongoDBNativeLib.MongoClient(mongoUrl, _clientConfig);
      await client.connect();

      // Prefer the DB name from the connection string (if present); otherwise allow Mongo to use
      // its default (usually `test`).
      var dbName;
      try {
        var parsed = url.parse(mongoUrl);
        if (parsed && parsed.pathname) {
          dbName = _.trim(parsed.pathname, '/');
        }
      } catch (unusedErr) { /* ignore */ }

      var db = client.db(dbName || undefined);

      // Historically, sails-mongo treated the "manager" as the Db handle (it must have `.collection()`).
      // We keep that contract, but also wire in a `close()` so lifecycle cleanup still works.
      db.close = client.close.bind(client);
      db._mongoClient = client;

      // Now mutate this manager, giving it a telltale.
      db._isFromMPMongo = true;

      return exits.success({
        manager: db,
        meta: inputs.meta
      });

    })().catch(function (err){
      return exits.error(err);
    });
  }


};
