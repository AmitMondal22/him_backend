import { DataTypes } from "sequelize";
import { sequelize } from "../config/database.js";

// ==================== MODELS ====================

// 1. User
export const User = sequelize.define("User", {
  id: {
    type: DataTypes.UUID,
    defaultValue: DataTypes.UUIDV4,
    primaryKey: true,
  },
  email: {
    type: DataTypes.STRING,
    allowNull: false,
    unique: true,
  },
  password: {
    type: DataTypes.STRING,
    allowNull: false,
  },
  full_name: {
    type: DataTypes.STRING,
  },
  phone: {
    type: DataTypes.STRING,
  },
  active: {
    type: DataTypes.BOOLEAN,
    defaultValue: true,
  },
  last_login_at: {
    type: DataTypes.DATE,
  },
}, {
  tableName: "users",
  timestamps: true,
});

// 2. Organization
export const Organization = sequelize.define("Organization", {
  id: {
    type: DataTypes.UUID,
    defaultValue: DataTypes.UUIDV4,
    primaryKey: true,
  },
  name: {
    type: DataTypes.STRING,
    allowNull: false,
  },
}, {
  tableName: "organizations",
  timestamps: true,
});

// 3. Customer
export const Customer = sequelize.define("Customer", {
  id: {
    type: DataTypes.UUID,
    defaultValue: DataTypes.UUIDV4,
    primaryKey: true,
  },
  name: {
    type: DataTypes.STRING,
    allowNull: false,
  },
  contact_email: {
    type: DataTypes.STRING,
  },
  contact_phone: {
    type: DataTypes.STRING,
  },
  active: {
    type: DataTypes.BOOLEAN,
    defaultValue: true,
  },
}, {
  tableName: "customers",
  timestamps: true,
});

// 4. UserRole
export const UserRole = sequelize.define("UserRole", {
  id: {
    type: DataTypes.UUID,
    defaultValue: DataTypes.UUIDV4,
    primaryKey: true,
  },
  role: {
    type: DataTypes.ENUM("super_admin", "customer_admin", "engineer", "operator", "viewer"),
    allowNull: false,
  },
}, {
  tableName: "user_roles",
  timestamps: true,
});

// 5. Site
export const Site = sequelize.define("Site", {
  id: {
    type: DataTypes.UUID,
    defaultValue: DataTypes.UUIDV4,
    primaryKey: true,
  },
  name: {
    type: DataTypes.STRING,
    allowNull: false,
  },
  address: {
    type: DataTypes.STRING,
  },
  latitude: {
    type: DataTypes.DECIMAL(10, 6),
  },
  longitude: {
    type: DataTypes.DECIMAL(10, 6),
  },
  active: {
    type: DataTypes.BOOLEAN,
    defaultValue: true,
  },
}, {
  tableName: "sites",
  timestamps: true,
});

// 6. Asset
export const Asset = sequelize.define("Asset", {
  id: {
    type: DataTypes.UUID,
    defaultValue: DataTypes.UUIDV4,
    primaryKey: true,
  },
  name: {
    type: DataTypes.STRING,
    allowNull: false,
  },
  vehicle_number: {
    type: DataTypes.STRING,
  },
  kind: {
    type: DataTypes.STRING,
    defaultValue: "vehicle",
  },
  active: {
    type: DataTypes.BOOLEAN,
    defaultValue: true,
  },
}, {
  tableName: "assets",
  timestamps: true,
});

