const redis = require("../config/redis");
const supabase = require("../config/supabase");

const parentChildValidator = async (req, res, next) => {
  try {
    const { childId } = req.body;
    const parentId = req.user.id;
    const orgId = req.user.org_id;

    if (!childId || typeof childId !== "string") {
      return res.status(400).json({ error: "Valid child ID is required" });
    }

    // Validate UUID format
    const uuidRegex =
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
    if (!uuidRegex.test(childId)) {
      return res.status(400).json({ error: "Invalid child ID format" });
    }

    const cacheKey = `parent_children:${parentId}:${orgId}`;
    let childrenIds = [];

    try {
      // Try Redis first
      childrenIds = await redis.smembers(cacheKey);
    } catch (redisError) {
      console.error("Redis error:", redisError);
      // Continue without cache - fail gracefully
    }

    if (childrenIds.length === 0) {
      // Cache miss - fetch from database
      const { data: children, error } = await supabase
        .from("users")
        .select("id")
        .eq("parent_id", parentId)
        .eq("org_id", orgId)
        .eq("is_active", true);

      if (error) {
        console.error("Database error:", error);
        return res
          .status(500)
          .json({ error: "Service temporarily unavailable" });
      }

      childrenIds = children.map((child) => child.id);

      // Cache with error handling
      if (childrenIds.length > 0) {
        try {
          await redis.sadd(cacheKey, ...childrenIds);
        } catch (redisError) {
          console.error("Redis cache error:", redisError);
          // Continue without caching
        }
      }
    }

    // Validate child access
    if (!childrenIds.includes(childId)) {
      return res.status(403).json({ error: "Access denied" });
    }

    req.validatedChild = { childId, orgId };
    next();
  } catch (error) {
    console.error("Parent-child validation error:", error);
    res.status(500).json({ error: "Service temporarily unavailable" });
  }
};

module.exports = parentChildValidator;
