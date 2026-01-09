// CONFIG_WHITELIST
//
// The set of non-standard property names in configuration to consider valid.
// Leave `undefined` to tolerate almost anything-- or set to an empty array to
// prevent everything except standard properties.
//
// This list is used to validate `meta` and connection-string query-string options passed through to
// the MongoDB Node driver.
//
// We intentionally allow a mix of:
// - Modern option names (MongoDB Node driver v4+ / v6+)
// - Legacy option names historically supported by this adapter (mapped in `create-manager.js`)
module.exports = [

  // TLS / SSL options (modern + legacy)
  'tls', 'tlsAllowInvalidCertificates', 'tlsAllowInvalidHostnames', 'tlsCAFile', 'tlsCertificateKeyFile', 'tlsCertificateKeyFilePassword', 'tlsInsecure',
  'ssl', 'sslValidate', 'sslCA', 'sslCert', 'sslKey', 'sslPass',

  // Pooling / timeouts (modern + legacy)
  'maxPoolSize', 'minPoolSize', 'maxIdleTimeMS', 'waitQueueTimeoutMS',
  'poolSize',
  'serverSelectionTimeoutMS', 'connectTimeoutMS', 'socketTimeoutMS',
  'heartbeatFrequencyMS',
  // Legacy connection opts (kept for backwards compatibility; modern drivers may ignore them)
  'autoReconnect', 'noDelay', 'keepAlive', 'reconnectTries', 'reconnectInterval',

  // Topology / deployment
  'replicaSet', 'directConnection',
  'srvServiceName', 'srvMaxHosts',

  // Auth / retry / read & write concern
  'authSource', 'authMechanism', 'authMechanismProperties',
  'retryReads', 'retryWrites',
  'readPreference', 'readConcern', 'readConcernLevel',
  'w', 'wtimeout', 'wtimeoutMS', 'journal', 'j',
  // Legacy HA / topology options
  'ha', 'haInterval', 'secondaryAcceptableLatencyMS', 'acceptableLatencyMS', 'connectWithNoPrimary',

  // Misc
  'appName', 'appname',
  'compressors', 'zlibCompressionLevel',
  'uuidRepresentation',
  'ignoreUndefined',
  'pkFactory',
  'forceServerObjectId',
  'serializeFunctions',
  'raw',
  'promoteLongs',
  'bufferMaxEntries'

];
