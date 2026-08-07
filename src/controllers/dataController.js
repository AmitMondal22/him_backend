import { 
  Device, DeviceStatus, Alarm, Site, Asset, Customer, UserRole, Organization, User, NotificationRule 
} from "../models/index.js";
import { Op } from "sequelize";
import { queryApi, bucket } from "../config/influx.js";
import { broadcastRealtimeEvent } from "../../server.js";

const getConnectionState = (lastSeenAt) => {
  if (!lastSeenAt) return "offline";
  const diffMs = Date.now() - new Date(lastSeenAt).getTime();
  if (diffMs < 5 * 60 * 1000) return "online"; // Under 5 minutes = online
  return "offline"; // 5 minutes or older = offline
};

// GET dashboard summary
export const getDashboardSummary = async (request, reply) => {
  try {
    const devicesCount = await Device.count();
    const sitesCount = await Site.count({ where: { active: true } });
    const assetsCount = await Asset.count({ where: { active: true } });
    const customersCount = await Customer.count({ where: { active: true } });

    const statuses = await DeviceStatus.findAll({
      include: [{ model: Device, attributes: ["id", "device_id", "name"] }]
    });
    const formattedStatuses = statuses.map((status) => {
      const raw = status.toJSON();
      raw.connection_state = getConnectionState(raw.last_seen_at);
      raw.device_code = raw.Device?.device_id || raw.device_id;
      raw.devices = {
        device_id: raw.Device?.device_id || raw.device_id,
        name: raw.Device?.name || "Device"
      };
      return raw;
    });

    const activeAlarms = await Alarm.findAll({
      where: { active: true },
      include: [{ model: Device, attributes: ["id", "device_id", "name"] }]
    });

    const recentAlarms = [...activeAlarms]
      .sort((a, b) => new Date(b.last_occurred_at) - new Date(a.last_occurred_at))
      .slice(0, 6)
      .map((alarm) => {
        const raw = alarm.toJSON();
        raw.device_code = raw.Device?.device_id || raw.device_id;
        raw.devices = {
          id: raw.Device?.id || raw.device_id,
          device_id: raw.Device?.device_id || raw.device_id,
          name: raw.Device?.name || "Device"
        };
        return raw;
      });

    const devicesInAlarm = new Set(activeAlarms.map((a) => a.device_id));
    const devicesInFault = new Set(
      activeAlarms.filter((a) => a.alarm_type === "sensor_fault").map((a) => a.device_id)
    );

    const totals = {
      devices: devicesCount,
      online: formattedStatuses.filter((s) => s.connection_state === "online").length,
      offline: formattedStatuses.filter((s) => s.connection_state === "offline").length,
      delayed: formattedStatuses.filter((s) => s.connection_state === "delayed").length,
      inAlarm: devicesInAlarm.size,
      sensorFault: devicesInFault.size,
      noGps: formattedStatuses.filter((s) => !s.latitude || !s.longitude || Number(s.latitude) === 0).length,
      firmwareOld: formattedStatuses.filter((s) => s.firmware_version && s.firmware_version !== "2.0.5").length,
      sites: sitesCount,
      assets: assetsCount,
      customers: customersCount,
    };

    reply.status(200).send({ totals, statuses: formattedStatuses, alarms: recentAlarms });
  } catch (error) {
    console.error("Summary error:", error);
    reply.status(500).send({ error: "Internal server error" });
  }
};

// CRUD: Devices
export const getDevices = async (request, reply) => {
  try {
    const devices = await Device.findAll({
      include: [
        { model: Customer, attributes: ["name"] },
        { model: Site, attributes: ["name"] },
        { model: Asset, attributes: ["name", "vehicle_number"] },
      ],
      order: [["device_id", "ASC"]]
    });
    reply.status(200).send(devices);
  } catch (error) {
    console.error("Get devices error:", error);
    reply.status(500).send({ error: "Failed to fetch devices" });
  }
};

