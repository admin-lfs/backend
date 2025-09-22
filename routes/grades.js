const express = require("express");
const router = express.Router();
const { authenticateToken } = require("../middleware/auth");
const parentChildValidator = require("../middleware/parentChildValidator");
const supabase = require("../config/supabase");
const ExcelJS = require("exceljs");

// Get grades for a group
router.get(
  "/:groupId/grades",
  authenticateToken,
  async (req, res, next) => {
    // Only apply parentChildValidator for parent users
    if (req.user.role === "parent") {
      return parentChildValidator(req, res, next);
    }
    next();
  },
  async (req, res) => {
    try {
      const { groupId } = req.params;
      const userRole = req.user.role;
      const userId = req.user.id;

      let targetUserId = userId;

      // If user is a parent, use validated child
      if (userRole === "parent") {
        targetUserId = req.validatedChild.childId;
      }

      // Check if user has access to this group
      const { data: userGroup, error: userGroupError } = await supabase
        .from("user_groups")
        .select("id, member_type")
        .eq("user_id", targetUserId)
        .eq("group_id", groupId)
        .eq("is_active", true)
        .single();

      if (userGroupError || !userGroup) {
        return res.status(403).json({
          success: false,
          message: "Access denied to this group",
        });
      }

      // For students and parents, only show their own grades
      if (userRole === "student" || userRole === "parent") {
        const { data: grades, error: gradesError } = await supabase
          .from("grades")
          .select(
            `
          *,
          exams!grades_exam_id_fkey(
            id,
            title,
            total_marks,
            exam_components
          )
        `
          )
          .eq("student_id", targetUserId)
          .eq("exams.group_id", groupId)
          .order("created_at", { ascending: false });

        if (gradesError) {
          console.error("Error fetching grades:", gradesError);
          return res.status(500).json({
            success: false,
            message: "Error fetching grades",
          });
        }

        return res.json({
          success: true,
          grades: grades || [],
        });
      }

      // For teachers, show all grades in the group
      if (userRole === "faculty") {
        const { data: grades, error: gradesError } = await supabase
          .from("grades")
          .select(
            `
          *,
          exams!grades_exam_id_fkey(
            id,
            title,
            total_marks,
            exam_components
          ),
          users!grades_student_id_fkey(
            id,
            full_name,
            register_number
          )
        `
          )
          .eq("exams.group_id", groupId)
          .order("created_at", { ascending: false });

        if (gradesError) {
          console.error("Error fetching grades:", gradesError);
          return res.status(500).json({
            success: false,
            message: "Error fetching grades",
          });
        }

        return res.json({
          success: true,
          grades: grades || [],
        });
      }

      return res.status(403).json({
        success: false,
        message: "Invalid user role",
      });
    } catch (error) {
      console.error("Error in get grades:", error);
      res.status(500).json({
        success: false,
        message: "Internal server error",
      });
    }
  }
);

// Add/update grades for students
router.post(
  "/:groupId/exams/:examId/grades",
  authenticateToken,
  async (req, res) => {
    try {
      const { groupId, examId } = req.params;
      const { grades } = req.body;

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
          message: "Only teachers can add grades",
        });
      }

      const gradesToUpsert = grades.map((grade) => ({
        exam_id: examId,
        student_id: grade.student_id,
        component_scores: grade.component_scores,
        total_marks: grade.total_marks,
        added_by: req.user.id,
        updated_at: new Date().toISOString(),
      }));

      const { data: savedGrades, error } = await supabase
        .from("grades")
        .upsert(gradesToUpsert, { onConflict: "exam_id,student_id" })
        .select();

      if (error) {
        console.error("Error saving grades:", error);
        return res.status(500).json({
          success: false,
          message: "Error saving grades",
        });
      }

      res.json({
        success: true,
        message: `Saved grades for ${savedGrades.length} students`,
        grades: savedGrades,
      });
    } catch (error) {
      console.error("Error saving grades:", error);
      res.status(500).json({
        success: false,
        message: "Internal server error",
      });
    }
  }
);

// Get grade statistics
router.get(
  "/:groupId/exams/:examId/statistics",
  authenticateToken,
  async (req, res) => {
    try {
      const { groupId, examId } = req.params;

      // Check access to group
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

      const { data: grades, error } = await supabase
        .from("grades")
        .select("total_marks")
        .eq("exam_id", examId);

      if (error) {
        console.error("Error fetching grade statistics:", error);
        return res.status(500).json({
          success: false,
          message: "Error fetching grade statistics",
        });
      }

      if (!grades || grades.length === 0) {
        return res.json({
          success: true,
          statistics: {
            total_students: 0,
            average: 0,
            highest: 0,
            lowest: 0,
          },
        });
      }

      const marks = grades.map((g) => parseFloat(g.total_marks));
      const statistics = {
        total_students: marks.length,
        average: marks.reduce((sum, mark) => sum + mark, 0) / marks.length,
        highest: Math.max(...marks),
        lowest: Math.min(...marks),
      };

      res.json({
        success: true,
        statistics: statistics,
      });
    } catch (error) {
      console.error("Error calculating grade statistics:", error);
      res.status(500).json({
        success: false,
        message: "Internal server error",
      });
    }
  }
);

// Export grades to Excel
router.get(
  "/:groupId/exams/:examId/export",
  authenticateToken,
  async (req, res) => {
    try {
      const { groupId, examId } = req.params;

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
          message: "Only teachers can export grades",
        });
      }

      // Get exam and grades data
      const { data: exam, error: examError } = await supabase
        .from("exams")
        .select(
          `
        *,
        exam_components!inner(*)
      `
        )
        .eq("id", examId)
        .single();

      const { data: grades, error: gradesError } = await supabase
        .from("grades")
        .select(
          `
        *,
        student:users!grades_student_id_fkey(full_name),
        added_by_user:users!grades_added_by_fkey(full_name)
      `
        )
        .eq("exam_id", examId);

      if (examError || gradesError) {
        return res.status(500).json({
          success: false,
          message: "Error fetching exam data",
        });
      }

      // Create Excel workbook
      const workbook = new ExcelJS.Workbook();
      const worksheet = workbook.addWorksheet(exam.exam_name);

      // Headers
      const headers = ["Student Name"];
      exam.exam_components
        .sort((a, b) => a.component_order - b.component_order)
        .forEach((comp) => headers.push(comp.component_name));
      headers.push("Total", "Added By", "Date Added");

      worksheet.addRow(headers);

      // Data rows
      grades.forEach((grade) => {
        const row = [grade.student.full_name];

        exam.exam_components
          .sort((a, b) => a.component_order - b.component_order)
          .forEach((comp) => {
            row.push(grade.component_scores[comp.id] || "");
          });

        row.push(
          grade.total_marks,
          grade.added_by_user.full_name,
          new Date(grade.added_at).toLocaleDateString()
        );

        worksheet.addRow(row);
      });

      // Set response headers
      res.setHeader(
        "Content-Type",
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
      );
      res.setHeader(
        "Content-Disposition",
        `attachment; filename="${exam.exam_name}_grades.xlsx"`
      );

      // Send file
      await workbook.xlsx.write(res);
      res.end();
    } catch (error) {
      console.error("Error exporting grades:", error);
      res.status(500).json({
        success: false,
        message: "Internal server error",
      });
    }
  }
);

module.exports = router;
