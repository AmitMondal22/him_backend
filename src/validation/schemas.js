import Joi from "joi";

export const signupSchema = Joi.object({
  email: Joi.string().email().required(),
  password: Joi.string().min(8).required(),
  full_name: Joi.string().allow("").optional(),
});

export const signinSchema = Joi.object({
  email: Joi.string().email().required(),
  password: Joi.string().required(),
});

export const deviceSchema = Joi.object({
  device_id: Joi.string().required(),
  name: Joi.string().required(),
  imei: Joi.string().allow("", null).optional(),
  sensor_type: Joi.string().allow("", null).default("MAX31856"),
  thermocouple_type: Joi.string().allow("", null).default("K"),
  latitude: Joi.number().allow(null).optional(),
  longitude: Joi.number().allow(null).optional(),
  low_threshold: Joi.number().allow(null).default(2.0),
  high_threshold: Joi.number().allow(null).default(8.0),
  upload_interval_s: Joi.number().integer().allow(null).default(60),
  alarm_enabled: Joi.boolean().default(true),
  active: Joi.boolean().default(true),
  customer_id: Joi.string().guid({ version: "uuidv4" }).required(),
  site_id: Joi.string().guid({ version: "uuidv4" }).allow(null).optional(),
  asset_id: Joi.string().guid({ version: "uuidv4" }).allow(null).optional(),
});

export const siteSchema = Joi.object({
  name: Joi.string().required(),
  address: Joi.string().allow("").optional(),
  latitude: Joi.number().optional(),
  longitude: Joi.number().optional(),
  customer_id: Joi.string().guid({ version: "uuidv4" }).required(),
});

export const assetSchema = Joi.object({
  name: Joi.string().required(),
  vehicle_number: Joi.string().allow("").optional(),
  kind: Joi.string().default("vehicle"),
  customer_id: Joi.string().guid({ version: "uuidv4" }).required(),
  site_id: Joi.string().guid({ version: "uuidv4" }).allow(null).optional(),
});

export const customerSchema = Joi.object({
  name: Joi.string().required(),
  contact_email: Joi.string().email().allow("").optional(),
  contact_phone: Joi.string().allow("").optional(),
});
