// Tiny in-memory rate limiter for sign-in and password-reset attempts.
//
// One counter per key (an email address), counting failures/requests inside a
// sliding window. When the count reaches maxAttempts the key is blocked until
// the window passes. Counters live in memory only: the app runs as a single
// instance on the free tier, and a restart clearing counters only ever
// loosens the limit — it can never lock a real user out permanently.
// Successful sign-ins reset the counter (see server.js).
function createLimiter({ maxAttempts, windowMs }) {
  const attempts = new Map(); // key -> { count, firstAt }
  function prune(now) {
    for (const [key, value] of attempts) {
      if (now - value.firstAt >= windowMs) attempts.delete(key);
    }
  }
  return {
    isBlocked(key, now = Date.now()) {
      prune(now);
      const value = attempts.get(key);
      return !!value && value.count >= maxAttempts;
    },
    // Counts one failure (sign-in) or one request (reset) against the key.
    record(key, now = Date.now()) {
      prune(now);
      const value = attempts.get(key);
      if (!value) attempts.set(key, { count: 1, firstAt: now });
      else value.count += 1;
    },
    reset(key) {
      attempts.delete(key);
    },
  };
}

module.exports = { createLimiter };
