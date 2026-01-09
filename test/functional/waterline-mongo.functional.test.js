var assert = require('assert');
var _ = require('@sailshq/lodash');
var Waterline = require('waterline');
var waterlineUtils = require('waterline-utils');
var MongoClient = require('mongodb').MongoClient;
var ObjectId = require('mongodb').ObjectID || require('mongodb').ObjectId;
var Binary = require('mongodb').Binary;


describe('Functional :: Waterline + sails-mongo (real MongoDB)', function() {
  this.timeout(20000);

  var waterline;
  var models = {};
  var adapterUrl;
  var mongoUrl;
  var dbName;
  var nativeClient;
  var nativeDb;

  before(function(done) {
    dbName = buildTestDbName();
    adapterUrl = buildAdapterUrlWithDb(dbName);
    mongoUrl = toMongoUrl(adapterUrl);

    Promise.resolve()
    .then(async function() {
      nativeClient = new MongoClient(mongoUrl);
      await nativeClient.connect();
      nativeDb = nativeClient.db(dbName);

      await new Promise(function(resolve, reject) {
        setupWaterline(adapterUrl, models, function(err, wl) {
          if (err) { return reject(err); }
          waterline = wl;
          return resolve();
        });
      });
    })
    .then(function(){ return done(); })
    .catch(done);
  });

  after(function(done) {
    Promise.resolve()
    .then(async function() {
      if (waterline) {
        await new Promise(function(resolve, reject) {
          return waterline.teardown(function(err) {
            if (err) { return reject(err); }
            return resolve();
          });
        });
      }

      if (nativeDb) {
        await nativeDb.dropDatabase();
      }

      if (nativeClient) {
        await nativeClient.close();
      }
    })
    .then(function(){ return done(); })
    .catch(done);
  });

  beforeEach(function(done) {
    Promise.resolve()
    .then(async function() {
      // Keep indexes, just clear docs between tests.
      await nativeDb.collection('user').deleteMany({});
      await nativeDb.collection('pet').deleteMany({});
      await nativeDb.collection('legacy_user').deleteMany({});
    })
    .then(function(){ return done(); })
    .catch(done);
  });


  it('should create and find records (ObjectId PK surfaced as hex string)', function(done) {
    models.user.create({
      name: 'Alice',
      age: 33,
      email: 'alice-'+Date.now()+'@example.com'
    })
    .exec(function(err, created) {
      if (err) { return done(err); }

      try {
        assert(created);
        assert.equal(typeof created.id, 'string');
        assert.match(created.id, /^[0-9a-f]{24}$/);
      } catch (e) { return done(e); }

      models.user.findOne({ id: created.id }).exec(function(err, found) {
        if (err) { return done(err); }
        try {
          assert(found);
          assert.equal(found.id, created.id);
          assert.equal(found.name, 'Alice');
          assert.equal(found.age, 33);
        } catch (e) { return done(e); }
        return done();
      });
    });
  });


  it('should store and retrieve Buffers transparently via `type: ref`', function(done) {
    var payload = Buffer.from('hello-mongo-buffer');

    models.user.create({
      name: 'HasBuffer',
      age: 1,
      email: 'buf-'+Date.now()+'@example.com',
      blob: payload
    })
    .exec(function(err, created) {
      if (err) { return done(err); }

      Promise.resolve()
      .then(async function() {
        var native = await nativeDb.collection('user').findOne({ _id: new ObjectId(created.id) });
        assert(native);
        assert(native._id instanceof ObjectId);
        assert(native.blob instanceof Binary);
      })
      .then(function() {
        models.user.findOne({ id: created.id }).exec(function(err, found) {
          if (err) { return done(err); }
          try {
            assert(found);
            assert(Buffer.isBuffer(found.blob));
            assert.equal(found.blob.toString(), payload.toString());
          } catch (e) { return done(e); }
          return done();
        });
      })
      .catch(done);
    });
  });


  it('should support createEach, sort, limit, and skip', function(done) {
    models.user.createEach([
      { name: 'A', age: 10, email: 'a-'+Date.now()+'@example.com' },
      { name: 'B', age: 20, email: 'b-'+Date.now()+'@example.com' },
      { name: 'C', age: 30, email: 'c-'+Date.now()+'@example.com' },
      { name: 'D', age: 40, email: 'd-'+Date.now()+'@example.com' }
    ])
    .exec(function(err, created) {
      if (err) { return done(err); }
      try {
        assert(Array.isArray(created));
        assert.equal(created.length, 4);
      } catch (e) { return done(e); }

      models.user.find({
        where: { age: { '>=': 20 } },
        sort: 'age ASC',
        skip: 1,
        limit: 2
      })
      .exec(function(err, found) {
        if (err) { return done(err); }
        try {
          assert(Array.isArray(found));
          assert.equal(found.length, 2);
          assert.equal(found[0].age, 30);
          assert.equal(found[1].age, 40);
        } catch (e) { return done(e); }
        return done();
      });
    });
  });


  it('should support where operators: in, nin, !=, and/or, and like (+case-insensitive meta)', function(done) {
    models.user.createEach([
      { name: 'FooBar', age: 10, email: 'w1-'+Date.now()+'@example.com' },
      { name: 'Zed', age: 20, email: 'w2-'+Date.now()+'@example.com' },
      { name: 'Another', age: 30, email: 'w3-'+Date.now()+'@example.com' }
    ])
    .exec(function(err, created) {
      if (err) { return done(err); }

      var someId = created[1].id;

      models.user.find({
        where: {
          and: [
            { id: { nin: [someId] } },
            { or: [ { age: { '!=': 20 } }, { name: 'nonexistent' } ] }
          ]
        },
        sort: 'age ASC'
      })
      .exec(function(err, found) {
        if (err) { return done(err); }
        try {
          assert.equal(found.length, 2);
          assert.equal(found[0].age, 10);
          assert.equal(found[1].age, 30);
        } catch (e) { return done(e); }

        models.user.find({
          where: { id: { in: [someId] } }
        })
        .exec(function(err, foundIn) {
          if (err) { return done(err); }
          try {
            assert.equal(foundIn.length, 1);
            assert.equal(foundIn[0].id, someId);
          } catch (e) { return done(e); }

          models.user.find({ where: { name: { like: '%foobar%' } } })
          .meta({ makeLikeModifierCaseInsensitive: true })
          .exec(function(err, likeFound) {
            if (err) { return done(err); }
            try {
              assert.equal(likeFound.length, 1);
              assert.equal(likeFound[0].name, 'FooBar');
            } catch (e) { return done(e); }
            return done();
          });
        });
      });
    });
  });


  it('should update and destroy records (with fetch flags enabled)', function(done) {
    models.user.create({
      name: 'ToUpdate',
      age: 1,
      email: 'upd-'+Date.now()+'@example.com'
    })
    .exec(function(err, created) {
      if (err) { return done(err); }

      models.user.update({ id: created.id })
      .set({ age: 2, name: 'Updated' })
      .exec(function(err, updated) {
        if (err) { return done(err); }
        try {
          assert(Array.isArray(updated));
          assert.equal(updated.length, 1);
          assert.equal(updated[0].id, created.id);
          assert.equal(updated[0].age, 2);
          assert.equal(updated[0].name, 'Updated');
        } catch (e) { return done(e); }

        models.user.destroy({ id: created.id })
        .exec(function(err, destroyed) {
          if (err) { return done(err); }
          try {
            assert(Array.isArray(destroyed));
            assert.equal(destroyed.length, 1);
            assert.equal(destroyed[0].id, created.id);
          } catch (e) { return done(e); }

          models.user.findOne({ id: created.id }).exec(function(err, found) {
            if (err) { return done(err); }
            try { assert.equal(found, undefined); } catch (e) { return done(e); }
            return done();
          });
        });
      });
    });
  });


  it('should enforce unique indexes and surface notUnique errors', function(done) {
    var email = 'unique-'+Date.now()+'@example.com';
    models.user.create({ name: 'U1', age: 1, email: email }).exec(function(err) {
      if (err) { return done(err); }

      models.user.create({ name: 'U2', age: 2, email: email }).exec(function(err) {
        try {
          assert(err, 'Expected a uniqueness error, but got none.');
          // Depending on Waterline version / wrapping, this may show up differently:
          assert(
            err.code === 'E_UNIQUE' ||
            (err.footprint && err.footprint.identity === 'notUnique') ||
            (err.raw && err.raw.code === 11000) ||
            err.code === 11000,
            'Expected a notUnique-style error, but got: ' + (err.stack || err)
          );
        } catch (e) { return done(e); }
        return done();
      });
    });
  });


  it('should store foreign keys as ObjectIds in Mongo, while Waterline returns hex strings', function(done) {
    models.user.create({
      name: 'Owner',
      age: 9,
      email: 'owner-'+Date.now()+'@example.com'
    })
    .exec(function(err, owner) {
      if (err) { return done(err); }

      models.pet.create({
        name: 'Pet1',
        owner: owner.id
      })
      .exec(function(err, pet) {
        if (err) { return done(err); }

        Promise.resolve()
        .then(async function() {
          var nativePet = await nativeDb.collection('pet').findOne({ _id: new ObjectId(pet.id) });
          assert(nativePet);
          assert(nativePet.owner instanceof ObjectId);
          assert.equal(nativePet.owner.toString(), owner.id);
        })
        .then(function() {
          models.pet.findOne({ id: pet.id }).exec(function(err, found) {
            if (err) { return done(err); }
            try {
              assert(found);
              assert.equal(found.owner, owner.id);
            } catch (e) { return done(e); }
            return done();
          });
        })
        .catch(done);
      });
    });
  });


  it('should always include the primary key even when using select (so downstream .save() can work)', function(done) {
    models.user.create({
      name: 'SelectPk',
      age: 5,
      email: 'selectpk-'+Date.now()+'@example.com'
    })
    .exec(function(err, created) {
      if (err) { return done(err); }

      models.user.findOne({
        where: { id: created.id },
        select: ['name']
      })
      .exec(function(err, found) {
        if (err) { return done(err); }
        try {
          assert(found);
          assert.equal(found.name, 'SelectPk');
          assert.equal(typeof found.id, 'string');
          assert.match(found.id, /^[0-9a-f]{24}$/);
        } catch (e) { return done(e); }
        return done();
      });
    });
  });


  it('should include the primary key for every record when using select in find()', function(done) {
    models.user.createEach([
      { name: 'S1', age: 1, email: 's1-'+Date.now()+'@example.com' },
      { name: 'S2', age: 2, email: 's2-'+Date.now()+'@example.com' },
      { name: 'S3', age: 3, email: 's3-'+Date.now()+'@example.com' }
    ])
    .exec(function(err) {
      if (err) { return done(err); }

      models.user.find({
        where: { age: { '>=': 1 } },
        select: ['name'],
        sort: 'age ASC'
      })
      .exec(function(err, records) {
        if (err) { return done(err); }
        try {
          assert(Array.isArray(records));
          assert.equal(records.length, 3);
          _.each(records, function (r) {
            assert.equal(typeof r.id, 'string');
            assert.match(r.id, /^[0-9a-f]{24}$/);
            assert(r.name);
          });
        } catch (e) { return done(e); }
        return done();
      });
    });
  });


  it('should preserve primary keys when using select + populate', function(done) {
    models.user.create({
      name: 'PopOwner',
      age: 1,
      email: 'pop-'+Date.now()+'@example.com'
    })
    .exec(function(err, owner) {
      if (err) { return done(err); }

      models.pet.create({ name: 'PopPet', owner: owner.id })
      .exec(function(err) {
        if (err) { return done(err); }

        models.user.findOne({ where: { id: owner.id }, select: ['name'] })
        .populate('pets', { select: ['name'] })
        .exec(function(err, found) {
          if (err) { return done(err); }
          try {
            assert(found);
            assert.equal(found.name, 'PopOwner');
            assert.equal(typeof found.id, 'string');
            assert.match(found.id, /^[0-9a-f]{24}$/);

            assert(Array.isArray(found.pets));
            assert.equal(found.pets.length, 1);
            assert.equal(found.pets[0].name, 'PopPet');
            assert.equal(typeof found.pets[0].id, 'string');
            assert.match(found.pets[0].id, /^[0-9a-f]{24}$/);
          } catch (e) { return done(e); }
          return done();
        });
      });
    });
  });


  it('should support ObjectId instances in where constraints (no clobbering)', function(done) {
    models.user.create({
      name: 'OidWhere',
      age: 1,
      email: 'oid-'+Date.now()+'@example.com'
    })
    .exec(function(err, created) {
      if (err) { return done(err); }

      var oid = new ObjectId(created.id);
      // Waterline's criteria validator will reject an ObjectId instance in a stage-2 query
      // (it sees ObjectId's internal properties like `buffer` as "modifiers").
      // But stage-3 queries can legitimately contain instantiated ObjectIds (e.g. via wrappers),
      // and the adapter should not clobber them when building the Mongo where-clause.
      var s3q = {
        method: 'find',
        using: 'user',
        criteria: {
          where: { _id: oid },
          limit: 1,
          skip: 0,
          sort: [],
          select: ['name']
        },
        meta: {}
      };

      models.user._adapter.find('test', s3q, function(err, records) {
        if (err) { return done(err); }
        try {
          assert(Array.isArray(records));
          assert.equal(records.length, 1);
          assert.equal(records[0].id, created.id);
          assert.equal(records[0].name, 'OidWhere');
        } catch (e) { return done(e); }
        return done();
      });
    });
  });


  it('should include the primary key when using select for dontUseObjectIds models', function(done) {
    models.legacyuser.create({ id: 123, name: 'Legacy' }).exec(function(err) {
      if (err) { return done(err); }

      models.legacyuser.findOne({ where: { id: 123 }, select: ['name'] })
      .exec(function(err, found) {
        if (err) { return done(err); }
        try {
          assert(found);
          assert.equal(found.name, 'Legacy');
          assert.equal(found.id, 123);
        } catch (e) { return done(e); }
        return done();
      });
    });
  });


  // ==========================================================================
  // Tests for create/createEach returning PKs and supporting .save() patterns
  // These tests reproduce the issue with createOrUpdate -> .save() patterns
  // ==========================================================================

  it('should return record with PK from create() (with fetch enabled by default)', function(done) {
    // Our test setup has fetchRecordsOnCreate: true, so records should be returned with PKs
    models.user.create({
      name: 'CreateWithPK',
      age: 99,
      email: 'createwithpk-'+Date.now()+'@example.com'
    })
    .exec(function(err, created) {
      if (err) { return done(err); }
      try {
        assert(created, 'Expected a record to be returned');
        assert.equal(typeof created.id, 'string', 'Expected id to be a string');
        assert.match(created.id, /^[0-9a-f]{24}$/, 'Expected id to be a valid ObjectId hex');
        assert.equal(created.name, 'CreateWithPK');
      } catch (e) { return done(e); }
      return done();
    });
  });


  it('should return records with PKs from createEach() (with fetch enabled by default)', function(done) {
    models.user.createEach([
      { name: 'CreateEachPK1', age: 1, email: 'cepk1-'+Date.now()+'@example.com' },
      { name: 'CreateEachPK2', age: 2, email: 'cepk2-'+Date.now()+'@example.com' }
    ])
    .exec(function(err, created) {
      if (err) { return done(err); }
      try {
        assert(Array.isArray(created), 'Expected an array of records');
        assert.equal(created.length, 2, 'Expected 2 records');
        _.each(created, function(rec) {
          assert.equal(typeof rec.id, 'string', 'Expected id to be a string');
          assert.match(rec.id, /^[0-9a-f]{24}$/, 'Expected id to be a valid ObjectId hex');
        });
      } catch (e) { return done(e); }
      return done();
    });
  });


  it('should support createOrUpdate pattern: findOne returns record with PK for update', function(done) {
    // This simulates what nxus-storage's createOrUpdate does when record exists:
    // 1. findOne() - returns record instance
    // 2. update() - updates and returns records
    // 3. Waterline uses the PK from the returned record for the update

    var email = 'createorupdate-'+Date.now()+'@example.com';

    // Create a record first
    models.user.create({ name: 'CreateOrUpdate', age: 1, email: email })
    .exec(function(err, created) {
      if (err) { return done(err); }
      try {
        assert(created, 'Expected created record');
        assert(created.id, 'Expected created record to have an id');
      } catch (e) { return done(e); }

      // Now simulate createOrUpdate finding the existing record
      models.user.findOne({ email: email }).exec(function(err, found) {
        if (err) { return done(err); }
        try {
          assert(found, 'Expected to find the record');
          assert(found.id, 'Expected found record to have an id');
          assert.equal(found.id, created.id);
        } catch (e) { return done(e); }

        // Update the record (like createOrUpdate does when record exists)
        models.user.update({ id: found.id }, { age: 2, name: 'CreateOrUpdate-Modified' })
        .exec(function(err, updated) {
          if (err) { return done(err); }
          try {
            assert(Array.isArray(updated));
            assert.equal(updated.length, 1);
            assert.equal(updated[0].age, 2);
            assert.equal(updated[0].name, 'CreateOrUpdate-Modified');
            assert(updated[0].id, 'Expected updated record to have an id');
          } catch (e) { return done(e); }
          return done();
        });
      });
    });
  });


  it('should support findOrCreate pattern: returned record has PK for subsequent operations', function(done) {
    var email = 'findorcreate-'+Date.now()+'@example.com';

    models.user.findOrCreate(
      { email: email },
      { name: 'FindOrCreate', age: 1, email: email }
    )
    .exec(function(err, record, wasCreated) {
      if (err) { return done(err); }
      try {
        assert(record, 'Expected a record');
        assert(record.id, 'Expected record to have an id');
        assert.equal(typeof record.id, 'string');
        assert.match(record.id, /^[0-9a-f]{24}$/);
        assert.equal(wasCreated, true, 'Expected record to be newly created');
      } catch (e) { return done(e); }

      // Use the PK for subsequent update
      models.user.update({ id: record.id }, { age: 5 }).exec(function(err) {
        if (err) { return done(err); }

        // Verify persistence
        models.user.findOne({ id: record.id }).exec(function(err, found) {
          if (err) { return done(err); }
          try {
            assert(found);
            assert.equal(found.age, 5);
          } catch (e) { return done(e); }
          return done();
        });
      });
    });
  });


  it('should support chained updates: record from update has PK for further updates', function(done) {
    models.user.create({
      name: 'ChainedUpdate',
      age: 1,
      email: 'chainedupdate-'+Date.now()+'@example.com'
    })
    .exec(function(err, created) {
      if (err) { return done(err); }

      models.user.update({ id: created.id })
      .set({ age: 2 })
      .exec(function(err, updated) {
        if (err) { return done(err); }
        try {
          assert(Array.isArray(updated));
          assert.equal(updated.length, 1);
          assert(updated[0].id, 'Expected updated record to have an id');
          assert.equal(typeof updated[0].id, 'string');
          assert.match(updated[0].id, /^[0-9a-f]{24}$/);
        } catch (e) { return done(e); }

        // Use the PK from updated record for another update
        models.user.update({ id: updated[0].id }, { age: 3 }).exec(function(err, updated2) {
          if (err) { return done(err); }
          try {
            assert(Array.isArray(updated2));
            assert.equal(updated2.length, 1);
            assert.equal(updated2[0].age, 3);
          } catch (e) { return done(e); }

          // Verify
          models.user.findOne({ id: created.id }).exec(function(err, found) {
            if (err) { return done(err); }
            try {
              assert(found);
              assert.equal(found.age, 3);
            } catch (e) { return done(e); }
            return done();
          });
        });
      });
    });
  });

});