export const getDeviceById = async (request, reply) => {
  try {
    const isUUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(request.params.id);
    let device;
    if (isUUID) {
      device = await Device.findByPk(request.params.id, {
        include: [
          { model: Customer, attributes: ["name"] },
          { model: Site, attributes: ["name", "latitude", "longitude"] },
          { model: Asset, attributes: ["name", "vehicle_number"] },
        ]
      });
    } else {
      device = await Device.findOne({
        where: { device_id: request.params.id },
        include: [
          { model: Customer, attributes: ["name"] },
          { model: Site, attributes: ["name", "latitude", "longitude"] },
          { model: Asset, attributes: ["name", "vehicle_number"] },
        ]
      });
    }

    if (!device) {
      reply.status(404).send({ error: "Device not found" });
      return;
    }
    reply.status(200).send(device);
  } catch (error) {
    console.error("Get device error:", error);
    reply.status(500).send({ error: "Internal server error" });
  }
};

export const createDevice = async (request, reply) => {
  try {
    const device = await Device.create(request.body);
    
    await DeviceStatus.create({
      device_id: device.id,
      customer_id: device.customer_id,
      temperature_c: null,
      latitude: request.body.latitude != null ? Number(request.body.latitude) : null,
      longitude: request.body.longitude != null ? Number(request.body.longitude) : null,
      speed_knots: 0,
      gps_valid: false,
      satellites: 0,
      firmware_version: null,
      config_version: null,
      connection_state: "unknown",
      last_seen_at: null,
      last_startup_at: null,
    });

    reply.status(201).send(device);
  } catch (error) {
    console.error("Create device error:", error);
    const msg = error.name === "SequelizeUniqueConstraintError"
      ? `Device with ID '${request.body.device_id}' already exists`
      : error.message || "Failed to create device";
    reply.status(400).send({ error: msg });
  }
};

export const updateDevice = async (request, reply) => {
  try {
    const device = await Device.findByPk(request.params.id);
    if (!device) {
      reply.status(404).send({ error: "Device not found" });
      return;
    }
    await device.update(request.body);
    let updatedStatus = await DeviceStatus.findOne({ where: { device_id: device.id } });
    if (request.body.latitude != null || request.body.longitude != null || request.body.temperature_c != null) {
      const statusUpdate = {};
      if (request.body.latitude != null) statusUpdate.latitude = Number(request.body.latitude);
      if (request.body.longitude != null) statusUpdate.longitude = Number(request.body.longitude);
      if (request.body.temperature_c != null) statusUpdate.temperature_c = Number(request.body.temperature_c);
      statusUpdate.last_seen_at = new Date();
      if (updatedStatus) {
        await updatedStatus.update(statusUpdate);
      } else {
        updatedStatus = await DeviceStatus.create({
          device_id: device.id,
          customer_id: device.customer_id,
          ...statusUpdate
        });
      }
    }
    
    if (updatedStatus) {
      try {
        const fullStatus = updatedStatus.toJSON();
        fullStatus.connection_state = getConnectionState(fullStatus.last_seen_at);
        broadcastRealtimeEvent("device_status_update", {
          ...fullStatus,
          device_id: device.device_id,
          devices: {
            device_id: device.device_id,
            name: device.name,
          }
        });
      } catch (err) {
        console.error("Broadcast error in updateDevice:", err);
      }
    }

    reply.status(200).send(device);
  } catch (error) {
    console.error("Update device error:", error);
    reply.status(400).send({ error: error.message || "Failed to update device" });
  }
};

export const deleteDevice = async (request, reply) => {
  try {
    const isUUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(request.params.id);
    let device;
    if (isUUID) {
      device = await Device.findByPk(request.params.id);
    } else {
      device = await Device.findOne({
        where: sequelize.where(sequelize.fn('LOWER', sequelize.col('device_id')), String(request.params.id).toLowerCase())
      });
    }

    if (!device) {
      reply.status(404).send({ error: "Device not found" });
      return;
    }

    const devUuid = device.id;
    const devCode = device.device_id;

    // 1. Delete associated PostgreSQL records
    await DeviceStatus.destroy({ where: { device_id: devUuid } });
    await Alarm.destroy({ where: { device_id: devUuid } });

    // 2. Multi-Endpoint & Multi-Predicate InfluxDB Telemetry Purge
    await purgeInfluxTelemetry(devCode, devUuid);

    // 3. Delete Device record
    await device.destroy();

    reply.status(200).send({ message: "Device and telemetry data deleted successfully" });
  } catch (error) {
    console.error("Delete device error:", error);
    reply.status(400).send({ error: error.message || "Failed to delete device" });
  }
};

