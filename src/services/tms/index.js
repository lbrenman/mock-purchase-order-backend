'use strict';

const path = require('path');
const { createServiceRouter } = require('../../shared/service');
const formatError = require('./errors');
const buildRoutes = require('./routes');

module.exports = () =>
  createServiceRouter({
    name: 'tms',
    specFile: path.join(__dirname, '../../../openapi/tms.yaml'),
    formatError,
    buildRoutes,
  });
