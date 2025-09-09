DROP TABLE IF EXISTS users CASCADE;
DROP TABLE IF EXISTS organizations CASCADE;

-- Organizations table
CREATE TABLE organizations (
  id INTEGER PRIMARY KEY CHECK (id >= 100000 AND id <= 999999),
  name VARCHAR(255) NOT NULL,
  is_active BOOLEAN DEFAULT true,
  created_at TIMESTAMP DEFAULT NOW()
);

-- Users table with parent_id self-reference
CREATE TABLE users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id INTEGER NOT NULL REFERENCES organizations(id),
  parent_id UUID REFERENCES users(id), -- Self-reference for parent-child
  phone_number VARCHAR(15),
  username VARCHAR(50),
  password_hash VARCHAR(255),
  full_name VARCHAR(255) NOT NULL,
  role VARCHAR(20) NOT NULL CHECK (role IN ('student', 'parent', 'faculty', 'admin')),
  is_active BOOLEAN DEFAULT true,
  failed_attempts INTEGER DEFAULT 0,
  locked_until TIMESTAMP,
  created_at TIMESTAMP DEFAULT NOW()
);

-- Indexes for performance
CREATE INDEX idx_org_name ON organizations(name);
CREATE INDEX idx_org_active ON organizations(is_active);
CREATE INDEX idx_users_org ON users(org_id);
CREATE INDEX idx_users_parent ON users(parent_id); -- For finding children
CREATE INDEX idx_users_phone ON users(phone_number);
CREATE INDEX idx_users_username ON users(username);
CREATE INDEX idx_users_role ON users(role);
CREATE INDEX idx_users_active ON users(is_active);
CREATE INDEX idx_users_org_phone ON users(org_id, phone_number);