// 7. Device
export const Device = sequelize.define("Device", {
  id: {
    type: DataTypes.UUID,
    defaultValue: DataTypes.UUIDV4,
    primaryKey: true,
  },
  device_id: {
    type: DataTypes.STRING,
    allowNull: false,
    unique: true,
  },
  imei: {
    type: DataTypes.STRING,
  },
  name: {
    type: DataTypes.STRING,
    allowNull: false,
  },
  sensor_type: {
    type: DataTypes.STRING,
    defaultValue: "MAX31856",
  },
  thermocouple_type: {
    type: DataTypes.STRING,
    defaultValue: "K",
  },
  low_threshold: {
    type: DataTypes.DECIMAL(5, 2),
    defaultValue: 2.0,
  },
  high_threshold: {
    type: DataTypes.DECIMAL(5, 2),
    defaultValue: 8.0,
  },
  upload_interval_s: {
    type: DataTypes.INTEGER,
    defaultValue: 60,
  },
  alarm_enabled: {
    type: DataTypes.BOOLEAN,
    defaultValue: true,
  },
  active: {
    type: DataTypes.BOOLEAN,
    defaultValue: true,
  },
  ingest_token: {
    type: DataTypes.STRING,
    defaultValue: () => crypto.randomUUID().replace(/-/g, ""),
  },
  installed_at: {
    type: DataTypes.DATE,
  },
}, {
  tableName: "devices",
  timestamps: true,
});

// 8. DeviceStatus
export const DeviceStatus = sequelize.define("DeviceStatus", {
  device_id: {
    type: DataTypes.UUID,
    primaryKey: true,
  },
  temperature_c: {
    type: DataTypes.DECIMAL(5, 2),
  },
  latitude: {
    type: DataTypes.DECIMAL(10, 6),
  },
  longitude: {
    type: DataTypes.DECIMAL(10, 6),
  },
  speed_knots: {
    type: DataTypes.DECIMAL(5, 2),
  },
  course_deg: {
    type: DataTypes.DECIMAL(5, 2),
    defaultValue: 0.0,
  },
  gps_valid: {
    type: DataTypes.BOOLEAN,
  },
  satellites: {
    type: DataTypes.INTEGER,
  },
  firmware_version: {
    type: DataTypes.STRING,
  },
  config_version: {
    type: DataTypes.STRING,
  },
  connection_state: {
    type: DataTypes.ENUM("online", "delayed", "offline", "unknown"),
    defaultValue: "unknown",
  },
  last_seen_at: {
    type: DataTypes.DATE,
  },
  last_startup_at: {
    type: DataTypes.DATE,
  },
}, {
  tableName: "device_status",
  timestamps: true,
  updatedAt: "updated_at",
  createdAt: false,
});

// 10. Alarm
export const Alarm = sequelize.define("Alarm", {
  id: {
    type: DataTypes.UUID,
    defaultValue: DataTypes.UUIDV4,
    primaryKey: true,
  },
  alarm_type: {
    type: DataTypes.ENUM(
      "high_temp", "low_temp", "sensor_fault", "thermocouple_open", "sd_failure",
      "device_offline", "weak_signal", "gps_unavailable", "config_mismatch",
      "firmware_mismatch", "excessive_speed", "device_restart", "upload_failure"
    ),
    allowNull: false,
  },
  severity: {
    type: DataTypes.ENUM("critical", "high", "medium", "low", "info"),
    defaultValue: "medium",
  },
  active: {
    type: DataTypes.BOOLEAN,
    defaultValue: true,
  },
  first_occurred_at: {
    type: DataTypes.DATE,
    defaultValue: DataTypes.NOW,
  },
  last_occurred_at: {
    type: DataTypes.DATE,
    defaultValue: DataTypes.NOW,
  },
  occurrences: {
    type: DataTypes.INTEGER,
    defaultValue: 1,
  },
  value: {
    type: DataTypes.DECIMAL(5, 2),
  },
  message: {
    type: DataTypes.TEXT,
  },
  acknowledged_at: {
    type: DataTypes.DATE,
  },
  cleared_at: {
    type: DataTypes.DATE,
  },
}, {
  tableName: "alarms",
  timestamps: true,
});

