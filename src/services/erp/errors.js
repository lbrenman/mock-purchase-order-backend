'use strict';

const { toSapTimestamp } = require('../../shared/validate');

/**
 * ERP error dialect:
 * { "error": { "code": "PO_NOT_FOUND", "message": "...", "details": [{ "field": "...", "message": "..." }],
 *              "timestamp": "20260923165000", "correlation_id": "..." } }
 */
module.exports = function formatErpError(err, req) {
  const body = {
    error: {
      code: err.code,
      message: err.message,
      timestamp: toSapTimestamp(new Date()),
      correlation_id: req && req.correlationId,
    },
  };
  if (err.details) body.error.details = err.details.map((d) => ({ field: d.field, message: d.message }));
  return body;
};
