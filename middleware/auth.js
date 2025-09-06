const { verifyToken } = require("../utils/jwt");
const supabase = require("../config/supabase");
const redis = require("../config/redis");

const authenticateToken = async (req, res, next) => {
  try {
    let decoded;

    // DEFENSIVE CHECK: Did rate limiter already verify the token?
    if (req.tokenVerified && req.decodedToken) {
      // ✅ Rate limiter already verified - reuse the token (fast path)
      decoded = req.decodedToken;
      console.log("🚀 Reusing verified token from rate limiter");
    } else {
      // ❌ Rate limiter didn't run or verification failed - verify ourselves (safe fallback)
      const authHeader = req.headers["authorization"];
      const token = authHeader && authHeader.split(" ")[1];

      if (!token) {
        return res.status(401).json({ error: "Access token required" });
      }

      decoded = verifyToken(token); // Verify token ourselves
      console.log(
        "🔍 Verifying token in auth middleware (rate limiter didn't verify)"
      );
    }

    const userCacheKey = `user_auth:${decoded.userId}`;

    // Try Redis cache first
    try {
      const cachedUser = await redis.get(userCacheKey);
      if (cachedUser) {
        const user = JSON.parse(cachedUser);
        if (!user.is_active) {
          return res.status(401).json({ error: "Account deactivated" });
        }
        req.user = user;
        return next();
      }
    } catch (redisError) {
      console.warn("Redis cache read error:", redisError);
    }

    // Cache miss - fetch from database
    const { data: user, error } = await supabase
      .from("users")
      .select("id, role, is_active")
      .eq("id", decoded.userId)
      .single();

    if (error || !user || !user.is_active) {
      return res.status(401).json({ error: "Invalid or expired token" });
    }

    // Cache user data permanently
    try {
      await redis.set(userCacheKey, JSON.stringify(user));
    } catch (redisError) {
      console.warn("Redis cache write error:", redisError);
    }

    req.user = user;
    next();
  } catch (error) {
    console.error("Auth middleware error:", error);
    return res.status(401).json({ error: "Invalid token" });
  }
};

module.exports = {
  authenticateToken,
};