async function purgeInfluxTelemetry(deviceCode, deviceUuid) {
  const candidateUrls = [
    process.env.INFLUX_URL,
    "http://influxdb:8086",
    "http://localhost:8086",
    "http://127.0.0.1:8086"
  ].filter(Boolean);

  const uniqueUrls = [...new Set(candidateUrls)];
  const influxToken = process.env.INFLUX_TOKEN || "techavo-secret-admin-token-2026-xyz";
  const influxOrg = process.env.INFLUX_ORG || "techavo";
  const influxBucket = process.env.INFLUX_BUCKET || "telemetry";

  const start = "1970-01-01T00:00:00Z";
  const stop = new Date(Date.now() + 86400000).toISOString();

  const predicates = [
    `device_id="${deviceCode}"`,
    `_measurement="telemetry" AND device_id="${deviceCode}"`
  ];
  if (deviceUuid && deviceUuid !== deviceCode) {
    predicates.push(`device_id="${deviceUuid}"`);
    predicates.push(`_measurement="telemetry" AND device_id="${deviceUuid}"`);
  }

  for (const baseUrl of uniqueUrls) {
    for (const pred of predicates) {
      try {
        const deleteUrl = `${baseUrl.replace(/\/$/, "")}/api/v2/delete?org=${encodeURIComponent(influxOrg)}&bucket=${encodeURIComponent(influxBucket)}`;
        const res = await fetch(deleteUrl, {
          method: "POST",
          headers: {
            "Authorization": `Token ${influxToken}`,
            "Content-Type": "application/json"
          },
          body: JSON.stringify({
            start,
            stop,
            predicate: pred
          })
        });
        if (res.ok || res.status === 204) {
          console.log(`[InfluxDB] Purged telemetry via ${baseUrl} using predicate '${pred}' (Status: ${res.status})`);
        } else {
          const text = await res.text().catch(() => "");
          console.warn(`[InfluxDB] Delete request to ${baseUrl} with predicate '${pred}' returned status ${res.status}: ${text}`);
        }
      } catch (err) {
        // Continue trying next candidate URL
      }
    }
  }
}

// GET device status
export const getDeviceStatus = async (request, reply) => {
  try {
    const isUUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(request.params.id);
    let status = null;
    if (isUUID) {
      status = await DeviceStatus.findOne({ where: { device_id: request.params.id } });
    } else {
      const dev = await Device.findOne({ where: { device_id: request.params.id } });
      if (dev) {
        status = await DeviceStatus.findOne({ where: { device_id: dev.id } });
      }
    }

    if (!status) {
      reply.status(404).send({ error: "Status not found" });
      return;
    }
    const raw = status.toJSON();
    raw.connection_state = getConnectionState(raw.last_seen_at);
    reply.status(200).send(raw);
  } catch (error) {
    console.error("Get device status error:", error);
    reply.status(500).send({ error: "Failed to get device status" });
  }
};

export const getDeviceStatuses = async (request, reply) => {
  try {
    const ids = request.query.ids ? request.query.ids.split(",") : [];
    const where = {};
    if (ids.length > 0) {
      where.device_id = { [Op.in]: ids };
    }

    const statuses = await DeviceStatus.findAll({
      where,
      include: [
        {
          model: Device,
          include: [
            { model: Asset },
            { model: Site }
          ]
        }
      ]
    });

    const formatted = statuses.map((status) => {
      const raw = status.toJSON();
      const connection_state = getConnectionState(raw.last_seen_at);
      const latitude = raw.latitude != null ? raw.latitude : (raw.Device?.Site?.latitude ?? 28.5355);
      const longitude = raw.longitude != null ? raw.longitude : (raw.Device?.Site?.longitude ?? 77.2910);
      return {
        ...raw,
        latitude,
        longitude,
        connection_state,
        devices: raw.Device ? {
          device_id: raw.Device.device_id,
          name: raw.Device.name,
          sites: raw.Device.Site ? {
            name: raw.Device.Site.name,
            latitude: raw.Device.Site.latitude,
            longitude: raw.Device.Site.longitude
          } : null,
          assets: raw.Device.Asset ? {
            name: raw.Device.Asset.name,
            vehicle_number: raw.Device.Asset.vehicle_number
          } : null
        } : null
      };
    });

    reply.status(200).send(formatted);
  } catch (error) {
    console.error("Get device statuses error:", error);
    reply.status(500).send({ error: "Failed to get device statuses" });
  }
};

