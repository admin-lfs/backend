-- Fees Collection System Database Schema

-- Subjects table (organization-specific)
CREATE TABLE subjects (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id INTEGER NOT NULL REFERENCES organizations(id),
  name VARCHAR(255) NOT NULL,
  description TEXT,
  is_active BOOLEAN DEFAULT true,
  created_at TIMESTAMP DEFAULT NOW(),
  created_by UUID NOT NULL REFERENCES users(id)
);

-- Indexes for subjects
CREATE INDEX idx_subjects_org ON subjects(org_id);
CREATE INDEX idx_subjects_active ON subjects(is_active);
CREATE INDEX idx_subjects_created_by ON subjects(created_by);

-- Fees table (fee configuration per group per subject)
CREATE TABLE fees (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id INTEGER NOT NULL REFERENCES organizations(id),
  group_id UUID NOT NULL REFERENCES groups(id),
  subject_id UUID NOT NULL REFERENCES subjects(id),
  amount DECIMAL(10,2) NOT NULL CHECK (amount >= 0),
  due_date DATE,
  is_active BOOLEAN DEFAULT true,
  created_at TIMESTAMP DEFAULT NOW(),
  created_by UUID NOT NULL REFERENCES users(id),
  updated_at TIMESTAMP DEFAULT NOW(),
  updated_by UUID REFERENCES users(id),
  UNIQUE(group_id, subject_id) -- One fee per group per subject
);

-- Indexes for fees
CREATE INDEX idx_fees_org ON fees(org_id);
CREATE INDEX idx_fees_group ON fees(group_id);
CREATE INDEX idx_fees_subject ON fees(subject_id);
CREATE INDEX idx_fees_active ON fees(is_active);
CREATE INDEX idx_fees_due_date ON fees(due_date);

-- Student fees table (individual student fee assignments)
CREATE TABLE student_fees (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id INTEGER NOT NULL REFERENCES organizations(id),
  student_id UUID NOT NULL REFERENCES users(id),
  fee_id UUID NOT NULL REFERENCES fees(id),
  total_amount DECIMAL(10,2) NOT NULL CHECK (total_amount >= 0),
  paid_amount DECIMAL(10,2) DEFAULT 0 CHECK (paid_amount >= 0),
  pending_amount DECIMAL(10,2) GENERATED ALWAYS AS (total_amount - paid_amount) STORED,
  is_paid BOOLEAN GENERATED ALWAYS AS (paid_amount >= total_amount) STORED,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW(),
  UNIQUE(student_id, fee_id) -- One record per student per fee
);

-- Indexes for student_fees
CREATE INDEX idx_student_fees_org ON student_fees(org_id);
CREATE INDEX idx_student_fees_student ON student_fees(student_id);
CREATE INDEX idx_student_fees_fee ON student_fees(fee_id);
CREATE INDEX idx_student_fees_paid ON student_fees(is_paid);
CREATE INDEX idx_student_fees_pending ON student_fees(pending_amount);

-- Fee payments table (payment history)
CREATE TABLE fee_payments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id INTEGER NOT NULL REFERENCES organizations(id),
  student_id UUID NOT NULL REFERENCES users(id),
  fee_id UUID NOT NULL REFERENCES fees(id),
  amount DECIMAL(10,2) NOT NULL CHECK (amount > 0),
  payment_date TIMESTAMP DEFAULT NOW(),
  payment_method VARCHAR(50) DEFAULT 'cash',
  notes TEXT,
  created_by UUID NOT NULL REFERENCES users(id),
  created_at TIMESTAMP DEFAULT NOW()
);

-- Indexes for fee_payments
CREATE INDEX idx_fee_payments_org ON fee_payments(org_id);
CREATE INDEX idx_fee_payments_student ON fee_payments(student_id);
CREATE INDEX idx_fee_payments_fee ON fee_payments(fee_id);
CREATE INDEX idx_fee_payments_date ON fee_payments(payment_date);
CREATE INDEX idx_fee_payments_created_by ON fee_payments(created_by);

-- Function to update student_fees when payment is made
CREATE OR REPLACE FUNCTION update_student_fees_payment()
RETURNS TRIGGER AS $$
BEGIN
  -- Update the paid_amount in student_fees
  UPDATE student_fees 
  SET 
    paid_amount = (
      SELECT COALESCE(SUM(amount), 0) 
      FROM fee_payments 
      WHERE student_id = NEW.student_id 
      AND fee_id = NEW.fee_id
    ),
    updated_at = NOW()
  WHERE student_id = NEW.student_id 
  AND fee_id = NEW.fee_id;
  
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Trigger to automatically update student_fees when payment is made
CREATE TRIGGER trigger_update_student_fees_payment
  AFTER INSERT ON fee_payments
  FOR EACH ROW
  EXECUTE FUNCTION update_student_fees_payment();

-- Function to create student_fees records when fees are created for a group
CREATE OR REPLACE FUNCTION create_student_fees_for_group()
RETURNS TRIGGER AS $$
BEGIN
  -- Insert student_fees records for all students in the group
  INSERT INTO student_fees (org_id, student_id, fee_id, total_amount)
  SELECT 
    NEW.org_id,
    ug.user_id,
    NEW.id,
    NEW.amount
  FROM user_groups ug
  WHERE ug.group_id = NEW.group_id
  AND ug.member_type = 'student'
  AND ug.is_active = true;
  
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Trigger to automatically create student_fees when fees are created
CREATE TRIGGER trigger_create_student_fees_for_group
  AFTER INSERT ON fees
  FOR EACH ROW
  EXECUTE FUNCTION create_student_fees_for_group();

-- Function to update student_fees when fee amount changes
CREATE OR REPLACE FUNCTION update_student_fees_amount()
RETURNS TRIGGER AS $$
BEGIN
  -- Update the total_amount in student_fees
  UPDATE student_fees 
  SET 
    total_amount = NEW.amount,
    updated_at = NOW()
  WHERE fee_id = NEW.id;
  
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Trigger to automatically update student_fees when fee amount changes
CREATE TRIGGER trigger_update_student_fees_amount
  AFTER UPDATE OF amount ON fees
  FOR EACH ROW
  EXECUTE FUNCTION update_student_fees_amount();