// 11. NotificationRule
export const NotificationRule = sequelize.define("NotificationRule", {
  id: {
    type: DataTypes.UUID,
    defaultValue: DataTypes.UUIDV4,
    primaryKey: true,
  },
  name: {
    type: DataTypes.STRING,
    allowNull: false,
  },
  device_ids: {
    type: DataTypes.JSON,
    defaultValue: [],
  },
  emails: {
    type: DataTypes.TEXT,
    allowNull: false,
    defaultValue: "",
  },
  alarm_types: {
    type: DataTypes.JSON,
  },
  min_severity: {
    type: DataTypes.STRING,
    defaultValue: "medium",
  },
  cooldown_minutes: {
    type: DataTypes.INTEGER,
    defaultValue: 30,
  },
  last_email_sent_at: {
    type: DataTypes.DATE,
    allowNull: true,
  },
  active: {
    type: DataTypes.BOOLEAN,
    defaultValue: true,
  },
  created_at: {
    type: DataTypes.DATE,
    defaultValue: DataTypes.NOW,
  },
}, {
  tableName: "notification_rules",
  timestamps: true,
});

// ==================== ASSOCIATIONS ====================

// Customer belong to Organization
Customer.belongsTo(Organization, { foreignKey: "organization_id", onDelete: "SET NULL" });
Organization.hasMany(Customer, { foreignKey: "organization_id" });

// UserRole belongs to User and Customer
UserRole.belongsTo(User, { foreignKey: "user_id", onDelete: "CASCADE" });
User.hasMany(UserRole, { foreignKey: "user_id" });
UserRole.belongsTo(Customer, { foreignKey: "customer_id", onDelete: "CASCADE" });
Customer.hasMany(UserRole, { foreignKey: "customer_id" });

// Site belongs to Customer
Site.belongsTo(Customer, { foreignKey: "customer_id", onDelete: "CASCADE" });
Customer.hasMany(Site, { foreignKey: "customer_id" });

// Asset belongs to Customer and Site
Asset.belongsTo(Customer, { foreignKey: "customer_id", onDelete: "CASCADE" });
Customer.hasMany(Asset, { foreignKey: "customer_id" });
Asset.belongsTo(Site, { foreignKey: "site_id", onDelete: "SET NULL" });
Site.hasMany(Asset, { foreignKey: "site_id" });

// Device belongs to Customer, Site, Asset
Device.belongsTo(Customer, { foreignKey: "customer_id", onDelete: "CASCADE" });
Customer.hasMany(Device, { foreignKey: "customer_id" });
Device.belongsTo(Site, { foreignKey: "site_id", onDelete: "SET NULL" });
Site.hasMany(Device, { foreignKey: "site_id" });
Device.belongsTo(Asset, { foreignKey: "asset_id", onDelete: "SET NULL" });
Asset.hasMany(Device, { foreignKey: "asset_id" });

// DeviceStatus (1-to-1 with Device)
DeviceStatus.belongsTo(Device, { foreignKey: "device_id", onDelete: "CASCADE" });
Device.hasOne(DeviceStatus, { foreignKey: "device_id" });
DeviceStatus.belongsTo(Customer, { foreignKey: "customer_id", onDelete: "CASCADE" });

// Alarm belongs to Device and Customer
Alarm.belongsTo(Device, { foreignKey: "device_id", onDelete: "CASCADE" });
Device.hasMany(Alarm, { foreignKey: "device_id" });
Alarm.belongsTo(Customer, { foreignKey: "customer_id", onDelete: "CASCADE" });

// Acknowledge mappings
Alarm.belongsTo(User, { as: "AcknowledgedBy", foreignKey: "acknowledged_by", onDelete: "SET NULL" });
Alarm.belongsTo(User, { as: "AssignedTo", foreignKey: "assigned_to", onDelete: "SET NULL" });

// NotificationRule belongs to Customer
NotificationRule.belongsTo(Customer, { foreignKey: "customer_id", onDelete: "CASCADE" });
Customer.hasMany(NotificationRule, { foreignKey: "customer_id" });

