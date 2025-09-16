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

CREATE TABLE announcements (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id INTEGER NOT NULL REFERENCES organizations(id),
  title VARCHAR(255) NOT NULL,
  description TEXT NOT NULL,
  priority VARCHAR(20) DEFAULT 'normal' CHECK (priority IN ('low', 'normal', 'high', 'urgent')),
  is_active BOOLEAN DEFAULT true,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Indexes for performance
CREATE INDEX idx_announcements_org_id ON announcements(org_id);
CREATE INDEX idx_announcements_updated_at ON announcements(updated_at);
CREATE INDEX idx_announcements_org_updated ON announcements(org_id, updated_at);
CREATE INDEX idx_announcements_active ON announcements(is_active);

CREATE TABLE groups (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name VARCHAR(255) NOT NULL,
  description TEXT,
  org_id INTEGER NOT NULL REFERENCES organizations(id),
  archived BOOLEAN DEFAULT false,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE user_groups (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id),
  group_id UUID NOT NULL REFERENCES groups(id),
  archived BOOLEAN DEFAULT false,
  created_at TIMESTAMP DEFAULT NOW(),
  UNIQUE(user_id, group_id)
);

CREATE INDEX idx_groups_org ON groups(org_id);
CREATE INDEX idx_groups_archived ON groups(archived);
CREATE INDEX idx_groups_updated ON groups(updated_at);

-- User Groups indexes
CREATE INDEX idx_user_groups_user ON user_groups(user_id);
CREATE INDEX idx_user_groups_group ON user_groups(group_id);
CREATE INDEX idx_user_groups_archived ON user_groups(archived);

CREATE TABLE messages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  group_id UUID NOT NULL REFERENCES groups(id),
  user_id UUID NOT NULL REFERENCES users(id),
  faculty_name VARCHAR(255) NOT NULL,
  message_content TEXT NOT NULL CHECK (LENGTH(message_content) <= 10000),
  is_contains_link BOOLEAN DEFAULT false,
  is_contains_file BOOLEAN DEFAULT false,
  file_urls JSONB DEFAULT '[]'::jsonb,
  file_names JSONB DEFAULT '[]'::jsonb,
  file_sizes JSONB DEFAULT '[]'::jsonb,
  total_file_size INTEGER DEFAULT 0,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

-- Add indexes for performance
CREATE INDEX idx_messages_group_id ON messages(group_id);
CREATE INDEX idx_messages_user_id ON messages(user_id);
CREATE INDEX idx_messages_created_at ON messages(created_at DESC);
CREATE INDEX idx_messages_contains_link ON messages(is_contains_link) WHERE is_contains_link = true;
CREATE INDEX idx_messages_contains_file ON messages(is_contains_file) WHERE is_contains_file = true;


-- Update messages table to store file paths instead of URLs
ALTER TABLE messages 
ALTER COLUMN file_urls TYPE JSONB USING file_urls::jsonb;

-- Set default values
ALTER TABLE messages 
ALTER COLUMN file_urls SET DEFAULT '[]'::jsonb;

ALTER TABLE messages 
ALTER COLUMN file_names SET DEFAULT '[]'::jsonb;

ALTER TABLE messages 
ALTER COLUMN file_sizes SET DEFAULT '[]'::jsonb;

-- Allow service role to upload files
CREATE POLICY "Allow service role uploads" ON storage.objects
FOR INSERT WITH CHECK (
  bucket_id = 'group-files' 
  AND auth.role() = 'service_role'
);

-- Allow service role to generate signed URLs
CREATE POLICY "Allow service role downloads" ON storage.objects
FOR SELECT USING (
  bucket_id = 'group-files' 
  AND auth.role() = 'service_role'
);