'use strict';

/**
 * Internal error representation. Each backend renders it in its OWN wire
 * format (see services/<name>/errors.js) so the iPaaS has to normalise
 * three different error dialects into RFC 7807 ProblemDetails.
 */
class ApiError extends Error {
  constructor(status, code, message, details) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = Array.isArray(details) && details.length ? details : undefined;
  }
}

const asyncHandler = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

function translatePgError(err) {
  switch (err.code) {
    case '23505':
      return new ApiError(409, 'DUPLICATE_RECORD', err.detail || 'A record with the same key already exists');
    case '23503':
      return new ApiError(422, 'REFERENCE_NOT_FOUND', err.detail || 'A referenced record does not exist');
    case '22P02':
    case '22007':
    case '22008':
    case '22003':
      return new ApiError(400, 'INVALID_VALUE', err.message);
    case 'ECONNREFUSED':
    case '57P01':
    case '57P03':
      return new ApiError(503, 'DATABASE_UNAVAILABLE', 'The backing database is unavailable');
    default:
      return null;
  }
}

function errorHandler(formatError, serviceName) {
  // eslint-disable-next-line no-unused-vars
  return (err, req, res, next) => {
    let apiErr = err;
    if (!(err instanceof ApiError)) {
      if (err && err.type === 'entity.parse.failed') {
        apiErr = new ApiError(400, 'MALFORMED_JSON', 'Request body is not valid JSON');
      } else if (err && err.type === 'entity.too.large') {
        apiErr = new ApiError(413, 'PAYLOAD_TOO_LARGE', 'Request body is too large');
      } else {
        apiErr = translatePgError(err || {}) || new ApiError(500, 'UNEXPECTED_ERROR', 'An unexpected error occurred');
        if (apiErr.status >= 500) {
          console.error(`[${serviceName}] ${req.method} ${req.originalUrl} ->`, err);
        }
      }
    }
    if (apiErr.status === 503 || apiErr.status === 429) res.set('Retry-After', res.get('Retry-After') || '5');
    res.status(apiErr.status).json(formatError(apiErr, req));
  };
}

function notFoundHandler(formatError) {
  return (req, res) => {
    const e = new ApiError(404, 'ROUTE_NOT_FOUND', `No route for ${req.method} ${req.originalUrl}`);
    res.status(404).json(formatError(e, req));
  };
}

module.exports = { ApiError, asyncHandler, errorHandler, notFoundHandler };