// GET telemetry history
export const getTelemetry = async (request, reply) => {
  try {
    const { device_id, limit = 120, start_date, end_date } = request.query;

    let deviceFilter = "";
    let deviceMap = new Map();

    let targetDevice = null;

    if (device_id) {
      const isUUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(device_id);
      if (isUUID) {
        targetDevice = await Device.findByPk(device_id);
      } else {
        targetDevice = await Device.findOne({
          where: sequelize.where(sequelize.fn('LOWER', sequelize.col('device_id')), String(device_id).toLowerCase())
        });
      }

      if (targetDevice) {
        const lowerCode = String(targetDevice.device_id).toLowerCase();
        deviceFilter = `|> filter(fn: (r) => r["device_id"] == "${targetDevice.device_id}" or r["device_id"] == "${targetDevice.id}" or r["device_id"] == "${device_id}" or r["device_id"] == "${lowerCode}")`;
        deviceMap.set(targetDevice.device_id, targetDevice.id);
        deviceMap.set(lowerCode, targetDevice.id);
        deviceMap.set(targetDevice.id, targetDevice.id);
      } else {
        deviceFilter = `|> filter(fn: (r) => r["device_id"] == "${device_id}")`;
      }
    } else {
      const allDevs = await Device.findAll();
      for (const d of allDevs) {
        deviceMap.set(d.device_id, d.id);
        deviceMap.set(String(d.device_id).toLowerCase(), d.id);
        deviceMap.set(d.id, d.id);
      }
    }

    const end = end_date ? new Date(end_date) : new Date();
    let start = start_date ? new Date(start_date) : new Date(end.getTime() - 24 * 3600 * 1000);

    // Bound telemetry query start time to target device creation timestamp to avoid showing old report data from deleted instances
    if (targetDevice && targetDevice.createdAt) {
      const createdTime = new Date(targetDevice.createdAt);
      if (!isNaN(createdTime.getTime()) && createdTime > start) {
        start = createdTime;
      }
    }

    const queryLimit = (start_date || end_date) ? 5000 : parseInt(limit);

    const query = `
      from(bucket: "${bucket}")
        |> range(start: ${start.toISOString()}, stop: ${end.toISOString()})
        |> filter(fn: (r) => r["_measurement"] == "telemetry")
        ${deviceFilter}
        |> drop(columns: ["backup_record"])
        |> pivot(rowKey:["_time", "device_id"], columnKey: ["_field"], valueColumn: "_value")
        |> keep(columns: ["_time", "device_id", "temperature", "latitude", "longitude", "speed", "course", "valid", "backup_record", "backup_sequence", "csq", "roaming", "fault_code", "sending_time"])
        |> sort(columns: ["_time"], desc: false)
        |> limit(n: ${queryLimit})
    `;

    const rows = [];
    try {
      await new Promise((resolve) => {
        queryApi.queryRows(query, {
          next(row, tableMeta) {
            const o = tableMeta.toObject(row);
            const tempVal = o.temperature != null ? Number(o.temperature) : null;
            rows.push({
              ts: o._time,
              data_time: o._time,
              sending_time: o.sending_time || o._time,
              received_at: o.sending_time || o._time,
              device_id: deviceMap.get(o.device_id) || o.device_id,
              device_code: o.device_id,
              temperature_c: tempVal,
              latitude: o.latitude != null ? Number(o.latitude) : null,
              longitude: o.longitude != null ? Number(o.longitude) : null,
              speed_knots: o.speed != null ? Number(o.speed) : 0.0,
              course_deg: o.course != null ? Number(o.course) : 0.0,
              valid: o.valid,
              backup_record: o.backup_record === true || o.backup_record === "true",
              backup_sequence: o.backup_sequence != null ? Number(o.backup_sequence) : null,
              csq: o.csq != null ? Number(o.csq) : null,
              roaming: o.roaming === true || o.roaming === "true",
              fault_code: o.fault_code != null ? Number(o.fault_code) : 0,
            });
          },
          error(err) {
            console.warn("InfluxDB query error:", err.message);
            resolve();
          },
          complete() {
            resolve();
          }
        });
      });
    } catch (e) {
      console.warn("Influx query warning:", e.message);
    }

    reply.status(200).send(rows);
  } catch (error) {
    console.error("Get telemetry error:", error);
    reply.status(500).send({ error: "Failed to get telemetry" });
  }
};

