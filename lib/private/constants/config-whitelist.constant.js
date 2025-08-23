// CONFIG_WHITELIST
//
// The set of non-standard property names in configuration to consider valid.
// Leave `undefined` to tolerate almost anything-- or set to an empty array to
// prevent everything except standard properties.
//
// > http://mongodb.github.io/node-mongodb-native/2.2/reference/connecting/connection-settings/
module.exports = [

  // SSL/TLS Options:
  'ssl', 'sslValidate', 'sslCA', 'sslCert', 'sslKey', 'sslPass',
  'tls', 'tlsAllowInvalidCertificates', 'tlsAllowInvalidHostnames', 'tlsCAFile', 'tlsCertificateKeyFile',

  // Connection Pool Options:
  'poolSize', // legacy
  'maxPoolSize', 'minPoolSize', 'maxIdleTimeMS', 'waitQueueTimeoutMS',

  // Socket/Timeout Options:
  'noDelay', 'keepAlive', 'connectTimeoutMS', 'socketTimeoutMS', 'serverSelectionTimeoutMS', 'heartbeatFrequencyMS',

  // Retry/Topology Options:
  'autoReconnect', // legacy
  'reconnectTries', 'reconnectInterval', // legacy
  'retryWrites', 'retryReads', 'directConnection', 'replicaSet', 'readPreference', 'readPreferenceTags', 'readConcern', 'loadBalanced',

  // Write Concern Options:
  'w', 'wtimeout', 'wtimeoutMS', 'j', 'journal',

  // Auth Options:
  'authSource', 'authMechanism', 'authMechanismProperties',

  // Misc Options:
  'forceServerObjectId', 'serializeFunctions', 'ignoreUndefined', 'raw', 'promoteLongs', 'promoteBuffers', 'promoteValues',
  'bufferMaxEntries', // legacy
  'pkFactory', 'appname', 'appName', 'compressors', 'zlibCompressionLevel', 'srvMaxHosts', 'srvServiceName'

];
