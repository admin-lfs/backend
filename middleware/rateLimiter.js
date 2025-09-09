const redis = require("../config/redis");
const crypto = require("crypto");
const { verifyToken } = require("../utils/jwt");

const getIdentifier = (req) => {
  // 1. Check if user is authenticated - VERIFY token for security
  const authHeader = req.headers["authorization"];
  const token = authHeader && authHeader.split(" ")[1];

  if (token) {
    try {
      // VERIFY token once here - prevents fake JWT attacks
      const decoded = verifyToken(token);
      if (decoded && decoded.userId) {
        req.decodedToken = decoded; // Store verified token
        req.tokenVerified = true; // Flag that token is already verified
        // Use just userId for rate limiting (user can have multiple orgs)
        return `user:${decoded.userId}`; // ✅ User-specific limiting (unlimited users per IP)
      }
    } catch (error) {
      console.warn("JWT verification failed in rate limiter:", error.message);
      // Invalid/expired/fake token - mark as unverified and use IP limiting
      req.tokenVerified = false;
    }
  }

  // 2. For OTP requests - use phone number (safe access)
  if (req.body && req.body.phoneNumber) {
    return `phone:${req.body.phoneNumber}`;
  }

  // 3. For login requests - use username (safe access)
  if (req.body && req.body.username) {
    return `username:${req.body.username}`;
  }

  // 4. ONLY for unauthenticated general requests - use IP
  // This should be rare in your app
  const fingerprint = crypto
    .createHash("sha256")
    .update(
      [
        req.ip,
        req.get("User-Agent") || "",
        req.get("Accept-Language") || "",
        req.get("Accept-Encoding") || "",
      ].join("|")
    )
    .digest("hex")
    .substring(0, 12);

  return `device:${req.ip}-${fingerprint}`;
};

const getLimits = (identifier) => {
  const type = identifier.split(":")[0];

  const limits = {
    user: { windowMs: 15 * 60 * 1000, max: 500 }, // 500 requests per 15 min per authenticated user
    phone: { windowMs: 5 * 60 * 1000, max: 3 }, // 3 OTP per 5 minutes per phone
    username: { windowMs: 15 * 60 * 1000, max: 5 }, // 5 login attempts per 15 minutes per username
    device: { windowMs: 15 * 60 * 1000, max: 50 }, // 50 requests per 15 min per IP (for unauthenticated only)
  };

  return limits[type] || limits.device;
};

// Cache for rate limit data to reduce Redis calls
const rateLimitCache = new Map();
const CACHE_TTL = 60000; // 1 minute cache

const rateLimiter = async (req, res, next) => {
  try {
    const identifier = getIdentifier(req);
    const limits = getLimits(identifier);

    const now = Date.now();
    const window = Math.floor(now / limits.windowMs);
    const redisKey = `rate_limit:${identifier}:${window}`;
    const cacheKey = `${identifier}:${window}`;

    // Check in-memory cache first (super fast)
    const cached = rateLimitCache.get(cacheKey);
    if (cached && now - cached.timestamp < CACHE_TTL) {
      if (cached.count >= limits.max) {
        return res.status(429).json({
          error: `Too many ${
            identifier.split(":")[0]
          } requests. Please try again later.`,
          type: identifier.split(":")[0],
          limit: limits.max,
          retryAfter: Math.ceil(limits.windowMs / 1000),
        });
      }

      cached.count++;

      res.set({
        "X-RateLimit-Type": identifier.split(":")[0],
        "X-RateLimit-Limit": limits.max,
        "X-RateLimit-Remaining": Math.max(0, limits.max - cached.count),
      });

      return next();
    }

    // Cache miss - check Redis
    const current = await redis.incr(redisKey);

    // Set expiry only on first increment
    if (current === 1) {
      await redis.expire(redisKey, Math.ceil(limits.windowMs / 1000));
    }

    // Update in-memory cache
    rateLimitCache.set(cacheKey, {
      count: current,
      timestamp: now,
    });

    // Clean old cache entries periodically
    if (rateLimitCache.size > 1000) {
      const cutoff = now - CACHE_TTL;
      for (const [key, value] of rateLimitCache.entries()) {
        if (value.timestamp < cutoff) {
          rateLimitCache.delete(key);
        }
      }
    }

    if (current > limits.max) {
      const type = identifier.split(":")[0];

      // Log suspicious activity for security monitoring
      if (current > limits.max * 2) {
        console.warn(
          `🚨 Excessive requests from ${type}: ${identifier} (${current}/${limits.max})`
        );
      }

      return res.status(429).json({
        error: `Too many ${type} requests. Please try again later.`,
        type: type,
        limit: limits.max,
        retryAfter: Math.ceil(limits.windowMs / 1000),
      });
    }

    // Set response headers
    res.set({
      "X-RateLimit-Type": identifier.split(":")[0],
      "X-RateLimit-Limit": limits.max,
      "X-RateLimit-Remaining": Math.max(0, limits.max - current),
    });

    next();
  } catch (error) {
    console.error("Rate limiter error:", error);
    next(); // Fail open if Redis is down
  }
};

// Clean up cache periodically
setInterval(() => {
  const now = Date.now();
  const cutoff = now - CACHE_TTL;
  let cleaned = 0;

  for (const [key, value] of rateLimitCache.entries()) {
    if (value.timestamp < cutoff) {
      rateLimitCache.delete(key);
      cleaned++;
    }
  }

  if (cleaned > 0) {
    console.log(`🧹 Cleaned ${cleaned} expired rate limit cache entries`);
  }
}, 5 * 60 * 1000); // Clean every 5 minutes

module.exports = rateLimiter;