// CRUD: Alarms
export const getAlarms = async (request, reply) => {
  try {
    const { device_id } = request.query;
    const where = {};
    if (device_id) {
      const isUUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(device_id);
      if (isUUID) {
        where.device_id = device_id;
      } else {
        const dev = await Device.findOne({
          where: sequelize.where(sequelize.fn('LOWER', sequelize.col('device_id')), String(device_id).toLowerCase())
        });
        if (dev) {
          where.device_id = dev.id;
        } else {
          where.device_id = device_id;
        }
      }
    }

    const alarms = await Alarm.findAll({
      where,
      include: [
        { model: Device, attributes: ["id", "device_id", "name"] },
        { model: Customer, attributes: ["id", "name"] }
      ],
      order: [["last_occurred_at", "DESC"]]
    });

    const formattedAlarms = alarms.map((alarm) => {
      const raw = alarm.toJSON();
      raw.device_code = raw.Device?.device_id || raw.device_id;
      raw.devices = {
        id: raw.Device?.id || raw.device_id,
        device_id: raw.Device?.device_id || raw.device_id,
        name: raw.Device?.name || "Device"
      };
      return raw;
    });

    reply.status(200).send(formattedAlarms);
  } catch (error) {
    console.error("Get alarms error:", error);
    reply.status(500).send({ error: "Failed to get alarms" });
  }
};

export const updateAlarm = async (request, reply) => {
  try {
    const alarm = await Alarm.findByPk(request.params.id);
    if (!alarm) {
      reply.status(404).send({ error: "Alarm not found" });
      return;
    }
    await alarm.update(request.body);
    reply.status(200).send(alarm);
  } catch (error) {
    reply.status(500).send({ error: "Failed to update alarm" });
  }
};

// CRUD: Sites
export const getSites = async (request, reply) => {
  try {
    const sites = await Site.findAll({ order: [["name", "ASC"]] });
    reply.status(200).send(sites);
  } catch (error) {
    reply.status(500).send({ error: "Failed to get sites" });
  }
};

export const createSite = async (request, reply) => {
  try {
    const site = await Site.create(request.body);
    reply.status(201).send(site);
  } catch (error) {
    console.error("Create site error:", error);
    const msg = error.name === "SequelizeUniqueConstraintError"
      ? `A site named '${request.body.name}' already exists for this customer`
      : error.message || "Failed to create site";
    reply.status(400).send({ error: msg });
  }
};

export const updateSite = async (request, reply) => {
  try {
    const site = await Site.findByPk(request.params.id);
    if (!site) {
      reply.status(404).send({ error: "Site not found" });
      return;
    }
    await site.update(request.body);
    reply.status(200).send(site);
  } catch (error) {
    console.error("Update site error:", error);
    reply.status(400).send({ error: error.message || "Failed to update site" });
  }
};

export const deleteSite = async (request, reply) => {
  try {
    const site = await Site.findByPk(request.params.id);
    if (!site) {
      reply.status(404).send({ error: "Site not found" });
      return;
    }
    // Nullify site reference on devices before deleting to avoid FK constraint errors
    await Device.update({ site_id: null }, { where: { site_id: site.id } });
    await site.destroy();
    reply.status(200).send({ message: "Site deleted successfully" });
  } catch (error) {
    console.error("Delete site error:", error);
    reply.status(400).send({ error: error.message || "Failed to delete site" });
  }
};

// CRUD: Assets
export const getAssets = async (request, reply) => {
  try {
    const assets = await Asset.findAll({ order: [["name", "ASC"]] });
    reply.status(200).send(assets);
  } catch (error) {
    reply.status(500).send({ error: "Failed to get assets" });
  }
};

export const createAsset = async (request, reply) => {
  try {
    const asset = await Asset.create(request.body);
    reply.status(201).send(asset);
  } catch (error) {
    console.error("Create asset error:", error);
    const msg = error.name === "SequelizeUniqueConstraintError"
      ? `An asset named '${request.body.name}' already exists for this customer`
      : error.message || "Failed to create asset";
    reply.status(400).send({ error: msg });
  }
};

export const updateAsset = async (request, reply) => {
  try {
    const asset = await Asset.findByPk(request.params.id);
    if (!asset) {
      reply.status(404).send({ error: "Asset not found" });
      return;
    }
    await asset.update(request.body);
    reply.status(200).send(asset);
  } catch (error) {
    console.error("Update asset error:", error);
    reply.status(400).send({ error: error.message || "Failed to update asset" });
  }
};

