'use strict';

/**
 * TMS error dialect (SOAP-fault inspired):
 * { "fault": { "faultCode": "tms.DUPLICATE_ASN", "faultString": "...", "httpStatus": 409,
 *              "detail": [ { "path": "...", "issue": "..." } ], "correlationId": "..." } }
 */
module.exports = function formatTmsError(err, req) {
  const fault = {
    faultCode: `tms.${err.code}`,
    faultString: err.message,
    httpStatus: err.status,
    correlationId: req && req.correlationId,
  };
  if (err.details) fault.detail = err.details.map((d) => ({ path: d.field, issue: d.message }));
  return { fault };
};
