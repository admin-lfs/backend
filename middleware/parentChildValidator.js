const supabase = require("../config/supabase");

const parentChildValidator = async (req, res, next) => {
  try {
    // Get childId from either body (POST) or query (GET)
    const { childId } = req.body || req.query;

    if (!childId) {
      return res.status(400).json({
        success: false,
        message: "Child ID is required",
      });
    }

    const parentId = req.user.id;

    // Validate parent-child relationship and get child's org_id
    const { data: childData, error: childError } = await supabase
      .from("users")
      .select("id, parent_id, org_id")
      .eq("id", childId)
      .eq("parent_id", parentId)
      .single();

    if (childError || !childData) {
      return res.status(403).json({
        success: false,
        message: "Invalid child ID or access denied",
      });
    }

    // Add validated child data to request for use in route handlers
    req.validatedChild = {
      childId: childData.id, // Use 'childId' to match what the route expects
      orgId: childData.org_id,
    };
    next();
  } catch (error) {
    console.error("Parent-child validation error:", error);
    res.status(500).json({
      success: false,
      message: "Internal server error",
    });
  }
};

module.exports = parentChildValidator;
