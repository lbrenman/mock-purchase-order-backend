'use strict';

const path = require('path');
const { createServiceRouter } = require('../../shared/service');
const formatError = require('./errors');
const buildRoutes = require('./routes');

module.exports = () =>
  createServiceRouter({
    name: 'srm',
    specFile: path.join(__dirname, '../../../openapi/srm.yaml'),
    formatError,
    buildRoutes,
  });