function setupWaterline(adapterUrl, modelsContainer, cb) {
  var defaults = {
    primaryKey: 'id',
    datastore: 'test',
    fetchRecordsOnUpdate: true,
    fetchRecordsOnDestroy: true,
    fetchRecordsOnCreate: true,
    fetchRecordsOnCreateEach: true,
    migrate: 'drop'
  };

  var waterline = new Waterline();

  var fixtures = {
    user: _.extend({}, defaults, {
      identity: 'user',
      tableName: 'user',
      attributes: {
        id: { type: 'string', columnName: '_id', autoMigrations: { columnType: 'string', unique: true, autoIncrement: false } },
        email: { type: 'string', required: true, autoMigrations: { columnType: 'string', unique: true, autoIncrement: false } },
        name: { type: 'string', autoMigrations: { columnType: 'string', unique: false, autoIncrement: false } },
        age: { type: 'number', autoMigrations: { columnType: 'number', unique: false, autoIncrement: false } },
        blob: { type: 'ref', autoMigrations: { columnType: 'ref', unique: false, autoIncrement: false } },
        pets: { collection: 'pet', via: 'owner' }
      }
    }),
    pet: _.extend({}, defaults, {
      identity: 'pet',
      tableName: 'pet',
      attributes: {
        id: { type: 'string', columnName: '_id', autoMigrations: { columnType: 'string', unique: true, autoIncrement: false } },
        name: { type: 'string', autoMigrations: { columnType: 'string', unique: false, autoIncrement: false } },
        owner: { model: 'user' }
      }
    }),
    legacyuser: _.extend({}, defaults, {
      identity: 'legacyuser',
      tableName: 'legacy_user',
      dontUseObjectIds: true,
      attributes: {
        id: { type: 'number', columnName: '_id', autoMigrations: { columnType: 'number', unique: true, autoIncrement: false } },
        name: { type: 'string', autoMigrations: { columnType: 'string', unique: false, autoIncrement: false } }
      }
    })
  };

  _.each(fixtures, function(modelFixture) {
    waterline.registerModel(Waterline.Collection.extend(modelFixture));
  });

  // Clear the adapter from memory.
  delete require.cache[require.resolve('../../')];

  var datastores = {
    test: {
      adapter: 'sails-mongo',
      url: adapterUrl
    }
  };

  waterline.initialize({ adapters: { 'sails-mongo': require('../../') }, datastores: datastores, defaults: defaults }, function(err, _orm) {
    if (err) { return cb(err); }

    waterlineUtils.autoMigrations('drop', _orm, function(err) {
      if (err) { return cb(err); }

      _.each(_orm.collections, function(collection, identity) {
        modelsContainer[identity] = collection;
      });

      return cb(null, waterline, _orm);
    });
  });
}