export const deleteAsset = async (request, reply) => {
  try {
    const asset = await Asset.findByPk(request.params.id);
    if (!asset) {
      reply.status(404).send({ error: "Asset not found" });
      return;
    }
    // Nullify asset reference on devices before deleting to avoid FK constraint errors
    await Device.update({ asset_id: null }, { where: { asset_id: asset.id } });
    await asset.destroy();
    reply.status(200).send({ message: "Asset deleted successfully" });
  } catch (error) {
    console.error("Delete asset error:", error);
    reply.status(400).send({ error: error.message || "Failed to delete asset" });
  }
};

// CRUD: Customers
export const getCustomers = async (request, reply) => {
  try {
    const customers = await Customer.findAll({ order: [["name", "ASC"]] });
    reply.status(200).send(customers);
  } catch (error) {
    reply.status(500).send({ error: "Failed to get customers" });
  }
};

export const getCustomerById = async (request, reply) => {
  try {
    const customer = await Customer.findByPk(request.params.id);
    if (!customer) {
      reply.status(404).send({ error: "Customer not found" });
      return;
    }
    reply.status(200).send(customer);
  } catch (error) {
    console.error("Get customer error:", error);
    reply.status(500).send({ error: "Failed to get customer" });
  }
};

export const createCustomer = async (request, reply) => {
  try {
    const customer = await Customer.create(request.body);
    reply.status(201).send(customer);
  } catch (error) {
    console.error("Create customer error:", error);
    reply.status(400).send({ error: error.message || "Failed to create customer" });
  }
};

export const updateCustomer = async (request, reply) => {
  try {
    const customer = await Customer.findByPk(request.params.id);
    if (!customer) {
      reply.status(404).send({ error: "Customer not found" });
      return;
    }
    await customer.update(request.body);
    reply.status(200).send(customer);
  } catch (error) {
    console.error("Update customer error:", error);
    reply.status(400).send({ error: error.message || "Failed to update customer" });
  }
};

export const deleteCustomer = async (request, reply) => {
  try {
    const customer = await Customer.findByPk(request.params.id);
    if (!customer) {
      reply.status(404).send({ error: "Customer not found" });
      return;
    }
    // Unassign customer_id references on child entities before deleting customer so only single record is deleted
    await Device.update({ customer_id: null }, { where: { customer_id: customer.id } });
    await Site.update({ customer_id: null }, { where: { customer_id: customer.id } });
    await Asset.update({ customer_id: null }, { where: { customer_id: customer.id } });
    await Alarm.update({ customer_id: null }, { where: { customer_id: customer.id } });

    await customer.destroy();
    reply.status(200).send({ message: "Customer deleted successfully" });
  } catch (error) {
    console.error("Delete customer error:", error);
    reply.status(400).send({ error: error.message || "Failed to delete customer" });
  }
};

// GET roles
export const getUserRoles = async (request, reply) => {
  try {
    const roles = await UserRole.findAll({ where: { user_id: request.user.id } });
    reply.status(200).send(roles);
  } catch (error) {
    reply.status(500).send({ error: "Failed to get roles" });
  }
};

// Profiles Endpoints
export const getProfiles = async (request, reply) => {
  try {
    const users = await User.findAll({
      attributes: ["id", "email", "full_name", "phone", "active", "last_login_at", "createdAt", "updatedAt"],
      order: [["email", "ASC"]]
    });
    reply.status(200).send(users);
  } catch (error) {
    reply.status(500).send({ error: "Failed to get profiles" });
  }
};

export const getProfileById = async (request, reply) => {
  try {
    const user = await User.findByPk(request.params.id, {
      attributes: ["id", "email", "full_name", "phone", "active", "last_login_at", "createdAt", "updatedAt"]
    });
    if (!user) {
      reply.status(404).send({ error: "Profile not found" });
      return;
    }
    reply.status(200).send(user);
  } catch (error) {
    reply.status(500).send({ error: "Failed to get profile" });
  }
};

export const updateProfile = async (request, reply) => {
  try {
    const user = await User.findByPk(request.params.id);
    if (!user) {
      reply.status(404).send({ error: "Profile not found" });
      return;
    }
    const { full_name, phone, active } = request.body;
    await user.update({
      full_name: full_name !== undefined ? full_name : user.full_name,
      phone: phone !== undefined ? phone : user.phone,
      active: active !== undefined ? active : user.active,
    });
    reply.status(200).send({
      id: user.id,
      email: user.email,
      full_name: user.full_name,
      phone: user.phone,
      active: user.active,
      last_login_at: user.last_login_at
    });
  } catch (error) {
    reply.status(500).send({ error: "Failed to update profile" });
  }
};

