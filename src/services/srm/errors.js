'use strict';

/**
 * SRM error dialect (array of errors, camelCase):
 * { "errors": [ { "code": "SUPPLIER_NOT_FOUND", "message": "..." },
 *               { "code": "FIELD_INVALID", "field": "status", "message": "..." } ],
 *   "traceId": "..." }
 */
module.exports = function formatSrmError(err, req) {
  const errors = [{ code: err.code, message: err.message }];
  (err.details || []).forEach((d) => errors.push({ code: 'FIELD_INVALID', field: d.field, message: d.message }));
  return { errors, traceId: req && req.correlationId };
};