function buildTestDbName() {
  return 'sails_mongo_functional_' + Date.now() + '_' + Math.random().toString(16).slice(2);
}


function toMongoUrl(adapterUrl) {
  // MongoClient requires a protocol.  The adapter accepts urls with or without one.
  if (adapterUrl.match(/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//)) {
    return adapterUrl;
  }
  return 'mongodb://' + adapterUrl;
}


function buildAdapterUrlWithDb(dbName) {
  var base = process.env.MONGO_FUNCTIONAL_URL || process.env.WATERLINE_ADAPTER_TESTS_URL;

  if (!base) {
    var host = process.env.WATERLINE_ADAPTER_TESTS_HOST || 'localhost';
    var port = process.env.MONGO_PORT || 27017;
    return host + ':' + port + '/' + dbName;
  }

  return replaceDbName(base, dbName);
}


function replaceDbName(baseUrl, dbName) {
  var pieces = baseUrl.split('?');
  var withoutQs = pieces[0];
  var qs = pieces[1] ? ('?' + pieces[1]) : '';

  // If this looks like a standard mongo connection string, use URL parsing.
  if (withoutQs.indexOf('://') !== -1) {
    var u = new URL(withoutQs + qs);
    u.pathname = '/' + dbName;
    return u.toString();
  }

  // Otherwise, handle adapter-style urls like "user@localhost:27017/somedb".
  var parts = withoutQs.split('/');
  if (parts.length === 1) {
    return parts[0] + '/' + dbName + qs;
  }

  parts[parts.length - 1] = dbName;
  return parts.join('/') + qs;
}