export const deleteProfile = async (request, reply) => {
  try {
    const user = await User.findByPk(request.params.id);
    if (!user) {
      reply.status(404).send({ error: "Profile not found" });
      return;
    }
    await user.update({ active: false });
    reply.status(200).send({ message: "Profile deactivated successfully" });
  } catch (error) {
    reply.status(500).send({ error: "Failed to delete profile" });
  }
};

// User Roles Endpoints
export const getUserRolesAll = async (request, reply) => {
  try {
    const { user_id } = request.query;
    const where = {};
    if (user_id) {
      where.user_id = user_id;
    }
    const roles = await UserRole.findAll({
      where,
      include: [{ model: Customer, attributes: ["name"] }]
    });
    reply.status(200).send(roles);
  } catch (error) {
    console.error("getUserRolesAll Error:", error);
    reply.status(500).send({ error: "Failed to get user roles" });
  }
};

export const createUserRole = async (request, reply) => {
  try {
    const { user_id, role, customer_id } = request.body;
    if (!user_id || !role) {
      reply.status(400).send({ error: "user_id and role are required" });
      return;
    }
    const scoped = role !== "super_admin";
    const userRole = await UserRole.create({
      user_id,
      role,
      customer_id: scoped && customer_id ? customer_id : null
    });
    
    const fetched = await UserRole.findByPk(userRole.id, {
      include: [{ model: Customer, attributes: ["name"] }]
    });
    
    reply.status(201).send(fetched);
  } catch (error) {
    console.error("createUserRole Error:", error);
    reply.status(500).send({ error: "Failed to grant role" });
  }
};

export const deleteUserRole = async (request, reply) => {
  try {
    const userRole = await UserRole.findByPk(request.params.id);
    if (!userRole) {
      reply.status(404).send({ error: "Role not found" });
      return;
    }
    await userRole.destroy();
    reply.status(200).send({ message: "Role revoked successfully" });
  } catch (error) {
    reply.status(500).send({ error: "Failed to revoke role" });
  }
};

export const seedDemo = async (request, reply) => {
  reply.status(200).send({ seeded: false, message: "Database seeding is disabled." });
};

// CRUD: NotificationRules
export const getNotificationRules = async (request, reply) => {
  try {
    const rules = await NotificationRule.findAll({
      include: [{ model: Customer, attributes: ["name"] }],
      order: [["created_at", "DESC"]],
    });
    reply.status(200).send(rules);
  } catch (error) {
    console.error("Get notification rules error:", error);
    reply.status(500).send({ error: "Failed to get notification rules" });
  }
};

export const createNotificationRule = async (request, reply) => {
  try {
    const rule = await NotificationRule.create(request.body);
    const fetched = await NotificationRule.findByPk(rule.id, {
      include: [{ model: Customer, attributes: ["name"] }],
    });
    reply.status(201).send(fetched);
  } catch (error) {
    console.error("Create notification rule error:", error);
    reply.status(400).send({ error: error.message || "Failed to create notification rule" });
  }
};

export const updateNotificationRule = async (request, reply) => {
  try {
    const rule = await NotificationRule.findByPk(request.params.id);
    if (!rule) {
      reply.status(404).send({ error: "Notification rule not found" });
      return;
    }
    await rule.update(request.body);
    const fetched = await NotificationRule.findByPk(rule.id, {
      include: [{ model: Customer, attributes: ["name"] }],
    });
    reply.status(200).send(fetched);
  } catch (error) {
    console.error("Update notification rule error:", error);
    reply.status(400).send({ error: error.message || "Failed to update notification rule" });
  }
};

export const deleteNotificationRule = async (request, reply) => {
  try {
    const rule = await NotificationRule.findByPk(request.params.id);
    if (!rule) {
      reply.status(404).send({ error: "Notification rule not found" });
      return;
    }
    await rule.destroy();
    reply.status(200).send({ message: "Notification rule deleted successfully" });
  } catch (error) {
    console.error("Delete notification rule error:", error);
    reply.status(500).send({ error: "Failed to delete notification rule" });
  }
};
