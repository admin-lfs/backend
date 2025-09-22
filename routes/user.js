const express = require("express");
const supabase = require("../config/supabase");
const { authenticateToken } = require("../middleware/auth");
const rateLimiter = require("../middleware/rateLimiter");

const router = express.Router();

// Get user profile
router.get("/profile", rateLimiter, authenticateToken, async (req, res) => {
  try {
    const userId = req.user.id;
    const userRole = req.user.role;

    console.log("🔍 Fetching profile for user:", userId, "Role:", userRole);

    if (userRole === "parent") {
      // For parents: Get their details + children
      const { data: userRecord, error } = await supabase
        .from("users")
        .select(
          `
          id, 
          full_name, 
          phone_number, 
          role, 
          org_id,
          created_at,
          organizations(id, name),
          children:users!parent_id(
            id, 
            full_name, 
            phone_number, 
            role, 
            org_id, 
            register_number,
            created_at,
            organizations(name)
          )
        `
        )
        .eq("id", userId)
        .eq("is_active", true)
        .single();

      if (error || !userRecord) {
        console.error("Error fetching parent profile:", error);
        return res.status(500).json({
          success: false,
          message: "Failed to get profile data",
        });
      }

      // Format children data
      const children =
        userRecord.children?.map((child) => ({
          id: child.id,
          full_name: child.full_name,
          phone_number: child.phone_number,
          role: child.role,
          org_id: child.org_id,
          org_name: child.organizations?.name || "Unknown",
          register_number: child.register_number,
          created_at: child.created_at,
        })) || [];

      res.json({
        success: true,
        profile: {
          id: userRecord.id,
          full_name: userRecord.full_name,
          phone_number: userRecord.phone_number,
          role: userRecord.role,
          org_id: userRecord.org_id,
          org_name: userRecord.organizations?.name || "Unknown",
          created_at: userRecord.created_at,
          children: children,
          children_count: children.length,
        },
      });
    } else {
      // For faculty/students: Get only their details
      const { data: userRecord, error } = await supabase
        .from("users")
        .select(
          `
          id, 
          full_name, 
          phone_number, 
          role, 
          org_id,
          register_number,
          created_at,
          organizations(id, name)
        `
        )
        .eq("id", userId)
        .eq("is_active", true)
        .single();

      if (error || !userRecord) {
        console.error("Error fetching user profile:", error);
        return res.status(500).json({
          success: false,
          message: "Failed to get profile data",
        });
      }

      res.json({
        success: true,
        profile: {
          id: userRecord.id,
          full_name: userRecord.full_name,
          phone_number: userRecord.phone_number,
          role: userRecord.role,
          org_id: userRecord.org_id,
          org_name: userRecord.organizations?.name || "Unknown",
          register_number: userRecord.register_number,
          created_at: userRecord.created_at,
        },
      });
    }
  } catch (error) {
    console.error("Profile fetch error:", error);
    res.status(500).json({
      success: false,
      message: "Internal server error",
    });
  }
});

// Get user contexts (self + children for parents)
router.get("/contexts", authenticateToken, async (req, res) => {
  try {
    // Only parents should call this endpoint
    if (req.user.role !== "parent") {
      return res
        .status(403)
        .json({ error: "This endpoint is for parents only" });
    }

    console.log("🔍 Fetching contexts for parent:", req.user.id);

    // Fetch user and their children
    const { data: userRecord, error } = await supabase
      .from("users")
      .select(
        `
        id, role, org_id, full_name, phone_number,
        organizations(id, name),
        children:users!parent_id(id, full_name, role, org_id, phone_number, organizations(name))
      `
      )
      .eq("id", req.user.id)
      .eq("is_active", true)
      .single();

    if (error || !userRecord) {
      return res.status(500).json({ error: "Failed to get user data" });
    }

    let contexts = [];

    if (userRecord.role === "parent") {
      // For parents: Only send children, NOT the parent
      if (userRecord.children && userRecord.children.length > 0) {
        contexts = userRecord.children.map((child) => ({
          student_id: child.id,
          org_id: child.org_id,
          org_name: child.organizations.name,
          full_name: child.full_name,
          role: child.role,
        }));
      }
    } else {
      // For students/faculty: Send their own context
      contexts = [
        {
          student_id: userRecord.id,
          org_id: userRecord.org_id,
          org_name: userRecord.organizations.name,
          full_name: userRecord.full_name,
          role: userRecord.role,
        },
      ];
    }

    console.log("✅ Returning contexts:", contexts.length);

    res.json({ contexts });
  } catch (error) {
    console.error("User contexts error:", error);
    res.status(500).json({ error: "Failed to get user contexts" });
  }
});

module.exports = router;
