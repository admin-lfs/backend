const { verifyToken } = require("../utils/jwt");
const supabase = require("../config/supabase");
const redis = require("../config/redis");

const authenticateToken = async (req, res, next) => {
  try {
    let decoded;

    // Check if rate limiter already verified token
    if (req.tokenVerified && req.decodedToken) {
      decoded = req.decodedToken;
    } else {
      const authHeader = req.headers["authorization"];
      const token = authHeader && authHeader.split(" ")[1];

      if (!token) {
        return res.status(401).json({ error: "Access token required" });
      }

      decoded = verifyToken(token);
    }

    const userCacheKey = `user_auth:${decoded.userId}`;

    // Try Redis cache first (simple user data only)
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

    // Cache miss - fetch basic user data only
    const { data: user, error } = await supabase
      .from("users")
      .select("id, role, is_active, org_id")
      .eq("id", decoded.userId)
      .eq("is_active", true)
      .single();

    if (error || !user) {
      return res.status(401).json({ error: "Invalid or expired token" });
    }

    // Cache basic user data only
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
