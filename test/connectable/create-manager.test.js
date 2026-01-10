var assert = require('assert');
var createManager = require('machine').build(require('../../').createManager);
var destroyManager = require('machine').build(require('../../').destroyManager);

describe('Connectable ::', function() {
  describe('Create Manager', function() {
    it('should work without a protocol in the connection string', function(done) {
      createManager({
        connectionString: process.env.WATERLINE_ADAPTER_TESTS_URL || 'localhost:27017/mppg'
      })
      .exec(function(err, report) {
        if (err) {
          return done(err);
        }

        // Cleanup: modern MongoDB driver keeps sockets/SDAM monitors alive unless closed.
        if (report && report.manager) {
          return destroyManager({ manager: report.manager }).exec(done);
        }

        return done();
      });
    });

    it('should not work with an invalid protocol in the connection string', function(done) {
      createManager({
        connectionString: 'foobar://localhost:27017/mppg'
      })
      .exec(function(err) {
        try {
          assert(err, 'Expected error of SOME kind, but didnt get one!');
          assert.equal(err.exit, 'malformed', 'Expected it to exit from the `malformed` exit!  But it didndt... The error:'+err.stack);
        } catch (e) { return done(e); }
        return done();
      });
    });


    it('should successfully return a Mongo Server instance', function(done) {
      // Needed to dynamically get the host using the docker container
      var host = process.env.WATERLINE_ADAPTER_TESTS_HOST || 'localhost';

      createManager({
        connectionString: 'mongodb://' + host + ':27017/mppg'
      })
      .exec(function(err, report) {
        if (err) {
          return done(err);
        }

        try {
          assert(report.manager);
        } catch (e) { return done(e); }

        // Cleanup: close manager so mocha can exit cleanly.
        return destroyManager({ manager: report.manager }).exec(done);
      });
    });
  });
});
