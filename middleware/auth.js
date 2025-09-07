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

    // Ensure orgId exists in JWT
    if (!decoded.orgId) {
      return res.status(401).json({ error: "Invalid token" });
    }

    const userCacheKey = `user_auth:${decoded.userId}`;

    // Try Redis cache first
    try {
      const cachedUser = await redis.get(userCacheKey);
      if (cachedUser) {
        const userData = JSON.parse(cachedUser);
        if (!userData.is_active) {
          return res.status(401).json({ error: "Account deactivated" });
        }
        req.user = userData.user;
        req.userOrgs = userData.orgs; // Pass multiple orgs
        return next();
      }
    } catch (redisError) {
      console.warn("Redis cache read error:", redisError);
    }

    // Cache miss - fetch ALL user records across organizations
    const { data: userRecords, error } = await supabase
      .from("users")
      .select(
        `
        id, role, is_active, org_id, full_name,
        organizations(id, name)
      `
      )
      .eq("id", decoded.userId)
      .eq("is_active", true);

    if (error || !userRecords || userRecords.length === 0) {
      return res.status(401).json({ error: "Invalid or expired token" });
    }

    // Structure the data
    const primaryUser = userRecords[0];
    const allOrgs = userRecords.map((record) => ({
      org_id: record.org_id,
      org_name: record.organizations.name,
      role: record.role,
      full_name: record.full_name,
    }));

    const userData = {
      user: {
        id: primaryUser.id,
        role: primaryUser.role,
        is_active: primaryUser.is_active,
      },
      orgs: allOrgs,
    };

    // Cache the complete user data
    try {
      await redis.set(userCacheKey, JSON.stringify(userData));
    } catch (redisError) {
      console.warn("Redis cache write error:", redisError);
    }

    req.user = userData.user;
    req.userOrgs = userData.orgs; // Available organizations for this user
    next();
  } catch (error) {
    console.error("Auth middleware error:", error);
    return res.status(401).json({ error: "Invalid token" });
  }
};

module.exports = {
  authenticateToken,
};
