import { signup, signin, getCurrentUser, changePassword } from "../controllers/authController.js";
import { 
  getDashboardSummary, getDevices, getDeviceById, createDevice, updateDevice, deleteDevice,
  getDeviceStatuses, getDeviceStatus, getTelemetry, getAlarms, updateAlarm,
  getSites, createSite, updateSite, deleteSite,
  getAssets, createAsset, updateAsset, deleteAsset,
  getCustomers, getCustomerById, createCustomer, updateCustomer, deleteCustomer, getUserRoles, seedDemo,
  getProfiles, getProfileById, updateProfile, deleteProfile,
  getUserRolesAll, createUserRole, deleteUserRole,
  getNotificationRules, createNotificationRule, updateNotificationRule, deleteNotificationRule
} from "../controllers/dataController.js";
import { requireAuth } from "../middlewares/authMiddleware.js";
import { 
  signupSchema, signinSchema, deviceSchema, siteSchema, assetSchema, customerSchema 
} from "../validation/schemas.js";
import { sendTestEmail } from "../services/emailService.js";

// Validation helper hook
const validate = (schema) => async (request, reply) => {
  const { error } = schema.validate(request.body);
  if (error) {
    reply.status(400).send({ error: error.details[0].message });
    return;
  }
};

export default async function apiRoutes(fastify, options) {
  // Public Routes
  fastify.post("/auth/register", { preHandler: validate(signupSchema) }, signup);
  fastify.post("/auth/login", { preHandler: validate(signinSchema) }, signin);

  // Protected Routes Group
  fastify.register(async function (protectedFastify) {
    // Register requireAuth hook for this subgroup of routes
    protectedFastify.addHook("preHandler", requireAuth);

    protectedFastify.get("/auth/me", getCurrentUser);
    protectedFastify.post("/seed", seedDemo);
    protectedFastify.get("/dashboard/summary", getDashboardSummary);

    // Devices
    protectedFastify.get("/devices", getDevices);
    protectedFastify.get("/devices/:id", getDeviceById);
    protectedFastify.post("/devices", { preHandler: validate(deviceSchema) }, createDevice);
    protectedFastify.put("/devices/:id", { preHandler: validate(deviceSchema.fork(["device_id", "name", "customer_id"], (s) => s.optional())) }, updateDevice);
    protectedFastify.delete("/devices/:id", deleteDevice);

    // Statuses
    protectedFastify.get("/device-statuses", getDeviceStatuses);
    protectedFastify.get("/devices/:id/status", getDeviceStatus);

    // Telemetry
    protectedFastify.get("/telemetry", getTelemetry);

    // Alarms
    protectedFastify.get("/alarms", getAlarms);
    protectedFastify.put("/alarms/:id", updateAlarm);

    // Sites
    protectedFastify.get("/sites", getSites);
    protectedFastify.post("/sites", { preHandler: validate(siteSchema) }, createSite);
    protectedFastify.put("/sites/:id", { preHandler: validate(siteSchema.fork(["name", "customer_id"], (s) => s.optional())) }, updateSite);
    protectedFastify.delete("/sites/:id", deleteSite);

    // Assets
    protectedFastify.get("/assets", getAssets);
    protectedFastify.post("/assets", { preHandler: validate(assetSchema) }, createAsset);
    protectedFastify.put("/assets/:id", { preHandler: validate(assetSchema.fork(["name", "customer_id"], (s) => s.optional())) }, updateAsset);
    protectedFastify.delete("/assets/:id", deleteAsset);

    // Customers
    protectedFastify.get("/customers", getCustomers);
    protectedFastify.get("/customers/:id", getCustomerById);
    protectedFastify.post("/customers", { preHandler: validate(customerSchema) }, createCustomer);
    protectedFastify.put("/customers/:id", { preHandler: validate(customerSchema.fork(["name"], (s) => s.optional())) }, updateCustomer);
    protectedFastify.delete("/customers/:id", deleteCustomer);

    // User roles
    protectedFastify.get("/roles", getUserRoles);

    // Profiles CRUD
    protectedFastify.get("/profiles", getProfiles);
    protectedFastify.get("/profiles/:id", getProfileById);
    protectedFastify.put("/profiles/:id", updateProfile);
    protectedFastify.delete("/profiles/:id", deleteProfile);

    // User Roles CRUD
    protectedFastify.get("/user_roles", getUserRolesAll);
    protectedFastify.post("/user_roles", createUserRole);
    protectedFastify.delete("/user_roles/:id", deleteUserRole);

    // Security
    protectedFastify.post("/auth/change-password", changePassword);

    // Notification Rules
    protectedFastify.get("/notification_rules", getNotificationRules);
    protectedFastify.post("/notification_rules", createNotificationRule);
    protectedFastify.put("/notification_rules/:id", updateNotificationRule);
    protectedFastify.delete("/notification_rules/:id", deleteNotificationRule);

    // Test Email
    protectedFastify.post("/notification_rules/:id/test-email", async (request, reply) => {
      try {
        const { NotificationRule } = await import("../models/index.js");
        const rule = await NotificationRule.findByPk(request.params.id);
        if (!rule) return reply.status(404).send({ error: "Rule not found" });
        const emails = (rule.emails || "").split(/[,;\s]+/).map(e => e.trim()).filter(e => e && e.includes("@"));
        if (emails.length === 0) return reply.status(400).send({ error: "No valid emails configured on this rule" });
        const sent = await sendTestEmail(emails);
        if (sent) reply.status(200).send({ message: `Test email sent to ${emails.join(", ")}` });
        else reply.status(500).send({ error: "Failed to send test email. Check SMTP settings in .env" });
      } catch (err) {
        console.error("Test email error:", err);
        reply.status(500).send({ error: err.message || "Failed to send test email" });
      }
    });
  });
}
