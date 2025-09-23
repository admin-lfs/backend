const express = require("express");
const router = express.Router();
const { authenticateToken } = require("../middleware/auth");
const supabase = require("../config/supabase");

// Get all exams for a group
router.get("/:groupId/exams", authenticateToken, async (req, res) => {
  try {
    const { groupId } = req.params;
    const { page = 1, limit = 20 } = req.query;
    const offset = (page - 1) * limit;

    // Check if user has access to this group
    const { data: userGroup, error: userGroupError } = await supabase
      .from("user_groups")
      .select("id")
      .eq("user_id", req.user.id)
      .eq("group_id", groupId)
      .eq("is_active", true)
      .single();

    if (userGroupError || !userGroup) {
      return res.status(403).json({
        success: false,
        message: "Access denied to this group",
      });
    }

    const { data: exams, error } = await supabase
      .from("exams")
      .select(
        `
        *,
        created_by_user:users!exams_created_by_fkey(full_name),
        exam_components!inner(*)
      `
      )
      .eq("group_id", groupId)
      .eq("is_active", true)
      .range(offset, offset + limit - 1)
      .order("created_at", { ascending: false });

    if (error) {
      console.error("Error fetching exams:", error);
      return res.status(500).json({
        success: false,
        message: "Error fetching exams",
      });
    }

    res.json({
      success: true,
      exams: exams || [],
      pagination: {
        page: parseInt(page),
        limit: parseInt(limit),
        hasMore: exams.length === parseInt(limit),
      },
    });
  } catch (error) {
    console.error("Error fetching exams:", error);
    res.status(500).json({
      success: false,
      message: "Internal server error",
    });
  }
});

// Create new exam
router.post("/:groupId/exams", authenticateToken, async (req, res) => {
  try {
    const { groupId } = req.params;
    const { exam_name, components, reduction_marks } = req.body;

    // Check if user is a teacher in this group
    const { data: userGroup, error: userGroupError } = await supabase
      .from("user_groups")
      .select("id")
      .eq("user_id", req.user.id)
      .eq("group_id", groupId)
      .eq("member_type", "teacher")
      .eq("is_active", true)
      .single();

    if (userGroupError || !userGroup) {
      return res.status(403).json({
        success: false,
        message: "Only teachers can create exams",
      });
    }

    // Validate components (max 3)
    if (!components || components.length === 0 || components.length > 3) {
      return res.status(400).json({
        success: false,
        message: "Exam must have 1-3 components",
      });
    }

    // Calculate total marks from components
    const totalMarks = components.reduce(
      (sum, comp) => sum + Number(comp.max_marks),
      0
    );

    // Validate reduction_marks if provided
    if (reduction_marks !== null && reduction_marks !== undefined) {
      const reduction = Number(reduction_marks);
      if (isNaN(reduction) || reduction < 0 || reduction > totalMarks) {
        return res.status(400).json({
          success: false,
          message: "Reduction marks must be between 0 and total marks",
        });
      }
    }

    // Create exam
    const { data: exam, error: examError } = await supabase
      .from("exams")
      .insert({
        group_id: groupId,
        exam_name: exam_name,
        created_by: req.user.id,
        reduction_marks: reduction_marks ? Number(reduction_marks) : null,
      })
      .select()
      .single();

    if (examError) {
      console.error("Error creating exam:", examError);
      return res.status(500).json({
        success: false,
        message: "Error creating exam",
      });
    }

    // Create components
    const componentsToInsert = components.map((comp, index) => ({
      exam_id: exam.id,
      component_name: comp.name,
      max_marks: comp.max_marks,
      component_order: index + 1,
    }));

    const { data: examComponents, error: componentsError } = await supabase
      .from("exam_components")
      .insert(componentsToInsert)
      .select();

    if (componentsError) {
      console.error("Error creating exam components:", componentsError);
      return res.status(500).json({
        success: false,
        message: "Error creating exam components",
      });
    }

    res.json({
      success: true,
      exam: {
        ...exam,
        exam_components: examComponents,
        total_marks: totalMarks,
        final_marks: reduction_marks
          ? totalMarks - Number(reduction_marks)
          : totalMarks,
      },
    });
  } catch (error) {
    console.error("Error creating exam:", error);
    res.status(500).json({
      success: false,
      message: "Internal server error",
    });
  }
});

// Get specific exam details
router.get("/:groupId/exams/:examId", authenticateToken, async (req, res) => {
  try {
    const { groupId, examId } = req.params;

    // Check if user has access to this group
    const { data: userGroup, error: userGroupError } = await supabase
      .from("user_groups")
      .select("id")
      .eq("user_id", req.user.id)
      .eq("group_id", groupId)
      .eq("is_active", true)
      .single();

    if (userGroupError || !userGroup) {
      return res.status(403).json({
        success: false,
        message: "Access denied to this group",
      });
    }

    const { data: exam, error } = await supabase
      .from("exams")
      .select(
        `
        *,
        created_by_user:users!exams_created_by_fkey(full_name),
        exam_components!inner(*)
      `
      )
      .eq("id", examId)
      .eq("group_id", groupId)
      .eq("is_active", true)
      .single();

    if (error || !exam) {
      return res.status(404).json({
        success: false,
        message: "Exam not found",
      });
    }

    res.json({
      success: true,
      exam: exam,
    });
  } catch (error) {
    console.error("Error fetching exam details:", error);
    res.status(500).json({
      success: false,
      message: "Internal server error",
    });
  }
});

module.exports = router;
