/* eslint no-console: "off" */

require('dotenv').config();
const db_connections = require('./db_connections'); /* eslint camelcase: "off" */
const knex = require('knex')(db_connections[process.env.NODE_ENV || 'development']);
const moment = require('moment-timezone')
const logger = require('../logger')

/**
 * Postgres returns the absolute date string with local offset detemined by its timezone setting.
 * Knex by default creates a javascript Date object from this string.
 * This function overrides knex's default to instead returns an ISO 8601 string with local offset.
 * For more info: https://github.com/brianc/node-pg-types
 */
const TIMESTAMPTZ_OID = 1184;
require('pg').types.setTypeParser(TIMESTAMPTZ_OID, date => moment(date).tz(process.env.TZ).format());

/**
 * Set of instructions for creating tables needed by the courtbot application.
 *
 * @type {Object}
 */
const createTableInstructions = {
    hearings() {
        return knex.schema.hasTable('hearings')
        .then((exists) => {
            if (!exists) {
                return knex.schema.createTable('hearings', (table) => {
                    table.string('defendant', 100);
                    table.timestamp('date');
                    table.string('room', 100);
                    table.string('case_id', 100);
                    table.string('type', 100);
                    table.primary(['case_id', 'date']);
                    table.index('case_id');
                })
            }
        })
    },
    requests() {
        return knex.schema.hasTable('requests')
        .then((exists) => {
            if (!exists) {
                return knex.schema.createTable('requests', (table) => {
                    table.timestamps(true, true);
                    table.string('case_id', 100);
                    table.string('phone', 100);
                    table.boolean('known_case').defaultTo(false);
                    table.boolean('active').defaultTo(true);
                    table.primary(['case_id', 'phone']);
                });
            }
        })
    },
    notifications() {
        return knex.schema.hasTable('notifications')
        .then((exists) => {
            if (!exists) {
                return knex.schema.createTable('notifications', (table) => {
                    table.timestamp('created_at').defaultTo(knex.fn.now());
                    table.string('case_id');
                    table.string('phone');
                    table.timestamp('event_date');
                    table.enu('type', ['reminder', 'matched', 'expired']);
                    table.string('error');
                    table.foreign(['case_id', 'phone']).onDelete('CASCADE').references(['case_id', 'phone' ]).inTable('requests')
                })
            }
        })
    },
    log_runners() {
        return knex.schema.hasTable('log_runners')
        .then((exists) => {
            if (!exists) {
                return knex.schema.createTable('log_runners', function (table) {
                    table.increments()
                    table.enu('runner', ['send_reminder', 'send_expired', 'send_matched','load'])
                    table.integer('count')
                    table.integer('error_count')
                    table.timestamp('date').defaultTo(knex.fn.now())
                })
            }
        })
    },
    log_hits() {
        return knex.schema.hasTable('log_hits')
        .then((exists) => {
            if (!exists) {
                return knex.schema.createTable('log_hits', function (table) {
                    table.timestamp('time').defaultTo(knex.fn.now()),
                    table.string('path'),
                    table.string('method'),
                    table.string('status_code'),
                    table.string('phone'),
                    table.string('body'),
                    table.string('action')
                })
            }
        })
    }
};

/**
 * Insert chunk of data to table
 *
 * @param  {String} table Table to insert data to.
 * @param  {Array} rows Array of rows to insert into the table.
 * @param  {number} size number of rows to insert into the table at one time.
 * @return {Promise}
 */
function batchInsert(table, rows, size) {
  logger.debug('batch inserting', rows.length, 'rows');

  // had to explicitly use transaction for record counts in test cases to work
  return knex.transaction(trx => trx.batchInsert(table, rows, size)
    .then(trx.commit)
    .catch(trx.rollback));
}

function acquireSingleConnection() {
    return knex.client.acquireConnection()
}

/**
 * Manually close one or all idle database connections.
 *
 * @return {void}
 */
function closeConnection(conn) {
  if (conn == null) {
    return knex.client.pool.destroy()
  } else {
    return knex.client.releaseConnection(conn)
  }
}

/**
 * Create specified table if it does not already exist.
 *
 * @param  {String} table [description]
 * @param  {function} table (optional) function to be performed after table is created.
 * @return {Promise}  Promise to create table if it does not exist.
 */
function createTable(table) {
  if (!createTableInstructions[table]) {
    logger.error(`No Table Creation Instructions found for table "${table}".`);
    return false;
  }

  return knex.schema.hasTable(table)
    .then((exists) => {
      if (exists) {
        return logger.debug(`Table "${table}" already exists.  Will not create.`);
      }

      return createTableInstructions[table]()
        .then(() => {
            return logger.debug(`Table created: "${table}"`);
        });
    });
}

/**
 * Drop specified table
 *
 * @param  {String} table name of the table to be dropped.
 * @return {Promise}  Promise to drop the specified table.
 */
function dropTable(table) {
  return knex.schema.dropTableIfExists(table)
    .then(() => logger.debug(`Dropped existing table "${table}"`));
}

/**
 * Ensure all necessary tables exist.
 *
 * Note:  create logic only creates if a table does not exists, so it is enough to just
 *   call createTable() for each table. Becuase of foreign key constraint, requests table must
 *   exist before creating notifications table. The order is important because of constraints.
 *
 * @return {Promise} Promise to ensure all courtbot tables exist.
 */
function ensureTablesExist() {
  const tables = ['requests', 'hearings', 'notifications', 'log_runners', 'log_hits']
  return tables.reduce((p, v) => p.then(() => {
      return createTable(v)
      .catch(err => logger.error(err))
    }), Promise.resolve())
}

module.exports = {
  ensureTablesExist,
  closeConnection,
  createTable,
  dropTable,
  batchInsert,
  knex,
  acquireSingleConnection
};
